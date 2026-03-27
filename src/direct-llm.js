"use strict";

const crypto = require("node:crypto");

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeRequestedModel(model) {
  const value = String(model || "").trim();

  if (!value || ["accio-bridge", "auto", "default"].includes(value)) {
    return null;
  }

  return value;
}

function mapRequestedModel(model, protocol) {
  const requested = normalizeRequestedModel(model);
  const fallback = "claude-opus-4-6";

  if (!requested) {
    return fallback;
  }

  const aliasMap = {
    "claude-opus-4-6": "claude-opus-4-6",
    "claude-opus-4-5": "claude-opus-4-6",
    "claude-opus-4-1": "claude-opus-4-6",
    "claude-sonnet-4-6": "claude-sonnet-4-6",
    "claude-sonnet-4-5": "claude-sonnet-4-6",
    "claude-3-7-sonnet-latest": "claude-sonnet-4-6",
    "claude-haiku-4-5": "claude-haiku-4-5",
    "gpt-5.1": "claude-opus-4-6",
    "gpt-5.1-1113": "claude-opus-4-6",
    "gpt-5": "claude-opus-4-6",
    "gpt-5-0807": "claude-opus-4-6",
    "gpt-5-mini": "claude-opus-4-6",
    "gpt-5-mini-0807": "claude-opus-4-6",
    "gpt-4.1": "claude-opus-4-6",
    "gpt-4.1-0414": "claude-opus-4-6",
    "gpt-4.1-mini": "claude-opus-4-6",
    "gpt-4.1-mini-0414": "claude-opus-4-6",
    "gpt-4o": "claude-opus-4-6",
    "gemini-3-flash-preview": "gemini-3-flash-preview",
    "gemini-3-pro-preview": "gemini-3-pro-preview"
  };

  return aliasMap[requested] || requested;
}

function inferProvider(model) {
  const value = String(model || "").toLowerCase();

  if (value.includes("claude")) {
    return "claude";
  }

  if (value.includes("gpt")) {
    return "openai";
  }

  if (value.includes("gemini")) {
    return "gemini";
  }

  return "unknown";
}

function toToolDeclarations(tools, pickSchema) {
  if (!Array.isArray(tools)) {
    return [];
  }

  return tools
    .map((tool) => {
      if (!tool || typeof tool !== "object" || !tool.name) {
        return null;
      }

      return {
        name: tool.name,
        description: tool.description || "",
        parameters_json: JSON.stringify(pickSchema(tool) || {})
      };
    })
    .filter(Boolean);
}

function normalizeImagePart(block) {
  if (!block || typeof block !== "object") {
    return null;
  }

  if (block.type === "image_url" && block.image_url && block.image_url.url) {
    return {
      file_data: {
        file_uri: block.image_url.url,
        mime_type: "image/png"
      }
    };
  }

  if (block.type !== "image") {
    return null;
  }

  const source = block.source || {};

  if (source.type === "base64" && source.data) {
    return {
      inline_data: {
        mime_type: source.media_type || "image/png",
        data: source.data
      }
    };
  }

  if (source.type === "url" && source.url) {
    return {
      file_data: {
        file_uri: source.url,
        mime_type: source.media_type || "image/png"
      }
    };
  }

  return null;
}

function buildAnthropicToolNameMap(messages) {
  const map = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    const content = Array.isArray(message && message.content)
      ? message.content
      : [];

    for (const block of content) {
      if (block && block.type === "tool_use" && block.id && block.name) {
        map.set(block.id, block.name);
      }
    }
  }

  return map;
}

function normalizeToolResultContent(content) {
  if (typeof content === "string") {
    return safeJsonParse(content, { result: content });
  }

  if (!Array.isArray(content)) {
    return content && typeof content === "object" ? content : { result: content };
  }

  const textParts = content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text);

  if (textParts.length === 1) {
    return safeJsonParse(textParts[0], { result: textParts[0] });
  }

  if (textParts.length > 1) {
    return { result: textParts.join("\n") };
  }

  return { result: content };
}

function toAnthropicDirectParts(content, role, toolNameById) {
  const normalized = typeof content === "string" ? [{ type: "text", text: content }] : content;
  const parts = [];

  for (const block of Array.isArray(normalized) ? normalized : []) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "text") {
      parts.push({ text: block.text || "" });
      continue;
    }

    const imagePart = normalizeImagePart(block);

    if (imagePart) {
      parts.push(imagePart);
      continue;
    }

    if (role === "assistant" && block.type === "tool_use") {
      parts.push({
        function_call: {
          id: block.id || crypto.randomUUID(),
          name: block.name || "unknown",
          args_json: JSON.stringify(block.input || {})
        }
      });
      continue;
    }

    if (role === "user" && block.type === "tool_result") {
      parts.push({
        function_response: {
          id: block.tool_use_id || "",
          name: toolNameById.get(block.tool_use_id) || block.name || "tool",
          response_json: JSON.stringify(normalizeToolResultContent(block.content))
        }
      });
    }
  }

  return parts.length > 0 ? parts : [{ text: "" }];
}

