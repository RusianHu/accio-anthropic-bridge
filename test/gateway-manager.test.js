"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { GatewayManager } = require("../src/gateway-manager");

function createJsonResponse(payload, status = 200, statusText = "OK") {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    async text() {
      return JSON.stringify(payload);
    }
  };
}

test("GatewayManager returns token from running gateway without launching app", async () => {
  let launchCount = 0;
  const manager = new GatewayManager({
    baseUrl: "http://127.0.0.1:4097",
    autostartEnabled: true,
    processCheckImpl: async () => true,
    fetchImpl: async () =>
      createJsonResponse({
        data: {
          phoenix: {
            url: "wss://example.test/ws?accessToken=token_live"
          }
        }
      }),
    launchAppImpl: async () => {
      launchCount += 1;
    }
  });

  const result = await manager.resolveAccessToken({ allowAutostart: true });

  assert.equal(result.token, "token_live");
  assert.equal(result.launchedApp, false);
  assert.equal(launchCount, 0);
});

test("GatewayManager autostarts Accio, waits for token, and keeps Accio running", async () => {
  let attempts = 0;
  let launchCount = 0;
  const manager = new GatewayManager({
    baseUrl: "http://127.0.0.1:4097",
    autostartEnabled: true,
    waitMs: 50,
    pollMs: 1,
    processCheckImpl: async () => true,
    fetchImpl: async (url) => {
      attempts += 1;

      if (attempts === 1) {
        throw new Error("connect ECONNREFUSED");
      }

      if (String(url).endsWith("/debug/auth/ws-status")) {
        return createJsonResponse({
          data: {
            phoenix: {
              url: "wss://example.test/ws?accessToken=token_after_launch"
            }
          }
        });
      }

      return createJsonResponse({ authenticated: true, user: { id: "acct_1" } });
    },
    launchAppImpl: async () => {
      launchCount += 1;
    }
  });

  const result = await manager.resolveAccessToken({ allowAutostart: true });

  assert.equal(result.token, "token_after_launch");
  assert.equal(result.launchedApp, true);
  assert.equal(result.quitAfterCapture, false);
  assert.equal(launchCount, 1);
});

test("GatewayManager does not autostart when allowAutostart is false", async () => {
  const manager = new GatewayManager({
    baseUrl: "http://127.0.0.1:4097",
    autostartEnabled: true,
    processCheckImpl: async () => false,
    fetchImpl: async () => {
      throw new Error("connect ECONNREFUSED");
    }
  });

  await assert.rejects(
    () => manager.resolveAccessToken({ allowAutostart: false }),
    /ECONNREFUSED/
  );
});
