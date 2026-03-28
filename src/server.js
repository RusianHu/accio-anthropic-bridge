"use strict";

const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { AccioClient, HttpError } = require("./accio-client");
const { AuthProvider } = require("./auth-provider");
const { buildErrorResponse, flattenAnthropicRequest } = require("./anthropic");
const { DirectLlmClient } = require("./direct-llm");
const { discoverAccioAppPath, discoverAccioConfig } = require("./discovery");
const { classifyErrorType } = require("./errors");
const { GatewayManager, parseFlag } = require("./gateway-manager");
const { CORS_HEADERS, writeJson } = require("./http");
const log = require("./logger");
const { handleAccioAuthProbe, handleHealth } = require("./routes/health");
const { handleCountTokens, handleMessagesRequest } = require("./routes/anthropic");
const { buildOpenAiModelsResponse, handleChatCompletionsRequest } = require("./routes/openai");
const { SessionStore } = require("./session-store");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function createConfig() {
  const discovered = discoverAccioConfig({
    accountId: env("ACCIO_ACCOUNT_ID", ""),
    accioHome: env("ACCIO_HOME", ""),
    agentId: env("ACCIO_AGENT_ID", ""),
    language: env("ACCIO_LANGUAGE", ""),
    sourceChannelId: env("ACCIO_SOURCE_CHANNEL_ID", ""),
    sourceChatId: env("ACCIO_SOURCE_CHAT_ID", ""),
    sourceChatType: env("ACCIO_SOURCE_CHAT_TYPE", ""),
    sourceUserId: env("ACCIO_SOURCE_USER_ID", ""),
    workspacePath: env("ACCIO_WORKSPACE_PATH", "")
  });

  return {
    port: Number(env("PORT", "8082")),
    baseUrl: env("ACCIO_BASE_URL", "http://127.0.0.1:4097"),
    accioHome: discovered.accioHome,
    accountId: discovered.accountId,
    agentId: discovered.agentId,
    workspacePath: discovered.workspacePath,
    language: discovered.language,
    sourceChannelId: discovered.sourceChannelId,
    sourceChatId: discovered.sourceChatId,
    sourceUserId: discovered.sourceUserId,
    sourceChatType: discovered.sourceChatType,
    sourcePlatform: env("ACCIO_SOURCE_PLATFORM", "pcApp"),
    sourceType: env("ACCIO_SOURCE_TYPE", "im"),
    requestTimeoutMs: Number(env("ACCIO_REQUEST_TIMEOUT_MS", "120000")),
    transportMode: env("ACCIO_TRANSPORT", "auto"),
    authMode: env("ACCIO_AUTH_MODE", "auto"),
    authStrategy: env("ACCIO_AUTH_STRATEGY", "round_robin"),
    accountsPath: env("ACCIO_ACCOUNTS_PATH", path.join(process.cwd(), "config", "accounts.json")),
    accessToken: env("ACCIO_ACCESS_TOKEN", ""),
    envAccountId: env("ACCIO_AUTH_ACCOUNT_ID", "env-default"),
    accessTokenExpiresAt: env("ACCIO_ACCESS_TOKEN_EXPIRES_AT", ""),
    gatewayAutostart: parseFlag(env("ACCIO_GATEWAY_AUTOSTART", "1"), true),
    appPath: discoverAccioAppPath(env("ACCIO_APP_PATH", "")),
    gatewayWaitMs: Number(env("ACCIO_GATEWAY_WAIT_MS", "20000")),
    gatewayPollMs: Number(env("ACCIO_GATEWAY_POLL_MS", "500")),
    directLlmBaseUrl: env(
      "ACCIO_DIRECT_LLM_BASE_URL",
      "https://phoenix-gw.alibaba.com/api/adk/llm"
    ),
    clientIdPrefix: env("ACCIO_CLIENT_ID_PREFIX", "anthropic-bridge"),
    sessionStorePath: env(
      "ACCIO_SESSION_STORE_PATH",
      path.join(process.cwd(), ".data", "sessions.json")
    ),
    maxRetries: Number(env("ACCIO_MAX_RETRIES", "2")),
    retryBaseMs: Number(env("ACCIO_RETRY_BASE_MS", "250")),
    retryMaxDelayMs: Number(env("ACCIO_RETRY_MAX_DELAY_MS", "2500"))
  };
}