function buildDirectRequestFromAnthropic(body) {
  const toolNameById = buildAnthropicToolNameMap(body.messages);
  const contents = [];

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "model" : "user";

    contents.push({
      role,
      parts: toAnthropicDirectParts(message && message.content, message && message.role, toolNameById)
    });
  }

  return {
    protocol: "anthropic",
    model: mapRequestedModel(body.model, "anthropic"),
    requestBody: {
      model: mapRequestedModel(body.model, "anthropic"),
      request_id: `anthropic-${Date.now()}`,
      contents,
      system_instruction: typeof body.system === "string"
        ? body.system
        : Array.isArray(body.system)
          ? body.system
            .filter((block) => block && block.type === "text" && block.text)
            .map((block) => block.text)
            .join("\n\n")
          : "",
      tools: toToolDeclarations(body.tools, (tool) => tool.input_schema),
      temperature: body.temperature,
      max_output_tokens: body.max_tokens,
      stop_sequences: Array.isArray(body.stop_sequences) ? body.stop_sequences : []
    }
  };
}

function buildOpenAiToolNameMap(messages) {
  const map = new Map();

  for (const message of Array.isArray(messages) ? messages : []) {
    for (const toolCall of Array.isArray(message && message.tool_calls) ? message.tool_calls : []) {
      const fn = toolCall && toolCall.function;

      if (toolCall && toolCall.id && fn && fn.name) {
        map.set(toolCall.id, fn.name);
      }
    }
  }

  return map;
}

function normalizeOpenAiContentParts(content) {
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }

  if (Array.isArray(content)) {
    return content;
  }

  return [{ type: "text", text: "" }];
}

function toOpenAiDirectParts(message, toolNameById) {
  const parts = [];

  for (const block of normalizeOpenAiContentParts(message && message.content)) {
    if (!block || typeof block !== "object") {
      continue;
    }

    if (block.type === "text") {
      parts.push({ text: block.text || "" });
      continue;
    }

    const imagePart = normalizeImagePart(block);

    if (imagePart) {
      parts.push(imagePart);
    }
  }

  if (message && message.role === "assistant") {
    for (const toolCall of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
      const fn = toolCall && toolCall.function;

      if (!fn || !fn.name) {
        continue;
      }

      parts.push({
        function_call: {
          id: toolCall.id || crypto.randomUUID(),
          name: fn.name,
          args_json: fn.arguments || "{}"
        }
      });
    }
  }

  if (message && message.role === "tool") {
    parts.push({
      function_response: {
        id: message.tool_call_id || "",
        name: toolNameById.get(message.tool_call_id) || message.name || "tool",
        response_json: JSON.stringify(
          normalizeToolResultContent(message.content)
        )
      }
    });
  }

  return parts.length > 0 ? parts : [{ text: "" }];
}

function buildDirectRequestFromOpenAi(body) {
  const toolNameById = buildOpenAiToolNameMap(body.messages);
  const contents = [];

  for (const message of Array.isArray(body.messages) ? body.messages : []) {
    const role = message && message.role === "assistant" ? "model" : "user";
    contents.push({
      role,
      parts: toOpenAiDirectParts(message, toolNameById)
    });
  }

  return {
    protocol: "openai",
    model: mapRequestedModel(body.model, "openai"),
    requestBody: {
      model: mapRequestedModel(body.model, "openai"),
      request_id: `openai-${Date.now()}`,
      contents,
      tools: toToolDeclarations(
        Array.isArray(body.tools)
          ? body.tools
            .map((tool) => tool && (tool.function || tool))
            .filter(Boolean)
          : [],
        (tool) => tool.parameters || tool.input_schema
      ),
      temperature: body.temperature,
      max_output_tokens: body.max_tokens,
      stop_sequences: Array.isArray(body.stop) ? body.stop : body.stop ? [body.stop] : []
    }
  };
}

function maybeParseJsonString(value) {
  if (typeof value !== "string") {
    return value;
  }

  return safeJsonParse(value, value);
}

class DirectResponseAccumulator {
  constructor(model) {
    this.model = model;
    this.provider = inferProvider(model);
    this.id = null;
    this.text = "";
    this.toolCalls = [];
    this.stopReason = null;
    this.usage = null;
    this.currentTool = null;
  }

  applyNormalizedParts(parts, onEvent) {
    for (const part of Array.isArray(parts) ? parts : []) {
      if (typeof part.text === "string" && part.text) {
        this.text += part.text;

        if (typeof onEvent === "function") {
          onEvent({ type: "text_delta", text: part.text });
        }
      }

      const functionCall = part.functionCall || part.function_call;

      if (functionCall && functionCall.name) {
        const id = functionCall.id || crypto.randomUUID();
        const input = maybeParseJsonString(functionCall.argsJson || functionCall.args_json || "{}");
        const toolCall = {
          id,
          name: functionCall.name,
          input: input && typeof input === "object" ? input : {}
        };

        if (!this.toolCalls.find((item) => item.id === toolCall.id)) {
          this.toolCalls.push(toolCall);
        }
      }
    }
  }

