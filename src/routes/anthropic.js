"use strict";

const crypto = require("node:crypto");

const { buildErrorResponse, buildMessageResponse, estimateTokens, flattenAnthropicRequest } = require("../anthropic");
const { buildDirectRequestFromAnthropic } = require("../direct-llm");
const { classifyErrorType, resolveResultError, shouldFallbackToLocalTransport } = require("../errors");
const { CORS_HEADERS, writeJson, writeSse } = require("../http");
const { readJsonBody } = require("../middleware/body-parser");
const { AnthropicStreamWriter } = require("../stream/anthropic-sse");
const {
  executeBridgeQuery,
  sessionHeaders,
  shouldUseDirectTransport,
  usageCompletionTokens,
  usagePromptTokens
} = require("../bridge-core");
const { resolveSessionBinding } = require("../session-store");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function requestedAccountId(headers) {
  return headers["x-accio-account-id"] || headers["x-account-id"] || null;
}

async function runDirectAnthropic(body, req, res, directClient) {
  const binding = resolveSessionBinding(req.headers, body, "anthropic");
  const request = buildDirectRequestFromAnthropic(body);
  const inputTokens = estimateTokens(flattenAnthropicRequest(body));
  const stream = body.stream === true;
  const streamId = generateId("msg");
  let writer = null;
  let wroteRawClaudeStream = false;
  let wroteSyntheticText = false;

  const getWriter = (options = {}) => {
    if (!writer) {
      writer = new AnthropicStreamWriter({
        estimateTokens,
        inputTokens,
        body,
        res,
        id: options.id || streamId,
        conversationId: options.conversationId,
        sessionId: options.sessionId || binding.sessionId
      });
    }

    return writer;
  };

  const result = await directClient.run(request, {
    accountId: requestedAccountId(req.headers),
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "claude_raw") {
        if (!res.headersSent) {
          res.writeHead(200, {
            ...CORS_HEADERS,
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
        wroteSyntheticText = true;
        getWriter().writeTextDelta(event.text);
      }
    }
  });

  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];
  const promptTokens = usagePromptTokens(result.usage) || inputTokens;
  const completionTokens = usageCompletionTokens(result.usage) || estimateTokens(result.finalText);

  if (stream) {
    if (wroteRawClaudeStream) {
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    const streamWriter = getWriter({ id: result.id || streamId });

    if (!wroteSyntheticText && result.finalText) {
      streamWriter.writeTextDelta(result.finalText);
    }

    if (toolCalls.length > 0) {
      streamWriter.writeToolCalls(toolCalls);
      streamWriter.finishToolUse(promptTokens, completionTokens);
      return;
    }

    streamWriter.finishEndTurn(result.finalText, promptTokens);
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
      toolCalls,
      toolResults: [],
      accountId: result.accountId
    }),
    sessionHeaders({ sessionId: binding.sessionId })
  );
}

async function handleMessagesRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req);

  if (await shouldUseDirectTransport(client, directClient)) {
    try {
      await runDirectAnthropic(body, req, res, directClient);
      return;
    } catch (error) {
      if (client.config.transportMode === "direct-llm" || !shouldFallbackToLocalTransport(error)) {
        throw error;
      }
    }
  }

  const prompt = flattenAnthropicRequest(body);
  const inputTokens = estimateTokens(prompt);
  const stream = body.stream === true;
  let streamStarted = false;
  const streamId = generateId("msg");
  let writer = null;

  const getWriter = (options = {}) => {
    if (!writer) {
      writer = new AnthropicStreamWriter({
        estimateTokens,
        inputTokens,
        body,
        res,
        id: options.id || streamId,
        conversationId: options.conversationId,
        sessionId: options.sessionId
      });
    }

    return writer;
  };

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

      if (event.delta) {
        getWriter({ id: streamId }).writeTextDelta(event.delta);
      }
    }
  });

  const finalText = result.finalText || (result.channelResponse && result.channelResponse.content) || "";
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

    const streamWriter = getWriter({
      conversationId: result.conversationId,
      id: result.messageId || streamId,
      sessionId: result.sessionId
    });

    if (!streamStarted && finalText) {
      streamWriter.writeTextDelta(finalText);
    }

    streamWriter.finishEndTurn(finalText, inputTokens);
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
      id: result.messageId || generateId("msg"),
      inputTokens,
      outputTokens: estimateTokens(finalText),
      sessionId: result.sessionId,
      toolCalls: result.toolCalls,
      toolResults: result.toolResults
    }),
    sessionHeaders(result)
  );
}

async function handleCountTokens(req, res) {
  const body = await readJsonBody(req);
  const prompt = flattenAnthropicRequest(body);
  writeJson(res, 200, {
    input_tokens: estimateTokens(prompt)
  });
}

module.exports = {
  handleCountTokens,
  handleMessagesRequest
};
