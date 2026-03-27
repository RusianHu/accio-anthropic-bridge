# Accio Anthropic Bridge

一个最小可用的本地代理，把 Anthropic `POST /v1/messages` 请求桥接到 Accio 的本地网关。

当前实现目标不是完整复刻 Anthropic API，而是先把最核心的链路跑通，让 Claude Code 之类依赖 Anthropic Messages API 的客户端有一个可接入入口。

## 已验证的 Accio 链路

这个项目依赖的不是云端模型 API，而是 Accio 桌面端已经暴露在本机的两个入口：

- HTTP 网关：`http://127.0.0.1:4097`
- WebSocket 网关：`ws://127.0.0.1:4097/websocket/connect?clientId=...`

桥接过程中已经验证过的关键事实：

1. 外部进程可以直接访问 `127.0.0.1:4097`
2. 外部进程可以直接建立 `/websocket/connect` WebSocket 连接
3. 外部进程可以发送 `sendQuery`
4. Accio 会返回完整事件流：
   - `ack`
   - `event.append`
   - `event.finished`
   - `channel.message.created`
5. 请求和回复会落盘到 Accio 自己的 conversation/message 存储里

也就是说，这条桥接路线的核心已经成立。

## 代理原理

### 1. 为什么同时需要 HTTP 和 WebSocket

Accio 的本地能力分成两类：

- HTTP 负责查询和创建资源
  - `/auth/status`
  - `/conversation`
  - `/message/paginated`
- WebSocket 负责真正触发模型侧执行
  - `sendQuery`
  - `ack/append/finished`

单独调用 `POST /message` 只会写消息，不会触发 Agent 推理。

真正的工作入口是 WebSocket 上的 `sendQuery`。

### 2. 这个代理怎么把 Anthropic 请求转成 Accio 请求

收到 Anthropic `POST /v1/messages` 后，代理会做这几步：

1. 把 `system + messages[]` 压平成一个纯文本 prompt
2. 调 `POST /conversation` 创建一个新的临时 DM 对话
3. 连接 `ws://127.0.0.1:4097/websocket/connect?clientId=...`
4. 发送：

```json
{
  "type": "req",
  "method": "sendQuery",
  "params": {
    "conversationId": "CID-...",
    "chatType": "direct",
    "question": {
      "query": "flattened prompt"
    },
    "agentId": "DID-...",
    "targetAgentList": [
      {
        "agentId": "DID-...",
        "isTL": true
      }
    ],
    "source": {
      "platform": "pcApp",
      "type": "im",
      "channelId": "weixin",
      "chatId": "...",
      "userId": "...",
      "chatType": "private"
    }
  }
}
```

5. 等待 Accio 返回 `append/finished`
6. 再转换成 Anthropic 格式返回给调用方

### 3. 为什么每次请求都会新建 conversation

这是当前版本刻意做的取舍。

原因：

- 最小实现更稳，不需要维护额外的 conversation 映射表
- 并发请求更容易隔离
- 不会把多个外部调用的事件流混在一起
- Claude/Anthropic Messages API 本身就是“客户端上送完整上下文”，所以新建对话不会丢语义

后续如果要做成长期可用代理，可以增加会话复用和 conversation 映射。

## 当前支持范围

### 已支持

- `POST /v1/messages`
- `POST /v1/messages/count_tokens`
- 非流式返回
- 流式 SSE 返回
- Accio 的 429/配额错误透传

### 当前限制

- 不是完整 Anthropic API 实现
- 不支持 tool use / tool result 的完整双向映射
- 不支持图片真正上传到 Accio，只会在 prompt 里写成占位文本
- 当前默认 source/agentId 使用的是本机已验证过的 Accio 环境配置
- 如果 Accio 自己额度耗尽，代理也只能返回对应错误

## 目录结构

```text
accio-anthropic-bridge/
  package.json
  .env.example
  src/
    accio-client.js
    anthropic.js
    server.js
```

## 运行方式

### 1. 启动代理

```bash
cd /Users/snow/accio-anthropic-bridge
node src/server.js
```

默认监听：

```text
http://127.0.0.1:8082
```

### 2. 健康检查

```bash
curl http://127.0.0.1:8082/healthz
```

### 3. 调用 `/v1/messages`

```bash
curl http://127.0.0.1:8082/v1/messages \
  -H 'content-type: application/json' \
  -d '{
    "model": "accio-bridge",
    "max_tokens": 1024,
    "messages": [
      {
        "role": "user",
        "content": "请只回复 OK"
      }
    ]
  }'
```

## 给 Claude Code 的接入思路

如果 Claude Code 支持把 Anthropic Base URL 指向本地服务，那么可以让它直接请求这个代理：

```text
Claude Code -> http://127.0.0.1:8082/v1/messages -> Accio local gateway
```

真正是否能和 Claude Code 无缝协作，还取决于它实际调用的 Anthropic API 子集是否超出了当前实现范围。

当前这个仓库解决的是最核心的问题：

- Accio 是否真的存在可被外部进程复用的收发入口
- 外部代理是否能把请求送进去并拿回完整回复

这两点都已经被验证。

## 关键实现文件

- [src/server.js](/Users/snow/accio-anthropic-bridge/src/server.js)
  - HTTP 入口
  - Anthropic 路由
  - SSE 输出
- [src/accio-client.js](/Users/snow/accio-anthropic-bridge/src/accio-client.js)
  - Accio HTTP/WS 客户端
  - `POST /conversation`
  - `sendQuery`
  - `ack/append/finished` 收集
- [src/anthropic.js](/Users/snow/accio-anthropic-bridge/src/anthropic.js)
  - Anthropic 请求压平
  - 返回格式转换

## 后续可扩展点

1. 增加会话复用，而不是每次新建 conversation
2. 增加 tool use / tool result 映射
3. 增加 OpenAI 兼容接口
4. 增加更细的错误分类和 retry 策略
5. 自动发现可用 agent/source，而不是使用固定环境值
