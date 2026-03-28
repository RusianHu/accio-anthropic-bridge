"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { resolveResultError } = require("../src/errors");
const { parseJsonc, stripJsonComments } = require("../src/jsonc");
const { resolveSessionBinding } = require("../src/session-store");

test("stripJsonComments preserves strings while removing comments", () => {
  const text = '{\n  // comment\n  "url": "https://example.com//path",\n  /* block */\n  "ok": true\n}';
  const stripped = stripJsonComments(text);

  assert.match(stripped, /https:\/\/example.com\/\/path/);
  assert.doesNotMatch(stripped, /block/);
  assert.deepEqual(parseJsonc(text), { url: "https://example.com//path", ok: true });
});

test("resolveSessionBinding honors headers then metadata then body", () => {
  assert.deepEqual(
    resolveSessionBinding(
      { "x-accio-conversation-id": "conv_1", "x-session-id": "sess_1" },
      { metadata: { conversation_id: "conv_2", session_id: "sess_2" }, user: "user_1" },
      "openai"
    ),
    { conversationId: "conv_1", sessionId: "sess_1" }
  );

  assert.deepEqual(
    resolveSessionBinding(
      {},
      { metadata: { conversation_id: "conv_meta", session_id: "sess_meta" }, user: "user_2" },
      "openai"
    ),
    { conversationId: "conv_meta", sessionId: "sess_meta" }
  );

  assert.deepEqual(resolveSessionBinding({}, { user: "user_3" }, "openai"), {
    conversationId: null,
    sessionId: "user_3"
  });
});

test("resolveResultError extracts structured message from JSON string payload", () => {
  const result = resolveResultError({
    finalMessage: { metadata: { errorCode: "429" } },
    channelResponse: {
      content: '{"turn_complete":true,"error_code":"429","error_message":"quota exhausted"}'
    }
  });

  assert.equal(result.errorCode, 429);
  assert.equal(result.errorMessage, "quota exhausted");
});
