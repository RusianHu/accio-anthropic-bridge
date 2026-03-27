"use strict";

const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { URL } = require("node:url");

const { AccioClient, HttpError } = require("./accio-client");
const { buildErrorResponse, buildMessageResponse, estimateTokens, extractAccioToolCalls, flattenAnthropicRequest } = require("./anthropic");
const {
  DirectLlmClient,
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi
} = require("./direct-llm");
const { discoverAccioConfig } = require("./discovery");
const { buildChatCompletionChunk, buildChatCompletionResponse, buildOpenAiModelsResponse, flattenOpenAiRequest } = require("./openai");
const { SessionStore, resolveSessionBinding } = require("./session-store");

function env(name, fallback) {
  return process.env[name] || fallback;
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

function createCorsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers":
      "content-type,authorization,x-api-key,anthropic-version,x-accio-session-id,x-accio-conversation-id,x-session-id",
    "access-control-allow-methods": "GET,POST,OPTIONS"
  };
}

function writeJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    ...createCorsHeaders(),
    ...extraHeaders,
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

function startAnthropicStream(res, body, inputTokens, extras = {}) {
  res.writeHead(200, {
    ...createCorsHeaders(),
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "content-type": "text/event-stream; charset=utf-8",
    "x-accio-conversation-id": extras.conversationId || "",
    "x-accio-session-id": extras.sessionId || ""
  });

  writeSse(res, "message_start", {
    type: "message_start",
    message: {
      id: extras.id || `msg_${Date.now()}`,
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

function sessionHeaders(extras = {}) {
  const headers = {};

  if (extras.conversationId) {
    headers["x-accio-conversation-id"] = extras.conversationId;
  }

  if (extras.sessionId) {
    headers["x-accio-session-id"] = extras.sessionId;
  }

  return headers;
}

function usagePromptTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }

  return Number(
    usage.promptTokenCount ||
      usage.prompt_token_count ||
      usage.input_tokens ||
      0
  );
}

function usageCompletionTokens(usage) {
  if (!usage || typeof usage !== "object") {
    return 0;
  }

  return Number(
    usage.candidatesTokenCount ||
      usage.candidates_token_count ||
      usage.output_tokens ||
      0
  );
}

function classifyErrorType(statusCode, error) {
  if (statusCode === 400 || statusCode === 422) {
    return "invalid_request_error";
  }

  if (statusCode === 401 || statusCode === 403) {
    return "authentication_error";
  }

  if (statusCode === 404) {
    return "not_found_error";
  }

  if (statusCode === 408) {
    return "timeout_error";
  }

  if (statusCode === 429) {
    return "rate_limit_error";
  }

  if (statusCode === 502 || statusCode === 503 || statusCode === 504 || statusCode === 529) {
    return "overloaded_error";
  }

  if (
    error &&
    /timed out|ECONNREFUSED|ECONNRESET|fetch failed|WebSocket closed/i.test(
      String(error.message || error)
    )
  ) {
    return "api_connection_error";
  }

  return "api_error";
}

function resolveResultError(result) {
  const metadata = (result.finalMessage && result.finalMessage.metadata) || {};

  return {
    errorCode: Number(metadata.errorCode || 0) || null,
    errorMessage:
      (result.channelResponse && result.channelResponse.content) ||
      metadata.rawError ||
      result.finalText ||
      "Unknown bridge error"
  };
}

async function executeBridgeQuery({ body, client, prompt, req, sessionStore, protocol, onEvent }) {
  const headers = Object.fromEntries(
    Object.entries(req.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const binding = resolveSessionBinding(headers, body, protocol);
  const storedSession = binding.sessionId ? sessionStore.get(binding.sessionId) : null;
  const conversationId = binding.conversationId || (storedSession && storedSession.conversationId);
  const result = await client.executeQuery({
    conversationId,
    model: body.model,
    onEvent,
    query: prompt,
    title: conversationTitleFromPrompt(prompt),
    workspacePath: client.config.workspacePath
  });

  if (binding.sessionId && result.conversationId) {
    sessionStore.set(binding.sessionId, result.conversationId, {
      protocol
    });
  }

  return {
    ...result,
    sessionId: binding.sessionId,
    toolCalls:
      (Array.isArray(result.toolCalls) && result.toolCalls.length > 0
        ? result.toolCalls
        : extractAccioToolCalls(result)),
    toolResults: result.toolResults || []
  };
}

async function shouldUseDirectTransport(client, directClient) {
  if (client.config.transportMode === "local-ws") {
    return false;
  }

  return directClient.isAvailable();
}

async function runDirectAnthropic(body, req, res, client, directClient, sessionStore) {
  const headers = Object.fromEntries(
    Object.entries(req.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const binding = resolveSessionBinding(headers, body, "anthropic");
  const request = buildDirectRequestFromAnthropic(body);
  const inputTokens = estimateTokens(flattenAnthropicRequest(body));
  const stream = body.stream === true;
  const streamId = `msg_${Date.now()}`;
  let wroteRawClaudeStream = false;
  let wroteSyntheticText = false;

  const result = await directClient.run(request, {
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "claude_raw") {
        if (!res.headersSent) {
          res.writeHead(200, {
            ...createCorsHeaders(),
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            ...sessionHeaders({ sessionId: binding.sessionId })
          });
        }

        wroteRawClaudeStream = true;
        writeSse(res, event.raw.type || "message", event.raw);
        return;
      }

      if (wroteRawClaudeStream) {
        return;
      }

      if (event.type === "text_delta" && event.text) {
        if (!res.headersSent) {
          startAnthropicStream(res, body, inputTokens, {
            id: streamId,
            sessionId: binding.sessionId
          });
        }

        wroteSyntheticText = true;
        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "text_delta",
            text: event.text
          }
        });
      }
    }
  });

  const promptTokens = usagePromptTokens(result.usage) || inputTokens;
  const completionTokens =
    usageCompletionTokens(result.usage) || estimateTokens(result.finalText);

  if (stream) {
    if (wroteRawClaudeStream) {
      if (!res.writableEnded) {
        res.end();
      }

      return;
    }

    if (!res.headersSent) {
      startAnthropicStream(res, body, promptTokens, {
        id: result.id || streamId,
        sessionId: binding.sessionId
      });
    }

    if (!wroteSyntheticText && result.finalText) {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: result.finalText
        }
      });
    }

    if (Array.isArray(result.toolCalls) && result.toolCalls.length > 0) {
      for (let index = 0; index < result.toolCalls.length; index += 1) {
        const toolCall = result.toolCalls[index];

        writeSse(res, "content_block_start", {
          type: "content_block_start",
          index,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.name,
            input: {}
          }
        });

        writeSse(res, "content_block_delta", {
          type: "content_block_delta",
          index,
          delta: {
            type: "input_json_delta",
            partial_json: JSON.stringify(toolCall.input || {})
          }
        });

        writeSse(res, "content_block_stop", {
          type: "content_block_stop",
          index
        });
      }

      writeSse(res, "message_delta", {
        type: "message_delta",
        delta: {
          stop_reason: "tool_use",
          stop_sequence: null
        },
        usage: {
          output_tokens: completionTokens
        }
      });

      writeSse(res, "message_stop", {
        type: "message_stop",
        usage: {
          input_tokens: promptTokens,
          output_tokens: completionTokens
        }
      });
      res.end();
      return;
    }

    endAnthropicStream(res, promptTokens, result.finalText);
    return;
  }

  writeJson(
    res,
    200,
    buildMessageResponse(body, result.finalText, {
      id: result.id || streamId,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      sessionId: binding.sessionId,
      stopReason: result.stopReason,
      toolCalls: result.toolCalls,
      toolResults: []
    }),
    sessionHeaders({ sessionId: binding.sessionId })
  );
}

