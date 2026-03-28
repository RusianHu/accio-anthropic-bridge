"use strict";

const CORS_HEADERS = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type,authorization,x-api-key,anthropic-version,x-accio-session-id,x-accio-conversation-id,x-session-id",
  "access-control-allow-methods": "GET,POST,OPTIONS"
});

function writeJson(res, statusCode, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    ...CORS_HEADERS,
    ...extraHeaders,
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload)
  });
  res.end(payload);
}

function writeSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

module.exports = {
  CORS_HEADERS,
  writeJson,
  writeSse
};
