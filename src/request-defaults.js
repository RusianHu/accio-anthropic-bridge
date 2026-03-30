"use strict";

function hasToolingInAnthropic(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return true;
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    for (const block of Array.isArray(message && message.content) ? message.content : []) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (block.type === "tool_use" || block.type === "tool_result" || block.type === "image") {
        return true;
      }
    }
  }

  return false;
}

function hasToolingInOpenAi(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return true;
  }

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    if (message && message.role === "tool") {
      return true;
    }

    if (Array.isArray(message && message.tool_calls) && message.tool_calls.length > 0) {
      return true;
    }

    for (const block of Array.isArray(message && message.content) ? message.content : []) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (block.type === "image_url" || block.type === "input_image") {
        return true;
      }
    }
  }

  return false;
}

function hasToolingInResponses(body) {
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    return true;
  }

  for (const item of Array.isArray(body.input) ? body.input : []) {
    for (const block of Array.isArray(item && item.content) ? item.content : []) {
      if (!block || typeof block !== "object") {
        continue;
      }

      if (block.type === "input_image" || block.type === "tool_call" || block.type === "tool_result") {
        return true;
      }
    }
  }

  return false;
}

function applyAnthropicDefaults(body, config) {
  if (!body || typeof body !== "object") {
    return body;
  }

  if ((body.max_tokens == null || body.max_tokens === "") && Number(config.defaultMaxOutputTokens || 0) > 0) {
    body.max_tokens = Number(config.defaultMaxOutputTokens);
    body.metadata = {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      accio_default_max_tokens: true
    };
  }

  return body;
}

function applyOpenAiDefaults(body, config) {
  if (!body || typeof body !== "object") {
    return body;
  }

  if ((body.max_tokens == null || body.max_tokens === "") && Number(config.defaultMaxOutputTokens || 0) > 0) {
    body.max_tokens = Number(config.defaultMaxOutputTokens);
    body.metadata = {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      accio_default_max_tokens: true
    };
  }

  return body;
}

function applyResponsesDefaults(body, config) {
  if (!body || typeof body !== "object") {
    return body;
  }

  if (
    (body.max_output_tokens == null || body.max_output_tokens === "") &&
    (body.max_tokens == null || body.max_tokens === "") &&
    Number(config.defaultMaxOutputTokens || 0) > 0
  ) {
    body.max_output_tokens = Number(config.defaultMaxOutputTokens);
    body.metadata = {
      ...(body.metadata && typeof body.metadata === "object" ? body.metadata : {}),
      accio_default_max_tokens: true
    };
  }

  return body;
}

function canCacheAnthropicRequest(body) {
  return body && body.stream !== true && !body.thinking && !hasToolingInAnthropic(body);
}

function canCacheOpenAiRequest(body) {
  return body && body.stream !== true && !hasToolingInOpenAi(body);
}

function canCacheResponsesRequest(body) {
  return body && body.stream !== true && !hasToolingInResponses(body);
}

module.exports = {
  applyAnthropicDefaults,
  applyOpenAiDefaults,
  applyResponsesDefaults,
  canCacheAnthropicRequest,
  canCacheOpenAiRequest,
  canCacheResponsesRequest,
  hasToolingInAnthropic,
  hasToolingInOpenAi,
  hasToolingInResponses
};
