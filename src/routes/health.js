"use strict";

const fs = require("node:fs");

const { writeJson } = require("../http");
const log = require("../logger");

async function handleHealth(req, res, client, directClient, sessionStore) {
  let auth = null;
  let authDebug = null;
  let directLlm = null;

  try {
    auth = await client.getAuthStatus();
  } catch (error) {
    auth = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    authDebug = await client.getAuthDebugStatus();
  } catch (error) {
    authDebug = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    directLlm = {
      available: await directClient.isAvailable(),
      upstreamBaseUrl: client.config.directLlmBaseUrl,
      transportMode: client.config.transportMode
    };
  } catch (error) {
    directLlm = {
      available: false,
      error: error instanceof Error ? error.message : String(error),
      upstreamBaseUrl: client.config.directLlmBaseUrl,
      transportMode: client.config.transportMode
    };
  }

  const storeExists = fs.existsSync(client.config.sessionStorePath);
  const storeStats = storeExists ? fs.statSync(client.config.sessionStorePath) : null;

  writeJson(res, 200, {
    ok: true,
    auth,
    authDebug,
    directLlm,
    config: {
      baseUrl: client.config.baseUrl,
      directLlmBaseUrl: client.config.directLlmBaseUrl,
      agentId: client.config.agentId,
      transportMode: client.config.transportMode,
      workspacePath: client.config.workspacePath,
      port: client.config.port
    },
    discovery: {
      accioHome: client.config.accioHome,
      accountId: client.config.accountId,
      sourceChannelId: client.config.sourceChannelId,
      sourceChatId: client.config.sourceChatId
    },
    sessions: {
      count: Object.keys(sessionStore.state.sessions || {}).length,
      exists: storeExists,
      path: client.config.sessionStorePath,
      updatedAt: storeStats ? storeStats.mtime.toISOString() : null
    }
  });
}

async function handleAccioAuthProbe(req, res, client, directClient) {
  let auth = null;
  let authDebug = null;
  let directLlmAvailable = false;

  try {
    auth = await client.getAuthStatus();
  } catch (error) {
    auth = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  try {
    authDebug = await client.getAuthDebugStatus();
  } catch (error) {
    authDebug = {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const debugData =
    authDebug &&
    typeof authDebug === "object" &&
    authDebug.success === true &&
    authDebug.data &&
    typeof authDebug.data === "object"
      ? authDebug.data
      : null;
  const fileState = debugData && debugData.file && typeof debugData.file === "object"
    ? debugData.file
    : null;
  const memoryState =
    debugData && debugData.memory && typeof debugData.memory === "object"
      ? debugData.memory
      : null;
  const hasLocalCredentials = Boolean(
    (fileState && fileState.hasCredentials) || (memoryState && memoryState.hasCredentials)
  );
  const hasCookie = Boolean(
    (fileState && fileState.hasCookie) || (memoryState && memoryState.hasCookie)
  );
  const hasTokenPrefix = Boolean(
    (fileState && fileState.accessTokenPrefix) ||
      (memoryState && memoryState.accessTokenPrefix)
  );

  try {
    directLlmAvailable = await directClient.isAvailable();
  } catch (error) {
    log.debug("direct llm availability probe failed", {
      error: error && error.message ? error.message : String(error)
    });
  }

  writeJson(res, 200, {
    ok: true,
    baseUrl: client.config.baseUrl,
    probe: {
      authStatusEndpoint: "/auth/status",
      authDebugEndpoint: "/debug/auth/status",
      uploadProxyEndpoint: "/upload"
    },
    auth,
    authDebug,
    assessment: {
      localGatewayReachable: true,
      hasLocalCredentials,
      hasCookie,
      hasTokenPrefix,
      rawCredentialsExposedOverHttp: true,
      directAuthReuseFeasible: directLlmAvailable,
      note: directLlmAvailable
        ? "Local debug endpoints expose enough auth-bearing data to reuse the desktop login for direct /api/adk/llm calls."
        : "Direct upstream auth reuse is currently unavailable from the local gateway."
    }
  });
}

module.exports = {
  handleAccioAuthProbe,
  handleHealth
};
