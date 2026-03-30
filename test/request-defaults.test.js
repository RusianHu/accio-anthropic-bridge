"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  applyAnthropicDefaults,
  applyOpenAiDefaults,
  applyResponsesDefaults,
  canCacheAnthropicRequest,
  canCacheOpenAiRequest,
  canCacheResponsesRequest
} = require("../src/request-defaults");

test("applyAnthropicDefaults only sets max_tokens when missing", () => {
  const body = applyAnthropicDefaults({ messages: [] }, { defaultMaxOutputTokens: 2048 });
  assert.equal(body.max_tokens, 2048);
  assert.equal(body.metadata.accio_default_max_tokens, true);

  const preserved = applyAnthropicDefaults({ messages: [], max_tokens: 99 }, { defaultMaxOutputTokens: 2048 });
  assert.equal(preserved.max_tokens, 99);
});

test("applyOpenAiDefaults and applyResponsesDefaults respect explicit values", () => {
  const openai = applyOpenAiDefaults({ messages: [] }, { defaultMaxOutputTokens: 1024 });
  assert.equal(openai.max_tokens, 1024);

  const responses = applyResponsesDefaults({ input: [] }, { defaultMaxOutputTokens: 512 });
  assert.equal(responses.max_output_tokens, 512);

  const explicit = applyResponsesDefaults({ input: [], max_output_tokens: 2049 }, { defaultMaxOutputTokens: 512 });
  assert.equal(explicit.max_output_tokens, 2049);
});

test("cache eligibility stays disabled for tools, images, and thinking", () => {
  assert.equal(canCacheAnthropicRequest({ messages: [{ role: "user", content: "hello" }] }), true);
  assert.equal(canCacheAnthropicRequest({ thinking: { type: "enabled" }, messages: [] }), false);
  assert.equal(canCacheOpenAiRequest({ messages: [{ role: "tool", content: "x" }] }), false);
  assert.equal(canCacheResponsesRequest({ input: [{ role: "user", content: [{ type: "input_image", image_url: "https://x" }] }] }), false);
});
