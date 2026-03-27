"use strict";

const http = require("node:http");
const { URL } = require("node:url");

const { AccioClient, HttpError } = require("./accio-client");
const {
  buildErrorResponse,
  buildMessageResponse,
  estimateTokens,
  flattenAnthropicRequest
} = require("./anthropic");

function env(name, fallback) {
  return process.env[name] || fallback;
}

function createConfig() {
  return {
    port: Number(env("PORT", "8082")),
    baseUrl: env("ACCIO_BASE_URL", "http://127.0.0.1:4097"),
    agentId: env("ACCIO_AGENT_ID", "DID-F456DA-2B0D4C"),
    workspacePath: env(
      "ACCIO_WORKSPACE_PATH",
      "/Users/snow/.accio/accounts/7083340315/agents/DID-F456DA-2B0D4C/project"
    ),
    language: env("ACCIO_LANGUAGE", "zh"),
    sourceChannelId: env("ACCIO_SOURCE_CHANNEL_ID", "weixin"),
    sourceChatId: env(
      "ACCIO_SOURCE_CHAT_ID",
      "o9cq800Es1PQv0ZxNFPl9TkCilLc@im.wechat"
    ),
    sourceUserId: env(
      "ACCIO_SOURCE_USER_ID",
      "o9cq800Es1PQv0ZxNFPl9TkCilLc@im.wechat"
    ),
    sourceChatType: env("ACCIO_SOURCE_CHAT_TYPE", "private"),
    sourcePlatform: env("ACCIO_SOURCE_PLATFORM", "pcApp"),
    sourceType: env("ACCIO_SOURCE_TYPE", "im"),
    requestTimeoutMs: Number(env("ACCIO_REQUEST_TIMEOUT_MS", "120000")),
    clientIdPrefix: env("ACCIO_CLIENT_ID_PREFIX", "anthropic-bridge")
  };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text ? JSON.parse(text) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function writeJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function conversationTitleFromPrompt(prompt) {
  const normalized = String(prompt || "").replace(/\s+/g, " ").trim();
  return (normalized || "Bridge Request").slice(0, 48);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startAnthropicStream(res, body, inputTokens) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive"
  });

  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: `msg_${Date.now()}`,
      type: "message",
      role: "assistant",
      model: body.model || "accio-bridge",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: {
        input_tokens: inputTokens,
        output_tokens: 0
      }
    }
  });

  writeSse(res, "content_block_start", {
    type: "content_block_start",
    index: 0,
    content_block: {
      type: "text",
      text: ""
    }
  });
}

function endAnthropicStream(res, inputTokens, outputText) {
  writeSse(res, "content_block_stop", {
    type: "content_block_stop",
    index: 0
  });

  writeSse(res, "message_delta", {
    type: "message_delta",
    delta: {
      stop_reason: "end_turn",
      stop_sequence: null
    },
    usage: {
      output_tokens: estimateTokens(outputText)
    }
  });

  writeSse(res, "message_stop", {
    type: "message_stop",
    usage: {
      input_tokens: inputTokens,
      output_tokens: estimateTokens(outputText)
    }
  });

  res.end();
}

async function handleMessagesRequest(req, res, client) {
  const body = await readJsonBody(req);
  const prompt = flattenAnthropicRequest(body);
  const inputTokens = estimateTokens(prompt);
  const stream = body.stream === true;
  let streamStarted = false;

  const result = await client.executeQuery({
    model: body.model,
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "append") {
        if (!streamStarted) {
          startAnthropicStream(res, body, inputTokens);
          streamStarted = true;
        }

        if (event.delta) {
          writeSse(res, "content_block_delta", {
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "text_delta",
              text: event.delta
            }
          });
        }
      }
    },
    query: prompt,
    title: conversationTitleFromPrompt(prompt),
    workspacePath: client.config.workspacePath
  });

  const finalText =
    result.finalText ||
    (result.channelResponse && result.channelResponse.content) ||
    "";
  const metadata = (result.finalMessage && result.finalMessage.metadata) || {};
  const errorCode = metadata.errorCode;
  const errorMessage =
    (result.channelResponse && result.channelResponse.content) ||
    metadata.rawError ||
    finalText;

  if (stream) {
    if (!streamStarted) {
      if (errorCode) {
        writeJson(
          res,
          Number(errorCode),
          buildErrorResponse(errorMessage, "rate_limit_error")
        );
        return;
      }

      startAnthropicStream(res, body, inputTokens);
      streamStarted = true;

      if (finalText) {
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: finalText
          }
        });
      }
    }

    endAnthropicStream(res, inputTokens, finalText);
    return;
  }

  if (errorCode) {
    writeJson(
      res,
      Number(errorCode),
      buildErrorResponse(errorMessage, "rate_limit_error")
    );
    return;
  }

  writeJson(
    res,
    200,
    buildMessageResponse(body, finalText, {
      id: result.messageId || `msg_${Date.now()}`,
      inputTokens,
      outputTokens: estimateTokens(finalText)
    })
  );
}

async function handleCountTokens(req, res) {
  const body = await readJsonBody(req);
  const prompt = flattenAnthropicRequest(body);
  writeJson(res, 200, {
    input_tokens: estimateTokens(prompt)
  });
}

async function handleHealth(req, res, client) {
  const auth = await client.getAuthStatus();
  writeJson(res, 200, {
    ok: true,
    auth,
    config: {
      baseUrl: client.config.baseUrl,
      agentId: client.config.agentId,
      workspacePath: client.config.workspacePath,
      port: client.config.port
    }
  });
}

function createServer(client) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "GET" && url.pathname === "/") {
        writeJson(res, 200, {
          name: "accio-anthropic-bridge",
          ok: true,
          endpoints: [
            "GET /healthz",
            "POST /v1/messages",
            "POST /v1/messages/count_tokens"
          ]
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        await handleHealth(req, res, client);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessagesRequest(req, res, client);
        return;
      }

      if (
        req.method === "POST" &&
        url.pathname === "/v1/messages/count_tokens"
      ) {
        await handleCountTokens(req, res);
        return;
      }

      writeJson(res, 404, buildErrorResponse(`No route for ${url.pathname}`));
    } catch (error) {
      if (error instanceof HttpError) {
        writeJson(
          res,
          error.status,
          buildErrorResponse(
            error.body && error.body.error ? error.body.error : error.message
          )
        );
        return;
      }

      writeJson(
        res,
        500,
        buildErrorResponse(error instanceof Error ? error.message : String(error))
      );
    }
  });
}

async function main() {
  const config = createConfig();
  const client = new AccioClient(config);
  const server = createServer(client);

  server.listen(config.port, () => {
    console.log(
      `[accio-anthropic-bridge] listening on http://127.0.0.1:${config.port}`
    );
  });
}

main().catch((error) => {
  console.error("[accio-anthropic-bridge] fatal:", error);
  process.exit(1);
});
