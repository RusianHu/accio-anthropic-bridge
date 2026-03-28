"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL || "info"] || LEVELS.info;

function log(level, message, meta = {}) {
  const numericLevel = LEVELS[level] || LEVELS.info;

  if (numericLevel < minLevel) {
    return;
  }

  const entry = {
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta
  };
  const stream = numericLevel >= LEVELS.error ? process.stderr : process.stdout;

  stream.write(JSON.stringify(entry) + "\n");
}

module.exports = {
  debug: (msg, meta) => log("debug", msg, meta),
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta)
};
