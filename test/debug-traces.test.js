"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { DebugTraceStore } = require("../src/debug-traces");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "accio-debug-traces-"));
}

test("DebugTraceStore captures errors and sanitizes auth-bearing values", () => {
  const dirPath = makeTempDir();
  const store = new DebugTraceStore({
    dirPath,
    sampleRate: 0,
    maxEntries: 10,
    maxStringLength: 32
  });

  const summary = store.record({
    id: "trace_err_1",
    requestId: "req_1",
    ts: Date.now(),
    durationMs: 42,
    method: "POST",
    path: "/v1/messages",
    protocol: "anthropic",
    statusCode: 401,
    request: {
      headers: {
        authorization: "Bearer secret-token-value",
        "content-type": "application/json"
      },
      body: {
        model: "claude-opus-4-6",
        accessToken: "secret-token-value",
        prompt: "abcdefghijklmnopqrstuvwxyz0123456789"
      }
    },
    response: {
      statusCode: 401,
      headers: {
        "x-request-id": "req_1"
      },
      body: {
        error: {
          message: "unauthorized"
        }
      }
    },
    bridge: {
      requestedModel: "claude-opus-4-6",
      transportSelected: "direct-llm"
    },
    error: {
      message: "unauthorized"
    }
  });

  assert.equal(summary.sampleReason, "error");
  assert.equal(store.list(1)[0].id, "trace_err_1");

  const trace = store.get("trace_err_1");
  assert.equal(trace.request.headers.authorization, "Bearer s***");
  assert.equal(trace.request.body.accessToken, "secret-t***");
  assert.match(trace.request.body.prompt, /truncated/);
});

test("DebugTraceStore only samples successes when forced or sampled", () => {
  const dirPath = makeTempDir();
  const store = new DebugTraceStore({
    dirPath,
    sampleRate: 0,
    maxEntries: 10
  });

  const skipped = store.record({
    id: "trace_ok_1",
    ts: Date.now(),
    durationMs: 10,
    method: "GET",
    path: "/v1/models",
    protocol: "openai",
    statusCode: 200,
    request: { headers: {}, body: null },
    response: { statusCode: 200, headers: {}, body: { ok: true } }
  });

  assert.equal(skipped, null);

  const forced = store.record({
    id: "trace_ok_2",
    ts: Date.now(),
    durationMs: 10,
    method: "POST",
    path: "/v1/chat/completions",
    protocol: "openai",
    statusCode: 200,
    forceCapture: true,
    request: {
      headers: { "content-type": "application/json" },
      body: { model: "claude-opus-4-6", messages: [{ role: "user", content: "hi" }] }
    },
    response: { statusCode: 200, headers: {}, body: { id: "chatcmpl_1" } },
    bridge: { requestedModel: "claude-opus-4-6" }
  });

  assert.equal(forced.sampleReason, "forced");

  const replay = store.buildReplay("trace_ok_2", "http://127.0.0.1:8082");
  assert.equal(replay.method, "POST");
  assert.match(replay.curl, /\/v1\/chat\/completions/);
  assert.match(replay.curl, /content-type: application\/json/);
  assert.equal(replay.replayable, true);
});
