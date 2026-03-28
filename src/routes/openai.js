"use strict";

const crypto = require("node:crypto");

const { estimateTokens } = require("../anthropic");
const { buildDirectRequestFromOpenAi } = require("../direct-llm");
const { classifyErrorType, resolveResultError } = require("../errors");
const { writeJson } = require("../http");
const { readJsonBody } = require("../middleware/body-parser");
const {
  buildChatCompletionResponse,
  buildOpenAiModelsResponse,
  flattenOpenAiRequest
} = require("../openai");
const { OpenAiStreamWriter } = require("../stream/openai-sse");
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

async function runDirectOpenAi(body, req, res, directClient) {
  const binding = resolveSessionBinding(req.headers, body, "openai");
  const request = buildDirectRequestFromOpenAi(body);
  const inputTokens = estimateTokens(flattenOpenAiRequest(body));
  const stream = body.stream === true;
  const chunkId = generateId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  const emittedToolCallIds = new Set();
  let wroteContent = false;
  const writer = new OpenAiStreamWriter({
    body,
    res,
    created,
    id: chunkId,
    sessionId: binding.sessionId
  });

  const result = await directClient.run(request, {
    onEvent(event) {
      if (!stream) {
        return;
      }

      if (event.type === "text_delta" && event.text) {
        wroteContent = true;
        writer.writeContent(event.text);
      }

      if (event.type === "tool_call" && event.toolCall && !emittedToolCallIds.has(event.toolCall.id)) {
        emittedToolCallIds.add(event.toolCall.id);
        writer.writeToolCall(event.toolCall);
      }
    }
  });

  const promptTokens = usagePromptTokens(result.usage) || inputTokens;
  const completionTokens = usageCompletionTokens(result.usage) || estimateTokens(result.finalText);
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];

  if (stream) {
    writer.ensureAssistantRole();

    if (!wroteContent && result.finalText) {
      writer.writeContent(result.finalText);
    }

    for (const toolCall of toolCalls) {
      if (emittedToolCallIds.has(toolCall.id)) {
        continue;
      }

      writer.writeToolCall(toolCall);
    }

    writer.finish(toolCalls.length > 0 ? "tool_calls" : "stop");
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
      toolCalls,
      toolResults: []
    }),
    sessionHeaders({ sessionId: binding.sessionId })
  );
}

async function handleChatCompletionsRequest(req, res, client, directClient, sessionStore) {
  const body = await readJsonBody(req);

  if (await shouldUseDirectTransport(client, directClient)) {
    try {
      await runDirectOpenAi(body, req, res, directClient);
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
  const chunkId = generateId("chatcmpl");
  const created = Math.floor(Date.now() / 1000);
  let wroteContent = false;
  let writer = null;

  const getWriter = (options = {}) => {
    if (!writer) {
      writer = new OpenAiStreamWriter({
        body,
        res,
        created,
        id: chunkId,
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
    protocol: "openai",
    req,
    sessionStore,
    onEvent(event) {
      if (!stream || event.type !== "append") {
        return;
      }

      if (event.delta) {
        wroteContent = true;
        getWriter().writeContent(event.delta);
      }
    }
  });

  const finalText = result.finalText || (result.channelResponse && result.channelResponse.content) || "";
  const { errorCode, errorMessage } = resolveResultError(result);
  const toolCalls = Array.isArray(result.toolCalls) ? result.toolCalls : [];

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

    const streamWriter = getWriter(result);
    streamWriter.ensureAssistantRole();

    if (!wroteContent && finalText) {
      streamWriter.writeContent(finalText);
    }

    streamWriter.finish(toolCalls.length > 0 ? "tool_calls" : "stop");
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
      toolCalls,
      toolResults: result.toolResults
    }),
    sessionHeaders(result)
  );
}

module.exports = {
  buildOpenAiModelsResponse,
  handleChatCompletionsRequest
};
