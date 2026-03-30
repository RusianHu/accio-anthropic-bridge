#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

const { loadEnvFile } = require("../src/env-file");
const { discoverAccioAppPath } = require("../src/discovery");
const { GatewayManager } = require("../src/gateway-manager");
const { snapshotActiveCredentials, sanitizeAlias } = require("../src/auth-state");

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(__dirname, "..");

loadEnvFile(path.join(REPO_ROOT, ".env"));

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function parseArgs(argv) {
  const args = {
    json: argv.includes("--json"),
    noOpen: argv.includes("--no-open"),
    skipLogout: argv.includes("--skip-logout"),
    writeFile: argv.includes("--write-file"),
    snapshotAlias: env("ACCIO_AUTH_SNAPSHOT_ALIAS", ""),
    accountId: env("ACCIO_AUTH_ACCOUNT_ID", env("ACCIO_ACCOUNT_ID", "captured-gateway")),
    timeoutMs: Number(env("ACCIO_RELOGIN_TIMEOUT_MS", "180000")),
    pollMs: Number(env("ACCIO_RELOGIN_POLL_MS", "1000"))
  };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--account-id" && argv[index + 1]) {
      args.accountId = argv[index + 1];
      index += 1;
      continue;
    }

    if (argv[index] === "--snapshot-alias" && argv[index + 1]) {
      args.snapshotAlias = argv[index + 1];
      index += 1;
      continue;
    }

    if (argv[index] === "--timeout-ms" && argv[index + 1]) {
      args.timeoutMs = Number(argv[index + 1]);
      index += 1;
      continue;
    }

    if (argv[index] === "--poll-ms" && argv[index + 1]) {
      args.pollMs = Number(argv[index + 1]);
      index += 1;
    }
  }

  return args;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function maskToken(token) {
  if (!token) {
    return "***";
  }

  return token.length > 8 ? `${token.slice(0, 8)}***` : "***";
}

async function openUrl(url) {
  if (process.platform === "darwin") {
    await execFileAsync("open", [url]);
    return;
  }

  if (process.platform === "win32") {
    await execFileAsync("cmd", ["/c", "start", "", url]);
    return;
  }

  await execFileAsync("xdg-open", [url]);
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || "GET",
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Number(options.timeoutMs || 5000))
  });
  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    const error = new Error(
      `Gateway request failed for ${options.method || "GET"} ${pathname}: ${response.status}`
    );
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function extractUserId(authPayload) {
  if (!authPayload || typeof authPayload !== "object") {
    return null;
  }

  if (authPayload.user && authPayload.user.id) {
    return String(authPayload.user.id);
  }

  if (authPayload.data && authPayload.data.user && authPayload.data.user.id) {
    return String(authPayload.data.user.id);
  }

  if (authPayload.data && authPayload.data.id) {
    return String(authPayload.data.id);
  }

  return null;
}

async function captureTokenToFile(accountId) {
  const gatewayManager = new GatewayManager({
    baseUrl: env("ACCIO_BASE_URL", "http://127.0.0.1:4097"),
    appPath: discoverAccioAppPath(env("ACCIO_APP_PATH", "")),
    autostartEnabled: env("ACCIO_GATEWAY_AUTOSTART", "1"),
    waitMs: Number(env("ACCIO_GATEWAY_WAIT_MS", "20000")),
    pollMs: Number(env("ACCIO_GATEWAY_POLL_MS", "500"))
  });
  const result = await gatewayManager.waitForGatewayToken();
  const filePath = path.resolve(
    env(
      "ACCIO_ACCOUNTS_CONFIG_PATH",
      env("ACCIO_ACCOUNTS_PATH", path.join(REPO_ROOT, "config", "accounts.json"))
    )
  );
  const { spawn } = require("node:child_process");

  await new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(REPO_ROOT, "scripts", "capture-token.js"), "--write-file", "--account-id", accountId, "--json"],
      {
        cwd: REPO_ROOT,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr || stdout || `capture-token exited with code ${code}`));
    });
  });

  return {
    accountsPath: filePath,
    tokenPreview: maskToken(result.token)
  };
}