  applyClaudeEvent(raw, onEvent) {
    if (!raw || typeof raw !== "object" || !raw.type) {
      return;
    }

    if (typeof onEvent === "function") {
      onEvent({ type: "claude_raw", raw });
    }

    if (raw.type === "message_start" && raw.message) {
      this.id = raw.message.id || this.id;
      this.model = raw.message.model || this.model;
      this.usage = raw.message.usage || this.usage;
      return;
    }

    if (raw.type === "content_block_start" && raw.content_block) {
      const block = raw.content_block;

      if (block.type === "tool_use") {
        this.currentTool = {
          id: block.id || crypto.randomUUID(),
          name: block.name || "tool",
          inputJson:
            block.input && Object.keys(block.input).length > 0
              ? JSON.stringify(block.input)
              : ""
        };
      }

      return;
    }

    if (raw.type === "content_block_delta" && raw.delta) {
      if (raw.delta.type === "text_delta") {
        const deltaText = raw.delta.text || "";
        this.text += deltaText;

        if (typeof onEvent === "function" && deltaText) {
          onEvent({ type: "text_delta", text: deltaText });
        }

        return;
      }

      if (raw.delta.type === "input_json_delta" && this.currentTool) {
        this.currentTool.inputJson += raw.delta.partial_json || "";
      }

      return;
    }

    if (raw.type === "content_block_stop" && this.currentTool) {
      const input = maybeParseJsonString(this.currentTool.inputJson || "{}");
      const toolCall = {
        id: this.currentTool.id,
        name: this.currentTool.name,
        input: input && typeof input === "object" ? input : {}
      };

      if (!this.toolCalls.find((item) => item.id === toolCall.id)) {
        this.toolCalls.push(toolCall);
      }

      if (typeof onEvent === "function") {
        onEvent({ type: "tool_call", toolCall });
      }

      this.currentTool = null;
      return;
    }

    if (raw.type === "message_delta") {
      this.stopReason =
        (raw.delta && raw.delta.stop_reason) || this.stopReason || null;
      this.usage = {
        ...(this.usage || {}),
        ...(raw.usage || {})
      };
    }
  }

  applyFrame(frame, onEvent) {
    if (frame.id) {
      this.id = frame.id;
    }

    if (frame.model) {
      this.model = frame.model;
    }

    if (frame.usage_metadata) {
      this.usage = frame.usage_metadata;
    }

    if (frame.finish_reason) {
      this.stopReason = frame.finish_reason;
    }

    if (frame.content && Array.isArray(frame.content.parts)) {
      this.applyNormalizedParts(frame.content.parts, onEvent);
    }

    if (frame.raw_response_json) {
      const raw = safeJsonParse(frame.raw_response_json, null);

      if (raw && raw.type) {
        this.applyClaudeEvent(raw, onEvent);
      }
    }
  }

  toResult() {
    return {
      id: this.id || `msg_${Date.now()}`,
      model: this.model,
      finalText: this.text,
      toolCalls: this.toolCalls,
      stopReason:
        this.stopReason ||
        (this.toolCalls.length > 0 && !this.text ? "tool_use" : "end_turn"),
      usage: this.usage || null
    };
  }
}

async function* parseSseEvents(stream) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() || "";

      for (const block of blocks) {
        const lines = block.split("\n");
        const dataLines = [];

        for (const line of lines) {
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).trimStart());
          }
        }

        if (dataLines.length === 0) {
          continue;
        }

        const data = dataLines.join("\n");

        if (data === "[DONE]") {
          continue;
        }

        yield safeJsonParse(data, null);
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class DirectLlmClient {
  constructor(config) {
    this.config = config;
  }

  async getAuthToken() {
    const res = await fetch(`${this.config.localGatewayBaseUrl}/debug/auth/ws-status`);
    const payload = await res.json();
    const url = payload && payload.data && payload.data.phoenix && payload.data.phoenix.url;

    if (!url) {
      throw new Error("Unable to resolve Accio access token from local gateway");
    }

    return new URL(url).searchParams.get("accessToken");
  }

  async isAvailable() {
    try {
      return Boolean(await this.getAuthToken());
    } catch {
      return false;
    }
  }

  async run(request, options = {}) {
    const token = await this.getAuthToken();

    if (!token) {
      throw new Error("Accio access token is unavailable");
    }

    const upstreamBody = {
      ...request.requestBody,
      token
    };
    const res = await fetch(`${this.config.upstreamBaseUrl}/generateContent`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream"
      },
      body: JSON.stringify(upstreamBody),
      signal: AbortSignal.timeout(this.config.requestTimeoutMs)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Direct LLM request failed: ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`
      );
    }

    if (!res.body) {
      throw new Error("Direct LLM response has no body");
    }

    const state = new DirectResponseAccumulator(request.model);

    for await (const frame of parseSseEvents(res.body)) {
      if (!frame) {
        continue;
      }

      state.applyFrame(frame, options.onEvent);
    }

    return state.toResult();
  }
}

module.exports = {
  DirectLlmClient,
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi
};
