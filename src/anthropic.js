"use strict";

function normalizeContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }

      if (block.type === "text") {
        return block.text || "";
      }

      if (block.type === "image" || block.type === "image_url") {
        return "[Image omitted by bridge]";
      }

      if (block.type === "tool_use") {
        return `[Tool use omitted by bridge: ${block.name || "unknown"}]`;
      }

      if (block.type === "tool_result") {
        const value =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content || "");
        return `[Tool result]\n${value}`;
      }

      return `[Unsupported content block: ${block.type || "unknown"}]`;
    })
    .filter(Boolean)
    .join("\n");
}

function flattenAnthropicRequest(body) {
  const lines = [];

  if (typeof body.system === "string" && body.system.trim()) {
    lines.push("System:");
    lines.push(body.system.trim());
    lines.push("");
  }

  if (Array.isArray(body.messages) && body.messages.length > 0) {
    lines.push("Conversation:");

    for (const message of body.messages) {
      const role = (message && message.role) || "user";
      const text = normalizeContent(message && message.content);
      lines.push(`${role.toUpperCase()}:`);
      lines.push(text || "[Empty]");
      lines.push("");
    }
  }

  lines.push("Answer the latest user request directly.");
  return lines.join("\n").trim();
}

function estimateTokens(text) {
  if (!text) {
    return 0;
  }

  return Math.max(1, Math.ceil(String(text).length / 4));
}

function buildMessageResponse(body, text, extras = {}) {
  return {
    id: extras.id || `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: body.model || "accio-bridge",
    content: [
      {
        type: "text",
        text: text || ""
      }
    ],
    stop_reason: extras.stopReason || "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: extras.inputTokens || 0,
      output_tokens: extras.outputTokens || 0
    }
  };
}

function buildErrorResponse(message, type) {
  return {
    type: "error",
    error: {
      type: type || "api_error",
      message
    }
  };
}

module.exports = {
  buildErrorResponse,
  buildMessageResponse,
  estimateTokens,
  flattenAnthropicRequest,
  normalizeContent
};
