# Accio Anthropic Bridge — 优化方案

> 基于 `bf6c5ef` (2026-03-27) 全量代码审查，共 3,767 行源码（10 个模块 + 1 个脚本）。

---

## 一、安全与健壮性

### 1.1 请求体大小无限制（严重）

**现状**：`server.js` 的 `readJsonBody()` 直接拼接所有 chunk，没有任何 body size 校验。

```js
// server.js:68-82
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    // …无大小检查
  });
}
```

**风险**：恶意客户端发送超大请求体可耗尽进程内存。

**建议**：

```js
const MAX_BODY_BYTES = 10 * 1024 * 1024; // 10 MB

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;

    req.on("data", (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes`));
        return;
      }
      chunks.push(chunk);
    });
    // …
  });
}
```

### 1.2 Token 泄露风险（中等）

**现状**：`direct-llm.js:626-629` 将 `accessToken` 直接嵌入 POST body。当请求失败时，`res.text()` 的内容可能包含 token 并被抛入错误堆栈。

```js
// direct-llm.js:626-629
const upstreamBody = {
  ...request.requestBody,
  token
};
```

**建议**：
- 错误消息中对 `token` 字段做脱敏（只保留前 8 位 + `***`）
- 未来如果加结构化日志，token 字段必须从日志输出中过滤

### 1.3 Auth Token 无缓存（中等）

**现状**：`DirectLlmClient.getAuthToken()` 每次请求都调 `/debug/auth/ws-status`，高频场景下产生不必要的本地网关压力。

**建议**：加简单的内存缓存（TTL 2-5 分钟），token 失败时清缓存重取。

```js
class DirectLlmClient {
  constructor(config) {
    this.config = config;
    this._cachedToken = null;
    this._cachedAt = 0;
    this._cacheTtlMs = 2 * 60 * 1000; // 2 min
  }

  async getAuthToken() {
    if (this._cachedToken && Date.now() - this._cachedAt < this._cacheTtlMs) {
      return this._cachedToken;
    }
    // …原有逻辑
    this._cachedToken = token;
    this._cachedAt = Date.now();
    return token;
  }
}
```

### 1.4 空 `catch {}` 静默吞错（低）

**现状**：全项目约 15+ 处 `catch {}`，尤其在 `discovery.js`、`accio-client.js`、`session-store.js` 中。

**风险**：配置错误、文件权限问题等被完全隐藏，排障困难。

**建议**：至少加 debug 级日志或注释说明为何忽略。

---

## 二、性能

### 2.1 同步文件 IO 阻塞 Event Loop（严重）

**现状**：请求处理热路径上大量同步操作：

| 文件 | 方法 | 同步调用 |
|------|------|---------|
| `accio-client.js:119` | `getConversationLogDirectories()` | `readdirSync` |
| `accio-client.js:146-155` | `readConversationMessages()` | `readdirSync` + `readFileSync` |
| `session-store.js:27-28` | `save()` | `mkdirSync` + `writeFileSync` |

**影响**：并发请求时，一个请求的文件读写会阻塞所有其他请求。

**建议**：
- `collectConversationArtifacts` 全链路改用 `fs.promises`
- `SessionStore.save()` 改为异步写入 + debounce（合并高频写入）

### 2.2 `estimateTokens()` 对 CJK 严重低估（低）

**现状**：`Math.ceil(text.length / 4)` 假设平均 4 字符 = 1 token，但中文/日文每字符约 1-2 token。

```js
// anthropic.js:119-125
function estimateTokens(text) {
  return Math.max(1, Math.ceil(String(text).length / 4));
}
```

**建议**：

```js
function estimateTokens(text) {
  if (!text) return 0;
  const str = String(text);
  let tokens = 0;
  for (const char of str) {
    tokens += char.charCodeAt(0) > 0x7f ? 1.5 : 0.25;
  }
  return Math.max(1, Math.ceil(tokens));
}
```

### 2.3 `createCorsHeaders()` 每次创建新对象（低）

**现状**：每个请求都调用 `createCorsHeaders()` 返回新对象，但内容是常量。

**建议**：改为模块级常量。

---

## 三、架构与可维护性

### 3.1 `server.js` 过于臃肿（1,185 行）

**现状**：所有路由、SSE 流式逻辑、direct/local-ws 两条链路、错误分类、健康检查全在一个文件里。

**建议拆分**：

```
src/
  server.js          → 路由注册 + 启动（~100 行）
  middleware/
    cors.js           → CORS 处理
    body-parser.js    → readJsonBody + 大小限制
  routes/
    health.js         → /healthz, /debug/accio-auth
    anthropic.js      → /v1/messages, /v1/messages/count_tokens
    openai.js         → /v1/chat/completions, /v1/models
  stream/
    anthropic-sse.js  → Anthropic SSE 写入逻辑
    openai-sse.js     → OpenAI SSE 写入逻辑
  errors.js           → classifyErrorType, resolveResultError, buildErrorResponse