async function runDirectOpenAi(body, req, res, client, directClient, sessionStore) {
  const headers = Object.fromEntries(
    Object.entries(req.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  const binding = resolveSessionBinding(headers, body, "openai");
  const request = buildDirectRequestFromOpenAi(body);
  const inputTokens = estimateTokens(flattenOpenAiRequest(body));
  const stream = body.stream === true;
  const chunkId = `chatcmpl_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let wroteAssistantRole = false;
  let wroteContent = false;
  let emittedToolCallIds = new Set();

  const result = await directClient.run(request, {
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "text_delta" && event.text) {
        if (!res.headersSent) {
          res.writeHead(200, {
            ...createCorsHeaders(),
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            ...sessionHeaders({ sessionId: binding.sessionId })
          });
        }

        if (!wroteAssistantRole) {
          res.write(
            `data: ${JSON.stringify(
              buildChatCompletionChunk(body, { role: "assistant" }, { created, id: chunkId })
            )}\n\n`
          );
          wroteAssistantRole = true;
        }

        wroteContent = true;
        res.write(
          `data: ${JSON.stringify(
            buildChatCompletionChunk(body, { content: event.text }, { created, id: chunkId })
          )}\n\n`
        );
      }

      if (event.type === "tool_call" && event.toolCall && !emittedToolCallIds.has(event.toolCall.id)) {
        emittedToolCallIds.add(event.toolCall.id);

        if (!res.headersSent) {
          res.writeHead(200, {
            ...createCorsHeaders(),
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "content-type": "text/event-stream; charset=utf-8",
            ...sessionHeaders({ sessionId: binding.sessionId })
          });
        }

        if (!wroteAssistantRole) {
          res.write(
            `data: ${JSON.stringify(
              buildChatCompletionChunk(body, { role: "assistant" }, { created, id: chunkId })
            )}\n\n`
          );
          wroteAssistantRole = true;
        }

        res.write(
          `data: ${JSON.stringify(
            buildChatCompletionChunk(
              body,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: event.toolCall.id,
                    type: "function",
                    function: {
                      name: event.toolCall.name,
                      arguments: JSON.stringify(event.toolCall.input || {})
                    }
                  }
                ]
              },
              { created, id: chunkId }
            )
          )}\n\n`
        );
      }
    }
  });

  const promptTokens = usagePromptTokens(result.usage) || inputTokens;
  const completionTokens =
    usageCompletionTokens(result.usage) || estimateTokens(result.finalText);

  if (stream) {
    if (!res.headersSent) {
      res.writeHead(200, {
        ...createCorsHeaders(),
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        ...sessionHeaders({ sessionId: binding.sessionId })
      });
      res.write(
        `data: ${JSON.stringify(
          buildChatCompletionChunk(body, { role: "assistant" }, { created, id: chunkId })
        )}\n\n`
      );
    }

    if (!wroteContent && result.finalText) {
      res.write(
        `data: ${JSON.stringify(
          buildChatCompletionChunk(body, { content: result.finalText }, { created, id: chunkId })
        )}\n\n`
      );
    }

    if (Array.isArray(result.toolCalls)) {
      for (const toolCall of result.toolCalls) {
        if (emittedToolCallIds.has(toolCall.id)) {
          continue;
        }

        res.write(
          `data: ${JSON.stringify(
            buildChatCompletionChunk(
              body,
              {
                tool_calls: [
                  {
                    index: 0,
                    id: toolCall.id,
                    type: "function",
                    function: {
                      name: toolCall.name,
                      arguments: JSON.stringify(toolCall.input || {})
                    }
                  }
                ]
              },
              { created, id: chunkId }
            )
          )}\n\n`
        );
      }
    }

    res.write(
      `data: ${JSON.stringify(
        buildChatCompletionChunk(
          body,
          {},
          {
            created,
            finishReason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
            id: chunkId
          }
        )
      )}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  writeJson(
    res,
    200,
    buildChatCompletionResponse(body, result.finalText, {
      created,
      id: result.id || chunkId,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      sessionId: binding.sessionId,
      toolCalls: result.toolCalls,
      toolResults: []
    }),
    sessionHeaders({ sessionId: binding.sessionId })
  );
}

