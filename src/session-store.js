"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const log = require("./logger");

const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SAVE_DEBOUNCE_MS = 500;

class SessionStore {
  constructor(filePath, options = {}) {
    this.filePath = filePath;
    this.maxAgeMs = options.maxAgeMs || DEFAULT_MAX_AGE_MS;
    this.state = {
      sessions: {}
    };
    this._saveTimer = null;
    this._pendingWrite = Promise.resolve();
    this.load();
  }

  load() {
    try {
      const text = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(text);

      if (parsed && typeof parsed === "object") {
        this.state.sessions = parsed.sessions || {};
      }
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        log.debug("session store load skipped", {
          path: this.filePath,
          error: error.message || String(error)
        });
      }
    }

    this._purgeExpired();
  }

  _purgeExpired() {
    const now = Date.now();
    const sessions = this.state.sessions;
    let changed = false;

    for (const key of Object.keys(sessions)) {
      const entry = sessions[key];

      if (!entry || !entry.updatedAt) {
        delete sessions[key];
        changed = true;
        continue;
      }

      const age = now - Date.parse(entry.updatedAt);

      if (age > this.maxAgeMs) {
        delete sessions[key];
        changed = true;
      }
    }

    if (changed) {
      this._scheduleSave();
    }
  }

  _scheduleSave() {
    if (this._saveTimer) {
      return;
    }

    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this._pendingWrite = this._pendingWrite
        .then(() => this._saveAsync())
        .catch((error) => {
          log.warn("session store async save failed", {
            path: this.filePath,
            error: error && error.message ? error.message : String(error)
          });
        });
    }, SAVE_DEBOUNCE_MS);
  }

  async _saveAsync() {
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(this.filePath, JSON.stringify(this.state, null, 2));
  }

  _saveSync() {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
    } catch (error) {
      log.warn("session store sync flush failed", {
        path: this.filePath,
        error: error && error.message ? error.message : String(error)
      });
    }
  }

  save() {
    this._scheduleSave();
  }

  flushSync() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveTimer = null;
    }

    this._saveSync();
  }

  get(sessionId) {
    if (!sessionId) {
      return null;
    }

    const entry = this.state.sessions[sessionId];

    if (!entry || !entry.conversationId) {
      return null;
    }

    if (entry.updatedAt && Date.now() - Date.parse(entry.updatedAt) > this.maxAgeMs) {
      delete this.state.sessions[sessionId];
      this.save();
      return null;
    }

    return entry;
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
