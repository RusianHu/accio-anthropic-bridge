"use strict";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const minLevel = LEVELS[process.env.LOG_LEVEL || "info"] || LEVELS.info;
const MAX_LOG_ENTRIES = Number(process.env.LOG_BUFFER_MAX || 400) || 400;
const entries = [];
const listeners = new Set();
let sequence = 0;

function cloneEntry(entry) {
  return entry ? JSON.parse(JSON.stringify(entry)) : entry;
}

function recordEntry(entry) {
  entries.push(entry);

  if (entries.length > MAX_LOG_ENTRIES) {
    entries.splice(0, entries.length - MAX_LOG_ENTRIES);
  }

  for (const listener of listeners) {
    try {
      listener(cloneEntry(entry));
    } catch {
      // Ignore listener failures to avoid affecting the main log path.
    }
  }
}

function log(level, message, meta = {}) {
  const numericLevel = LEVELS[level] || LEVELS.info;

  if (numericLevel < minLevel) {
    return;
  }

  const entry = {
    seq: ++sequence,
    ts: new Date().toISOString(),
    level,
    msg: message,
    ...meta
  };
  const stream = numericLevel >= LEVELS.error ? process.stderr : process.stdout;

  recordEntry(entry);
  stream.write(JSON.stringify(entry) + "\n");
}

module.exports = {
  debug: (msg, meta) => log("debug", msg, meta),
  info: (msg, meta) => log("info", msg, meta),
  warn: (msg, meta) => log("warn", msg, meta),
  error: (msg, meta) => log("error", msg, meta),
  getEntries(limit = MAX_LOG_ENTRIES) {
    const size = Math.max(1, Math.min(Number(limit) || MAX_LOG_ENTRIES, MAX_LOG_ENTRIES));
    return entries.slice(-size).map(cloneEntry);
  },
  subscribe(listener) {
    if (typeof listener !== "function") {
      return () => {};
    }

    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }
};