async function handleMessagesRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req);

  if (await shouldUseDirectTransport(client, directClient)) {
    try {
      await runDirectAnthropic(body, req, res, client, directClient, sessionStore);
      return;
    } catch (error) {
      if (client.config.transportMode === "direct-llm") {
        throw error;
      }
    }
  }

  const prompt = flattenAnthropicRequest(body);
  const inputTokens = estimateTokens(prompt);
  const stream = body.stream === true;
  let streamStarted = false;
  const streamId = `msg_${Date.now()}`;

  const result = await executeBridgeQuery({
    body,
    client,
    prompt,
    protocol: "anthropic",
    req,
    sessionStore,
    onEvent(event) {
      if (!stream || event.type !== "append") {
        return;
      }

      if (!streamStarted) {
        streamStarted = true;
      }

      if (!res.headersSent) {
        startAnthropicStream(res, body, inputTokens, {
          id: streamId
        });
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
  });

  const finalText =
    result.finalText ||
    (result.channelResponse && result.channelResponse.content) ||
    "";
  const { errorCode, errorMessage } = resolveResultError(result);

  if (stream) {
    if (errorCode) {
      if (!res.headersSent) {
        writeJson(
          res,
          Number(errorCode),
          buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
          sessionHeaders(result)
        );
      }
      return;
    }

    if (!res.headersSent) {
      startAnthropicStream(res, body, inputTokens, {
        conversationId: result.conversationId,
        id: result.messageId || streamId,
        sessionId: result.sessionId
      });
    }

    if (!streamStarted && finalText) {
      writeSse(res, "content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: {
          type: "text_delta",
          text: finalText
        }
      });
    }

    endAnthropicStream(res, inputTokens, finalText);
    return;
  }

  if (errorCode) {
    writeJson(
      res,
      Number(errorCode),
      buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
      sessionHeaders(result)
    );
    return;
  }

  writeJson(
    res,
    200,
    buildMessageResponse(body, finalText, {
      conversationId: result.conversationId,
      id: result.messageId || `msg_${Date.now()}`,
      inputTokens,
      outputTokens: estimateTokens(finalText),
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults
    }),
    sessionHeaders(result)
  );
}

