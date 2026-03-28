"use strict";

const crypto = require("node:crypto");

const { normalizeContent } = require("./anthropic");

function generateId(prefix) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

function normalizeToolDefinitions(tools) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      const fn = tool && (tool.function || tool);

      if (!fn || !fn.name) {
        return null;
      }

      return {
        name: fn.name,
        description: fn.description || "",
        input_schema: fn.parameters || fn.input_schema || {}
      };
    })
    .filter(Boolean);
}

function normalizeOpenAiMessage(message) {
  if (!message || typeof message !== "object") {
    return "";
  }

  if (message.role === "tool") {
    return `[Tool result for ${message.tool_call_id || "unknown"}]\n${normalizeContent(
      message.content
    )}`;
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    return message.tool_calls
      .map((call) => {
        const fn = call.function || {};
        return `[Assistant requested tool ${fn.name || "unknown"} id=${call.id || "unknown"}]\n${
          fn.arguments || "{}"
        }`;
      })
      .join("\n");
  }

  return normalizeContent(message.content);
}

function flattenOpenAiRequest(body) {
  const lines = [];
  const tools = normalizeToolDefinitions(body.tools);

  if (tools.length > 0) {
    lines.push("Available tools:");

    for (const tool of tools) {
      lines.push(`- ${tool.name}`);

      if (tool.description) {
        lines.push(`  Description: ${tool.description}`);
      }

      if (tool.input_schema && Object.keys(tool.input_schema).length > 0) {
        lines.push(`  JSON schema: ${JSON.stringify(tool.input_schema)}`);
      }
    }

    lines.push("");
  }

  lines.push("Conversation:");

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    lines.push(`${String(message.role || "user").toUpperCase()}:`);
    lines.push(normalizeOpenAiMessage(message) || "[Empty]");
    lines.push("");
  }

  lines.push("Answer the latest user request directly.");
  return lines.join("\n").trim();
}

function toOpenAiToolCalls(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((toolCall) => ({
    id: toolCall.id,
    type: "function",
    function: {
      name: toolCall.name,
      arguments: JSON.stringify(toolCall.input || {})
    }
  }));
}

function buildChatCompletionResponse(body, text, extras = {}) {
  const toolCalls = toOpenAiToolCalls(extras.toolCalls);
  const hasToolCalls = toolCalls.length > 0;

  return {
    id: extras.id || generateId("chatcmpl"),
    object: "chat.completion",
    created: extras.created || Math.floor(Date.now() / 1000),
    model: body.model || "accio-bridge",
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: text || "",
          ...(hasToolCalls ? { tool_calls: toolCalls } : {})
        },
        finish_reason: hasToolCalls ? "tool_calls" : "stop"
      }
    ],
    usage: {
      prompt_tokens: extras.inputTokens || 0,
      completion_tokens: extras.outputTokens || 0,
      total_tokens: (extras.inputTokens || 0) + (extras.outputTokens || 0)
    },
    accio: {
      conversation_id: extras.conversationId || null,
      session_id: extras.sessionId || null,
      tool_results: extras.toolResults || []
    }
  };
}

function buildChatCompletionChunk(body, delta, extras = {}) {
  return {
    id: extras.id || generateId("chatcmpl"),
    object: "chat.completion.chunk",
    created: extras.created || Math.floor(Date.now() / 1000),
    model: body.model || "accio-bridge",
    choices: [
      {
        index: 0,
        delta,
        finish_reason: extras.finishReason || null
      }
    ]
  };
}

function buildOpenAiModelsResponse() {
  return {
    object: "list",
    data: [
      {
        id: "accio-bridge",
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "accio"
      }
    ]
  };
}

module.exports = {
  buildChatCompletionChunk,
  buildChatCompletionResponse,
  buildOpenAiModelsResponse,
  flattenOpenAiRequest
};
