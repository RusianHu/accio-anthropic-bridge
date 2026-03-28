"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildMessageResponse,
  estimateTokens,
  flattenAnthropicRequest,
  normalizeContent,
  normalizeSystemPrompt
} = require("../src/anthropic");

test("normalizeSystemPrompt handles string and text blocks", () => {
  assert.equal(normalizeSystemPrompt("system text"), "system text");
  assert.equal(
    normalizeSystemPrompt([
      { type: "text", text: "alpha" },
      { type: "image", source: { type: "url", url: "https://example.com/a.png" } }
    ]),
    "alpha\n[Unsupported system block: image]"
  );
});

test("normalizeContent handles tool use and tool result blocks", () => {
  const normalized = normalizeContent([
    { type: "text", text: "hello" },
    { type: "tool_use", id: "tool_1", name: "lookup", input: { q: "weather" } },
    { type: "tool_result", tool_use_id: "tool_1", content: "sunny" }
  ]);

  assert.match(normalized, /hello/);
  assert.match(normalized, /Assistant requested tool lookup id=tool_1/);
  assert.match(normalized, /Tool result for tool_1/);
});

test("flattenAnthropicRequest includes system, tools and conversation", () => {
  const flattened = flattenAnthropicRequest({
    system: [{ type: "text", text: "be concise" }],
    tools: [
      {
        name: "shell_echo",
        description: "Echo text",
        input_schema: { type: "object", properties: { text: { type: "string" } } }
      }
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "Say hi" }] }]
  });

  assert.match(flattened, /^System:/);
  assert.match(flattened, /Available tools:/);
  assert.match(flattened, /Conversation:/);
  assert.match(flattened, /USER:/);
});

test("estimateTokens gives higher weight to CJK than ASCII", () => {
  assert.ok(estimateTokens("你好世界") > estimateTokens("abcd"));
});

test("buildMessageResponse emits tool_use blocks and stop reason", () => {
  const response = buildMessageResponse(
    { model: "accio-bridge" },
    "",
    {
      inputTokens: 10,
      outputTokens: 5,
      toolCalls: [{ id: "call_1", name: "shell_echo", input: { text: "hi" } }],
      toolResults: [{ tool_use_id: "call_1", content: "hi" }]
    }
  );

  assert.equal(response.stop_reason, "tool_use");
  assert.equal(response.content[0].type, "tool_use");
  assert.deepEqual(response.accio.tool_results, [{ tool_use_id: "call_1", content: "hi" }]);
});