async function handleChatCompletionsRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req);

  if (await shouldUseDirectTransport(client, directClient)) {
    try {
      await runDirectOpenAi(body, req, res, client, directClient, sessionStore);
      return;
    } catch (error) {
      if (client.config.transportMode === "direct-llm") {
        throw error;
      }
    }
  }

  const prompt = flattenOpenAiRequest(body);
  const inputTokens = estimateTokens(prompt);
  const stream = body.stream === true;
  const chunkId = `chatcmpl_${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  let wroteAssistantRole = false;
  let wroteContent = false;

  const result = await executeBridgeQuery({
    body,
    client,
    prompt,
    protocol: "openai",
    req,
    sessionStore,
    onEvent(event) {
      if (!stream || event.type !== "append") {
        return;
      }

      if (!res.headersSent) {
        res.writeHead(200, {
          ...createCorsHeaders(),
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "content-type": "text/event-stream; charset=utf-8"
        });
      }

      if (!wroteAssistantRole) {
        res.write(
          `data: ${JSON.stringify(
            buildChatCompletionChunk(body, { role: "assistant" }, { created, id: chunkId })
          )}\n\n`
        );
        wroteAssistantRole = true;
      }

      if (event.delta) {
        wroteContent = true;
        res.write(
          `data: ${JSON.stringify(
            buildChatCompletionChunk(body, { content: event.delta }, { created, id: chunkId })
          )}\n\n`
        );
      }
    }
  });

  const finalText =
    result.finalText ||
    (result.channelResponse && result.channelResponse.content) ||
    "";
  const { errorCode, errorMessage } = resolveResultError(result);

  if (stream) {
    if (errorCode) {
      if (!res.headersSent) {
        writeJson(
          res,
          Number(errorCode),
          buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
          sessionHeaders(result)
        );
      }
      return;
    }

    if (!res.headersSent) {
      res.writeHead(200, {
        ...createCorsHeaders(),
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        ...sessionHeaders(result)
      });
      res.write(
        `data: ${JSON.stringify(
          buildChatCompletionChunk(body, { role: "assistant" }, { created, id: chunkId })
        )}\n\n`
      );
    }

    if (!wroteContent && finalText) {
      res.write(
        `data: ${JSON.stringify(
          buildChatCompletionChunk(body, { content: finalText }, { created, id: chunkId })
        )}\n\n`
      );
    }

    res.write(
      `data: ${JSON.stringify(
        buildChatCompletionChunk(
          body,
          {},
          {
            created,
            finishReason: result.toolCalls.length > 0 ? "tool_calls" : "stop",
            id: chunkId
          }
        )
      )}\n\n`
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  if (errorCode) {
    writeJson(
      res,
      Number(errorCode),
      buildErrorResponse(errorMessage, classifyErrorType(Number(errorCode))),
      sessionHeaders(result)
    );
    return;
  }

  writeJson(
    res,
    200,
    buildChatCompletionResponse(body, finalText, {
      conversationId: result.conversationId,
      created,
      id: chunkId,
      inputTokens,
      outputTokens: estimateTokens(finalText),
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults
    }),
    sessionHeaders(result)
  );
}

async function handleCountTokens(req, res, flattenFn) {
  const body = await readJsonBody(req);
  const prompt = flattenFn(body);
  writeJson(res, 200, {
    input_tokens: estimateTokens(prompt)
  });
}

async function handleHealth(req, res, client, directClient, sessionStore) {
  let auth = null;
  let authDebug = null;
  let directLlm = null;

  try {
    auth = await client.getAuthStatus();
  } catch (error) {
    auth = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    authDebug = await client.getAuthDebugStatus();
  } catch (error) {
    authDebug = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    directLlm = {
      available: await directClient.isAvailable(),
      upstreamBaseUrl: client.config.directLlmBaseUrl,
      transportMode: client.config.transportMode
    };
  } catch (error) {
    directLlm = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      upstreamBaseUrl: client.config.directLlmBaseUrl,
      transportMode: client.config.transportMode
    };
  }

  const storeExists = fs.existsSync(client.config.sessionStorePath);
  const storeStats = storeExists ? fs.statSync(client.config.sessionStorePath) : null;

  writeJson(res, 200, {
    ok: true,
    auth,
    authDebug,
    directLlm,
    config: {
      baseUrl: client.config.baseUrl,
      directLlmBaseUrl: client.config.directLlmBaseUrl,
      agentId: client.config.agentId,
      transportMode: client.config.transportMode,
      workspacePath: client.config.workspacePath,
      port: client.config.port
    },
    discovery: {
      accioHome: client.config.accioHome,
      accountId: client.config.accountId,
      sourceChannelId: client.config.sourceChannelId,
      sourceChatId: client.config.sourceChatId
    },
    sessions: {
      count: Object.keys(sessionStore.state.sessions || {}).length,
      exists: storeExists,
      path: client.config.sessionStorePath,
      updatedAt: storeStats ? storeStats.mtime.toISOString() : null
    }
  });
}

async function handleAccioAuthProbe(req, res, client, directClient) {
  let auth = null;
  let authDebug = null;
  let directLlmAvailable = false;

  try {
    auth = await client.getAuthStatus();
  } catch (error) {
    auth = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    authDebug = await client.getAuthDebugStatus();
  } catch (error) {
    authDebug = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const debugData =
    authDebug &&
    typeof authDebug === "object" &&
    authDebug.success === true &&
    authDebug.data &&
    typeof authDebug.data === "object"
      ? authDebug.data
      : null;
  const fileState = debugData && debugData.file && typeof debugData.file === "object"
    ? debugData.file
    : null;
  const memoryState =
    debugData && debugData.memory && typeof debugData.memory === "object"
      ? debugData.memory
      : null;
  const hasLocalCredentials = Boolean(
    (fileState && fileState.hasCredentials) || (memoryState && memoryState.hasCredentials)
  );
  const hasCookie = Boolean(
    (fileState && fileState.hasCookie) || (memoryState && memoryState.hasCookie)
  );
  const hasTokenPrefix = Boolean(
    (fileState && fileState.accessTokenPrefix) ||
      (memoryState && memoryState.accessTokenPrefix)
  );

  try {
    directLlmAvailable = await directClient.isAvailable();
  } catch {}

  writeJson(res, 200, {
    ok: true,
    baseUrl: client.config.baseUrl,
    probe: {
      authStatusEndpoint: "/auth/status",
      authDebugEndpoint: "/debug/auth/status",
      uploadProxyEndpoint: "/upload"
    },
    auth,
    authDebug,
    assessment: {
      localGatewayReachable: true,
      hasLocalCredentials,
      hasCookie,
      hasTokenPrefix,
      rawCredentialsExposedOverHttp: true,
      directAuthReuseFeasible: directLlmAvailable,
      note: directLlmAvailable
        ? "Local debug endpoints expose enough auth-bearing data to reuse the desktop login for direct /api/adk/llm calls."
        : "Direct upstream auth reuse is currently unavailable from the local gateway."
    }
  });
}

function createServer(client, directClient, sessionStore) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    try {
      if (req.method === "OPTIONS") {
        res.writeHead(204, createCorsHeaders());
        res.end();
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
        return;
      }

      if (req.method === "GET" && url.pathname === "/healthz") {
        await handleHealth(req, res, client, directClient, sessionStore);
        return;
      }

      if (req.method === "GET" && url.pathname === "/debug/accio-auth") {
        await handleAccioAuthProbe(req, res, client, directClient);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        writeJson(res, 200, buildOpenAiModelsResponse());
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages") {
        await handleMessagesRequest(req, res, client, directClient, sessionStore);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/messages/count_tokens") {
        await handleCountTokens(req, res, flattenAnthropicRequest);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        await handleChatCompletionsRequest(req, res, client, directClient, sessionStore);
        return;
      }

      writeJson(res, 404, buildErrorResponse(`No route for ${url.pathname}`));
    } catch (error) {
      const statusCode = error instanceof HttpError ? error.status : 500;
      const message =
        error instanceof HttpError
          ? error.body && error.body.error
            ? error.body.error
            : error.message
          : error instanceof Error
            ? error.message
            : String(error);

      writeJson(
        res,
        statusCode,
        buildErrorResponse(message, classifyErrorType(statusCode, error))
      );
    }
  });
}

async function main() {
  const config = createConfig();
  const client = new AccioClient(config);
  const directClient = new DirectLlmClient({
    localGatewayBaseUrl: config.baseUrl,
    requestTimeoutMs: config.requestTimeoutMs,
    upstreamBaseUrl: config.directLlmBaseUrl
  });
  const sessionStore = new SessionStore(config.sessionStorePath);
  const server = createServer(client, directClient, sessionStore);

  server.listen(config.port, "127.0.0.1", () => {
    process.stdout.write(
      `accio-anthropic-bridge listening on http://127.0.0.1:${config.port}\n`
    );
  });
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