function createServer(client, directClient, sessionStore) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const startTime = Date.now();
    const requestId = String(req.headers["x-request-id"] || generateId("req"));

    res.setHeader("x-request-id", requestId);

    const requestMeta = {
      requestId,
      method: req.method,
      path: url.pathname
    };

    const finishLog = (level, message, meta = {}) => {
      log[level](message, {
        ...requestMeta,
        ms: Date.now() - startTime,
        ...meta
      });
    };

    try {
      finishLog("info", "request started");

      if (req.method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        finishLog("info", "request completed", { status: 204 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        writeJson(res, 200, {
          name: "accio-anthropic-bridge",
          ok: true,
          endpoints: [
            "GET /healthz",
            "GET /debug/accio-auth",
            "GET /v1/models",
            "POST /v1/messages",
            "POST /v1/messages/count_tokens",
            "POST /v1/chat/completions"
          ]
        });
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        await handleHealth(req, res, client, directClient, sessionStore);
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/debug/accio-auth") {
        await handleAccioAuthProbe(req, res, client, directClient);
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, buildOpenAiModelsResponse());
        finishLog("info", "request completed", { status: 200 });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessagesRequest(req, res, client, directClient, sessionStore);
        finishLog("info", "request completed", { status: 200, protocol: "anthropic" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        await handleCountTokens(req, res, flattenAnthropicRequest);
        finishLog("info", "request completed", { status: 200, protocol: "anthropic" });
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletionsRequest(req, res, client, directClient, sessionStore);
        finishLog("info", "request completed", { status: 200, protocol: "openai" });
        return;
      }

      writeJson(res, 404, buildErrorResponse(`No route for ${url.pathname}`));
      finishLog("warn", "request completed", { status: 404 });
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : Number(error && error.status) || 500;
      const message =
        error instanceof HttpError
          ? error.body && error.body.error
            ? error.body.error
            : error.message
          : error instanceof Error
            ? error.message
            : String(error);

      log.error("request failed", {
        ...requestMeta,
        status: statusCode,
        error: message,
        ms: Date.now() - startTime
      });

      writeJson(
        res,
        statusCode,
        buildErrorResponse(
          message,
          error && typeof error.type === "string"
            ? error.type
            : classifyErrorType(statusCode, error),
          error && error.details ? { details: error.details } : {}
        )
      );
    }
  });
}

async function main() {
  const config = createConfig();
  const client = new AccioClient(config);
  const authProvider = new AuthProvider(config);
  const gatewayManager = new GatewayManager({
    baseUrl: config.baseUrl,
    appPath: config.appPath,
    autostartEnabled: config.gatewayAutostart,
    waitMs: config.gatewayWaitMs,
    pollMs: config.gatewayPollMs
  });
  const directClient = new DirectLlmClient({
    authMode: config.authMode,
    authProvider,
    gatewayManager,
    localGatewayBaseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    upstreamBaseUrl: config.directLlmBaseUrl
  });
  const sessionStore = new SessionStore(config.sessionStorePath);
  const server = createServer(client, directClient, sessionStore);

  let shuttingDown = false;

  const shutdown = (signal) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    log.info("shutdown requested", { signal });
    sessionStore.flushSync();

    server.close(() => {
      log.info("server closed", { signal });
      process.exit(0);
    });

    setTimeout(() => {
      log.error("forced shutdown after timeout", { signal, timeoutMs: 5000 });
      process.exit(1);
    }, 5000).unref();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  server.listen(config.port, "127.0.0.1", () => {
    log.info("server listening", {
      port: config.port,
      url: `http://127.0.0.1:${config.port}`
    });
  });
}

main().catch((error) => {
  log.error("server bootstrap failed", {
    error: error instanceof Error ? error.stack : String(error)
  });
  process.exitCode = 1;
});
