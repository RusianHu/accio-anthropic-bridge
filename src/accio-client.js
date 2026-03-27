"use strict";

const crypto = require("node:crypto");

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class HttpError extends Error {
  constructor(status, message, body) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

class AccioClient {
  constructor(config) {
    this.config = config;
  }

  async requestJson(path, init = {}) {
    const response = await fetch(`${this.config.baseUrl}${path}`, init);
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    const parsed =
      contentType.includes("application/json") && text ? JSON.parse(text) : text;

    if (!response.ok) {
      throw new HttpError(
        response.status,
        `Accio request failed: ${response.status} ${response.statusText}`,
        parsed
      );
    }

    return parsed;
  }

  async getAuthStatus() {
    return this.requestJson("/auth/status");
  }

  async createConversation(name) {
    return this.requestJson("/conversation", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        name,
        type: "dm",
        agentId: this.config.agentId
      })
    });
  }

  buildSource() {
    return {
      platform: this.config.sourcePlatform,
      type: this.config.sourceType,
      channelId: this.config.sourceChannelId,
      chatId: this.config.sourceChatId,
      userId: this.config.sourceUserId,
      chatType: this.config.sourceChatType,
      isAuthorized: true,
      wasMentioned: false
    };
  }

  buildSendQueryPayload(input) {
    return {
      type: "req",
      method: "sendQuery",
      params: {
        conversationId: input.conversationId,
        chatType: "direct",
        question: {
          query: input.query
        },
        path: input.workspacePath || this.config.workspacePath,
        agentId: this.config.agentId,
        targetAgentList: [
          {
            agentId: this.config.agentId,
            isTL: true
          }
        ],
        skills: [],
        language: this.config.language,
        ts: Date.now(),
        extra: {},
        source: this.buildSource(),
        ...(input.model ? { model: input.model } : {}),
        atIds: []
      }
    };
  }

  async runQuery(input) {
    const conversationId = input.conversationId;
    const clientId = `${this.config.clientIdPrefix}-${crypto.randomUUID()}`;
    const payload = this.buildSendQueryPayload({
      conversationId,
      query: input.query,
      workspacePath: input.workspacePath,
      model: input.model
    });

    const wsUrl =
      this.config.baseUrl.replace(/^http/, "ws") +
      `/websocket/connect?clientId=${encodeURIComponent(clientId)}`;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const state = {
        ack: null,
        finalMessage: null,
        finalText: "",
        messageId: null,
        uniqueId: null,
        textSnapshot: "",
        appendEvents: [],
        channelResponse: null
      };

      let settled = false;
      let finishTimer = null;
      const timeout = setTimeout(() => {
        finalize(new Error(`Accio request timed out after ${this.config.requestTimeoutMs}ms`));
      }, this.config.requestTimeoutMs);

      const cleanup = () => {
        clearTimeout(timeout);
        clearTimeout(finishTimer);
        try {
          ws.close();
        } catch {}
      };

      const finalize = (error, result) => {
        if (settled) {
          return;
        }

        settled = true;
        cleanup();

        if (error) {
          reject(error);
          return;
        }

        resolve(result);
      };

      const maybeScheduleFinish = () => {
        if (!state.finalMessage) {
          return;
        }

        clearTimeout(finishTimer);
        finishTimer = setTimeout(() => {
          finalize(null, {
            ack: state.ack,
            channelResponse: state.channelResponse,
            finalMessage: state.finalMessage,
            finalText: state.finalText,
            messageId: state.messageId,
            uniqueId: state.uniqueId
          });
        }, 150);
      };

      ws.addEventListener("open", () => {
        ws.send(JSON.stringify(payload));
      });

      ws.addEventListener("error", (event) => {
        finalize(new Error(event.message || "Accio WebSocket error"));
      });

      ws.addEventListener("close", () => {
        if (!settled && !state.finalMessage) {
          finalize(new Error("Accio WebSocket closed before the request finished"));
        }
      });

      ws.addEventListener("message", (event) => {
        let message;

        try {
          message = JSON.parse(String(event.data));
        } catch (error) {
          finalize(error);
          return;
        }

        if (message.type === "ack") {
          state.ack = message.payload;
          state.messageId = message.payload && message.payload.messageId;
          state.uniqueId = message.payload && message.payload.uniqueId;

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "ack",
              payload: message.payload
            });
          }

          return;
        }

        if (message.type === "event" && message.method === "append") {
          const nextSnapshot = (message.payload && message.payload.content) || "";
          let delta = nextSnapshot;

          if (nextSnapshot.startsWith(state.textSnapshot)) {
            delta = nextSnapshot.slice(state.textSnapshot.length);
          }

          state.textSnapshot = nextSnapshot;
          state.appendEvents.push(message.payload);

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "append",
              payload: message.payload,
              delta
            });
          }

          return;
        }

        if (message.type === "event" && message.method === "finished") {
          state.finalMessage = message.payload;
          state.finalText = (message.payload && message.payload.content) || state.textSnapshot;
          state.messageId = state.messageId || (message.payload && message.payload.messageId);
          state.uniqueId = state.uniqueId || (message.payload && message.payload.uniqueId);

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "finished",
              payload: message.payload
            });
          }

          maybeScheduleFinish();
          return;
        }

        if (
          message.type === "channel.message.created" &&
          message.data &&
          message.data.conversationId === conversationId &&
          message.data.role === "res"
        ) {
          state.channelResponse = message.data;

          if (typeof input.onEvent === "function") {
            input.onEvent({
              type: "channel.message.created",
              payload: message.data
            });
          }

          if (state.finalMessage) {
            clearTimeout(finishTimer);
            finalize(null, {
              ack: state.ack,
              channelResponse: state.channelResponse,
              finalMessage: state.finalMessage,
              finalText: state.finalText || message.data.content || "",
              messageId: state.messageId,
              uniqueId: state.uniqueId
            });
          }
        }
      });
    });
  }

  async executeQuery(input) {
    let conversationId = input.conversationId;

    if (!conversationId) {
      const title = (input.title || input.query || "Bridge Request").slice(0, 48);
      const created = await this.createConversation(title);
      conversationId = created.data.id;
    }

    return this.runQuery({
      conversationId,
      model: input.model,
      onEvent: input.onEvent,
      query: input.query,
      workspacePath: input.workspacePath
    });
  }
}

module.exports = {
  AccioClient,
  HttpError,
  delay
};
