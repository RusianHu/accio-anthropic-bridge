"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ResponsesStreamWriter } = require("../src/stream/responses-sse");

function createMockResponse() {
  return {
    headersSent: false,
    statusCode: 200,
    headers: null,
    chunks: [],
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
      this.headersSent = true;
    },
    write(chunk) {
      this.chunks.push(String(chunk));
    },
    end(chunk) {
      if (chunk) {
        this.write(chunk);
      }

      this.ended = true;
    }
  };
}

test("ResponsesStreamWriter emits minimal responses SSE lifecycle", () => {
  const res = createMockResponse();
  const writer = new ResponsesStreamWriter({
    body: { model: "claude-opus-4-6" },
    res,
    created: 123,
    id: "resp_1",
    sessionId: "sess_1",
    conversationId: "conv_1",
    messageId: "msg_1"
  });

  const completed = writer.finish({
    text: "hello",
    inputTokens: 10,
    outputTokens: 5,
    sessionId: "sess_1",
    conversationId: "conv_1",
    messageId: "msg_1"
  });
  const output = res.chunks.join("");

  assert.equal(res.headers["content-type"], "text/event-stream; charset=utf-8");
  assert.match(output, /event: response.created/);
  assert.match(output, /event: response.output_text.delta/);
  assert.match(output, /event: response.output_text.done/);
  assert.match(output, /event: response.completed/);
  assert.match(output, /"text":"hello"/);
  assert.equal(completed.status, "completed");
  assert.equal(completed.output_text, "hello");
  assert.equal(completed.accio.session_id, "sess_1");
  assert.equal(res.ended, true);
});

test("ResponsesStreamWriter emits tool items after text item", () => {
  const res = createMockResponse();
  const writer = new ResponsesStreamWriter({
    body: { model: "claude-opus-4-6" },
    res,
    created: 123,
    id: "resp_2",
    sessionId: "sess_2",
    conversationId: "conv_2",
    messageId: "msg_2"
  });

  const completed = writer.finish({
    text: "tool time",
    toolCalls: [{ id: "call_1", name: "lookup_weather", input: { city: "Hangzhou" } }],
    sessionId: "sess_2",
    conversationId: "conv_2",
    messageId: "msg_2"
  });
  const output = res.chunks.join("");

  assert.match(output, /"response_id":"resp_2"/);
  assert.match(output, /"type":"tool_call"/);
  assert.match(output, /"name":"lookup_weather"/);
  assert.equal(completed.output[1].type, "tool_call");
  assert.equal(completed.output[1].id, "call_1");
});
