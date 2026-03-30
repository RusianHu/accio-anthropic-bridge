"use strict";

const { writeJson } = require("../http");

function handleTracesList(req, res, traceStore, url) {
  const limit = Number(url.searchParams.get("limit") || 20);

  writeJson(res, 200, {
    ok: true,
    traces: traceStore ? traceStore.list(limit) : [],
    summary: traceStore ? traceStore.getSummary() : null
  });
}

function handleTraceDetail(req, res, traceStore, traceId) {
  const trace = traceStore ? traceStore.get(traceId) : null;

  if (!trace) {
    writeJson(res, 404, {
      error: {
        type: "not_found_error",
        message: `Trace ${traceId} was not found`
      }
    });
    return;
  }

  writeJson(res, 200, {
    ok: true,
    trace
  });
}

function handleTraceReplay(req, res, traceStore, traceId, origin) {
  const replay = traceStore ? traceStore.buildReplay(traceId, origin) : null;

  if (!replay) {
    writeJson(res, 404, {
      error: {
        type: "not_found_error",
        message: `Trace ${traceId} was not found`
      }
    });
    return;
  }

  writeJson(res, 200, {
    ok: true,
    replay
  });
}

module.exports = {
  handleTraceDetail,
  handleTraceReplay,
  handleTracesList
};
