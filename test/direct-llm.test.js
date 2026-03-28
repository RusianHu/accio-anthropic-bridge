"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildDirectRequestFromAnthropic,
  buildDirectRequestFromOpenAi,
  mapRequestedModel
} = require("../src/direct-llm");

test("mapRequestedModel uses external alias config", () => {
  assert.equal(mapRequestedModel("gpt-5"), "claude-opus-4-6");
  assert.equal(mapRequestedModel("claude-sonnet-4-6"), "claude-sonnet-4-6");
  assert.equal(mapRequestedModel("custom-model"), "custom-model");
});

test("buildDirectRequestFromAnthropic maps tool_result and aliased model", () => {
  const request = buildDirectRequestFromAnthropic({
    model: "gpt-5",
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool_1", name: "shell_echo", input: { text: "hi" } }]
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool_1", content: "hi" }]
      }
    ]
  });

  assert.equal(request.model, "claude-opus-4-6");
  assert.equal(request.requestBody.model, "claude-opus-4-6");
  assert.equal(request.requestBody.contents[1].parts[0].function_response.name, "shell_echo");
});

test("buildDirectRequestFromOpenAi maps tools into declarations", () => {
  const request = buildDirectRequestFromOpenAi({
    model: "claude-opus-4-6",
    tools: [
      {
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather",
          parameters: { type: "object", properties: { city: { type: "string" } } }
        }
      }
    ],
    messages: [{ role: "user", content: "hello" }]
  });

  assert.equal(request.requestBody.tools[0].name, "lookup_weather");
  assert.match(request.requestBody.tools[0].parameters_json, /city/);
});