```

### 3.2 重复的 SSE 写入逻辑

**现状**：以下代码模式在 `runDirectAnthropic`、`runDirectOpenAi`、`handleMessagesRequest`、`handleChatCompletionsRequest` 中反复出现：

- headers 写入（`res.writeHead(200, { ...createCorsHeaders(), ... })`）
- chunk 构建与写入
- tool_calls 序列化
- 流结束处理

**建议**：提取 `AnthropicStreamWriter` 和 `OpenAiStreamWriter` 类，封装 `start()` / `writeTextDelta()` / `writeToolCall()` / `end()` 方法。

### 3.3 `normalizeRequestedModel()` 重复定义

**现状**：

- `accio-client.js:25-37` — 用于 local-ws 链路
- `direct-llm.js:13-21` — 用于 direct-llm 链路

逻辑完全一致。

**建议**：提取到公共模块（如 `src/model.js`）。

### 3.4 `init-env.js` 与 `discovery.js` 大量重复

**现状**：两个文件分别实现了：

| 功能 | `init-env.js` | `discovery.js` |
|------|--------------|----------------|
| `exists()` | 第 23 行 | 第 9 行 |
| `readJsonIfExists()` | 第 32 行 | 第 18 行 |
| `listDirectories()` | 第 90 行 | 第 30 行 |
| `parseSessionKey()` | 第 101 行 | 第 71 行 |
| session 扫描 | `discoverSessionSource()` | `discoverSessionCandidates()` |

**建议**：`init-env.js` 直接复用 `discovery.js` 的导出函数，消除 ~80 行重复代码。

### 3.5 Node.js HTTP headers 已经是小写

**现状**：三处做了多余的 headers 小写化：

```js
// server.js:270, 311, 473
const headers = Object.fromEntries(
  Object.entries(req.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
);
```

Node.js 的 `http` 模块保证 `req.headers` 的 key 已经是小写的。这个转换完全多余，还额外创建了一个新对象。

**建议**：直接使用 `req.headers`。

---

## 四、功能缺失

### 4.1 Session 过期与清理

**现状**：`SessionStore` 只增不减。`sessions.json` 会随使用无限增长，没有任何淘汰机制。

**建议**：
- 加 `maxAge` 配置（默认 7 天）
- `load()` 和 `get()` 时检查 `updatedAt` 是否过期
- 定期（或懒加载时）清理过期条目

```js
get(sessionId) {
  const entry = this.state.sessions[sessionId];
  if (!entry) return null;
  if (Date.now() - Date.parse(entry.updatedAt) > this.maxAgeMs) {
    delete this.state.sessions[sessionId];
    return null;
  }
  return entry;
}
```

### 4.2 结构化日志

**现状**：全项目只有 `process.stdout.write` 和 `process.stderr.write`，没有时间戳、级别、request ID。

**建议**：引入轻量日志模块（不需要依赖第三方库），至少包含：

```js
function log(level, message, meta = {}) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta
  };
  process.stdout.write(JSON.stringify(entry) + "\n");
}
```

关键埋点：
- 请求进入（method, path, session_id）
- transport 选择（direct-llm / local-ws）
- 上游请求耗时
- 错误及重试
- 响应状态码

### 4.3 Graceful Shutdown

**现状**：没有 `SIGINT` / `SIGTERM` 处理。进程被杀时，正在处理的请求和 WebSocket 连接不会被正确关闭。

**建议**：

```js
function setupGracefulShutdown(server) {
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("info", "Shutting down...");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000); // 强制退出
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
```

### 4.4 请求级别超时

**现状**：`readJsonBody()` 没有读取超时。如果客户端只发 headers 不发 body，连接会一直挂着直到全局超时。

**建议**：为 body 读取加独立超时（如 30 秒）。

---

## 五、测试与工程化

### 5.1 零测试覆盖

**现状**：没有任何测试文件。

**建议优先补测试的模块**（纯转换逻辑，无 IO 依赖，最适合单测）：

| 模块 | 可测函数 |
|------|---------|
| `anthropic.js` | `normalizeSystemPrompt`, `normalizeContent`, `flattenAnthropicRequest`, `buildMessageResponse`, `extractAccioToolCalls` |
| `openai.js` | `flattenOpenAiRequest`, `buildChatCompletionResponse`, `buildChatCompletionChunk`, `buildOpenAiModelsResponse` |
| `direct-llm.js` | `buildDirectRequestFromAnthropic`, `buildDirectRequestFromOpenAi`, `mapRequestedModel`, `DirectResponseAccumulator` |
| `jsonc.js` | `stripJsonComments`, `parseJsonc` |
| `session-store.js` | `resolveSessionBinding` |

推荐框架：Node.js 内置 `node:test`（>=22 已内置，与 `package.json` 的 `engines` 一致），零依赖。

### 5.2 缺少 Linter / Formatter

**建议**：加 `eslint` + `prettier`，在 `package.json` 中配 `lint` 和 `format` script。

---

## 六、代码细节

### 6.1 `Date.now()` 作为 ID 不够唯一

**现状**：多处使用 `msg_${Date.now()}`、`chatcmpl_${Date.now()}` 作为响应 ID。并发场景下会冲突。

**建议**：统一用 `crypto.randomUUID()` 或至少加随机后缀：

```js
const id = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
```

### 6.2 Model Alias Map 硬编码

**现状**：`direct-llm.js:31-53` 的模型映射表写死在代码里。

**建议**：提取为 `config/model-aliases.json`，运行时加载。新增模型不需要改代码。

### 6.3 `bootstrap.js` 的 `.env` 解析器

**现状**：自己写了一个 `.env` 解析器（支持引号转义等）。

**考虑**：如果只是为了避免依赖 `dotenv`，当前实现是合理的。但缺少对多行值的支持和 `#` 行内注释处理。

---

## 实施优先级

| 阶段 | 优化项 | 工作量 | 影响 |
|------|--------|--------|------|
| **P0** | 请求体大小限制 | 小 | 安全 |
| **P0** | Token 缓存 | 小 | 性能 |
| **P0** | Token 脱敏 | 小 | 安全 |
| **P1** | 同步 IO 改异步 | 中 | 性能 |
| **P1** | Session 过期清理 | 小 | 稳定性 |
| **P1** | Graceful shutdown | 小 | 稳定性 |
| **P1** | 补充核心单元测试 | 中 | 质量 |
| **P2** | server.js 拆分 | 大 | 可维护性 |
| **P2** | SSE 写入逻辑去重 | 中 | 可维护性 |
| **P2** | 结构化日志 | 中 | 可观测性 |
| **P2** | 消除 init-env/discovery 重复 | 小 | 可维护性 |
| **P3** | estimateTokens 改进 | 小 | 准确性 |
| **P3** | Model alias 外部化 | 小 | 可维护性 |
| **P3** | Linter/Formatter | 小 | 代码质量 |
| **P3** | ID 唯一性 | 小 | 正确性 |
| **P3** | 移除多余的 headers toLowerCase | 小 | 代码整洁 |