function snapshotCurrentLogin(alias, authenticatedUser) {
  const safeAlias = sanitizeAlias(alias);
  const result = snapshotActiveCredentials(safeAlias, {
    gatewayUser: authenticatedUser || null
  });

  return {
    alias: result.alias,
    dir: result.dir,
    kind: result.metadata.kind,
    capturedAt: result.metadata.capturedAt
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const baseUrl = String(env("ACCIO_BASE_URL", "http://127.0.0.1:4097")).replace(/\/$/, "");
  const initialStatus = await requestJson(baseUrl, "/auth/status", { timeoutMs: 4000 });
  const previousUserId = extractUserId(initialStatus);

  if (!args.skipLogout) {
    await requestJson(baseUrl, "/auth/logout", {
      method: "POST",
      body: {},
      timeoutMs: 8000
    });
  }

  const loginPayload = await requestJson(baseUrl, "/auth/login", {
    method: "POST",
    body: {},
    timeoutMs: 8000
  });
  const loginUrl = loginPayload && loginPayload.loginUrl ? String(loginPayload.loginUrl) : null;

  if (!loginUrl) {
    throw new Error("Gateway did not return loginUrl");
  }

  if (!args.noOpen) {
    await openUrl(loginUrl);
  }

  const startedAt = Date.now();
  let authenticatedUser = null;

  while (Date.now() - startedAt < args.timeoutMs) {
    try {
      const authStatus = await requestJson(baseUrl, "/auth/status", { timeoutMs: 3000 });
      const authenticated = Boolean(authStatus && authStatus.authenticated);
      const userId = extractUserId(authStatus);

      if (authenticated && userId && (!previousUserId || userId !== previousUserId || args.skipLogout)) {
        const authUser = await requestJson(baseUrl, "/auth/user", { timeoutMs: 3000 });
        authenticatedUser = authUser && authUser.data ? authUser.data : authStatus.user || null;
        break;
      }
    } catch (error) {
      // Ignore transient auth polling failures while waiting for callback.
    }

    await sleep(args.pollMs);
  }

  if (!authenticatedUser) {
    const timeoutError = new Error(`Timed out waiting for Accio login callback after ${args.timeoutMs}ms`);
    timeoutError.loginUrl = loginUrl;
    timeoutError.previousUserId = previousUserId;
    throw timeoutError;
  }

  let capture = null;
  let snapshot = null;

  if (args.snapshotAlias) {
    snapshot = snapshotCurrentLogin(args.snapshotAlias, authenticatedUser);
  }

  if (args.writeFile) {
    capture = await captureTokenToFile(args.accountId);
  }

  const output = {
    ok: true,
    loginUrl,
    previousUserId,
    currentUser: authenticatedUser,
    wroteAccount: Boolean(capture),
    snapshotAlias: snapshot ? snapshot.alias : null,
    snapshotDir: snapshot ? snapshot.dir : null,
    snapshotKind: snapshot ? snapshot.kind : null,
    accountId: capture ? args.accountId : null,
    accountsPath: capture ? capture.accountsPath : null,
    tokenPreview: capture ? capture.tokenPreview : null
  };

  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    return;
  }

  process.stdout.write(`Login completed for user ${authenticatedUser.id || "unknown"}.\n`);

  if (capture) {
    process.stdout.write(`Updated ${capture.accountsPath} for ${args.accountId} (${capture.tokenPreview}).\n`);
  } else {
    process.stdout.write("Re-run with --write-file to persist the refreshed gateway token into accounts.json.\n");
  }

  if (snapshot) {
    process.stdout.write(`Saved auth snapshot ${snapshot.alias} (${snapshot.kind}) at ${snapshot.dir}.\n`);
  }
}

main().catch((error) => {
  if (error && error.loginUrl) {
    process.stderr.write(`loginUrl: ${error.loginUrl}\n`);
  }

  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
