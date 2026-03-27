"use strict";

const fs = require("node:fs");
const path = require("node:path");

class SessionStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.state = {
      sessions: {}
    };
    this.load();
  }

  load() {
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(text);

      if (parsed && typeof parsed === "object") {
        this.state.sessions = parsed.sessions || {};
      }
    } catch {}
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  get(sessionId) {
    if (!sessionId) {
      return null;
    }

    const entry = this.state.sessions[sessionId];
    return entry && entry.conversationId ? entry : null;
  }

  set(sessionId, conversationId, extras = {}) {
    if (!sessionId || !conversationId) {
      return null;
    }

    const entry = {
      conversationId,
      updatedAt: new Date().toISOString(),
      ...extras
    };

    this.state.sessions[sessionId] = entry;
    this.save();
    return entry;
  }
}

function readNested(object, keys) {
  let current = object;

  for (const key of keys) {
    if (!current || typeof current !== "object") {
      return undefined;
    }

    current = current[key];
  }

  return current;
}

function resolveSessionBinding(headers, body, protocol) {
  return {
    conversationId:
      headers["x-accio-conversation-id"] ||
      readNested(body, ["metadata", "conversation_id"]) ||
      body.conversation_id ||
      null,
    sessionId:
      headers["x-accio-session-id"] ||
      headers["x-session-id"] ||
      readNested(body, ["metadata", "accio_session_id"]) ||
      readNested(body, ["metadata", "session_id"]) ||
      body.session_id ||
      (protocol === "openai" ? body.user || null : null)
  };
}

module.exports = {
  SessionStore,
  resolveSessionBinding
};
