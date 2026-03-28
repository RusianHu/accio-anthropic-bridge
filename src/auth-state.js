"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function env(name, fallback) {
  return Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : fallback;
}

function getRepoRoot() {
  return path.resolve(__dirname, "..");
}

function getSnapshotRoot() {
  return path.resolve(
    env("ACCIO_AUTH_SNAPSHOT_DIR", path.join(getRepoRoot(), ".data", "auth-snapshots"))
  );
}

function getUserDataDir() {
  const configured = String(env("ACCIO_USER_DATA_DIR", "")).trim();

  if (configured) {
    return path.resolve(configured);
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Accio");
  }

  if (process.platform === "win32") {
    return path.join(env("APPDATA", path.join(os.homedir(), "AppData", "Roaming")), "Accio");
  }

  return path.join(env("XDG_CONFIG_HOME", path.join(os.homedir(), ".config")), "Accio");
}

function getLegacyConfigDir() {
  return path.join(os.homedir(), ".config", "accio");
}

function getEncryptedCredentialsPath() {
  return path.join(getUserDataDir(), "credentials.enc");
}

function getPlaintextCredentialsPath() {
  return path.join(getLegacyConfigDir(), "credentials.json");
}

function sanitizeAlias(alias) {
  const value = String(alias || "").trim();

  if (!value) {
    throw new Error("Snapshot alias is required");
  }

  const safe = value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

  if (!safe) {
    throw new Error(`Invalid snapshot alias: ${alias}`);
  }

  return safe;
}

function detectActiveStorage() {
  const encryptedPath = getEncryptedCredentialsPath();
  const plaintextPath = getPlaintextCredentialsPath();
  const encryptedExists = fs.existsSync(encryptedPath);
  const plaintextExists = fs.existsSync(plaintextPath);
  const kind = encryptedExists ? "encrypted" : plaintextExists ? "plaintext" : null;
  const sourcePath = kind === "encrypted" ? encryptedPath : kind === "plaintext" ? plaintextPath : null;

  return {
    userDataDir: getUserDataDir(),
    legacyConfigDir: getLegacyConfigDir(),
    encryptedPath,
    plaintextPath,
    encryptedExists,
    plaintextExists,
    kind,
    sourcePath
  };
}

function getSnapshotDir(alias) {
  return path.join(getSnapshotRoot(), sanitizeAlias(alias));
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }

    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

async function readGatewayState(baseUrl = env("ACCIO_BASE_URL", "http://127.0.0.1:4097")) {
  const normalized = String(baseUrl).replace(/\/$/, "");

  try {
    const response = await fetch(`${normalized}/auth/status`, {
      signal: AbortSignal.timeout(3000)
    });

    if (!response.ok) {
      return {
        reachable: true,
        authenticated: false,
        baseUrl: normalized,
        status: response.status,
        user: null
      };
    }

    const payload = await response.json();
    return {
      reachable: true,
      authenticated: Boolean(payload && payload.authenticated),
      baseUrl: normalized,
      status: response.status,
      user: payload && payload.user ? payload.user : null
    };
  } catch (error) {
    return {
      reachable: false,
      authenticated: false,
      baseUrl: normalized,
      status: null,
      user: null,
      error: error && error.message ? error.message : String(error)
    };
  }
}

function listSnapshots() {
  const root = getSnapshotRoot();

  if (!fs.existsSync(root)) {
    return [];
  }

  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const dir = path.join(root, entry.name);
      const metadata = readJsonIfExists(path.join(dir, "metadata.json"));
      const encryptedPath = path.join(dir, "credentials.enc");
      const plaintextPath = path.join(dir, "credentials.json");

      return {
        alias: entry.name,
        dir,
        metadata,
        kind: fs.existsSync(encryptedPath) ? "encrypted" : fs.existsSync(plaintextPath) ? "plaintext" : null,
        encryptedPath,
        plaintextPath
      };
    })
    .sort((left, right) => left.alias.localeCompare(right.alias));
}

function snapshotActiveCredentials(alias, extras = {}) {
  const safeAlias = sanitizeAlias(alias);
  const active = detectActiveStorage();

  if (!active.kind || !active.sourcePath) {
    throw new Error("No active Accio credentials file found to snapshot");
  }

  const targetDir = getSnapshotDir(safeAlias);
  fs.mkdirSync(targetDir, { recursive: true });

  const targetPath = path.join(
    targetDir,
    active.kind === "encrypted" ? "credentials.enc" : "credentials.json"
  );

  fs.copyFileSync(active.sourcePath, targetPath);
  fs.chmodSync(targetPath, 0o600);

  const metadata = {
    alias: safeAlias,
    capturedAt: new Date().toISOString(),
    kind: active.kind,
    sourcePath: active.sourcePath,
    gatewayUser: extras.gatewayUser || null,
    notes: extras.notes || null
  };

  fs.writeFileSync(path.join(targetDir, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, {
    mode: 0o600
  });

  return {
    alias: safeAlias,
    dir: targetDir,
    metadata,
    targetPath
  };
}

function activateSnapshot(alias) {
  const safeAlias = sanitizeAlias(alias);
  const dir = getSnapshotDir(safeAlias);
  const metadata = readJsonIfExists(path.join(dir, "metadata.json"));
  const encryptedSource = path.join(dir, "credentials.enc");
  const plaintextSource = path.join(dir, "credentials.json");
  const kind = fs.existsSync(encryptedSource) ? "encrypted" : fs.existsSync(plaintextSource) ? "plaintext" : null;

  if (!kind) {
    throw new Error(`Snapshot not found or missing payload for alias: ${safeAlias}`);
  }

  const active = detectActiveStorage();
  const destination = kind === "encrypted" ? active.encryptedPath : active.plaintextPath;
  const source = kind === "encrypted" ? encryptedSource : plaintextSource;
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  fs.chmodSync(destination, 0o600);

  const opposite = kind === "encrypted" ? active.plaintextPath : active.encryptedPath;
  if (fs.existsSync(opposite)) {
    fs.rmSync(opposite, { force: true });
  }

  return {
    alias: safeAlias,
    kind,
    metadata,
    source,
    destination,
    removedOpposite: fs.existsSync(opposite) ? opposite : null,
    active
  };
}

module.exports = {
  detectActiveStorage,
  readGatewayState,
  listSnapshots,
  snapshotActiveCredentials,
  activateSnapshot,
  sanitizeAlias,
  getSnapshotRoot,
  getEncryptedCredentialsPath,
  getPlaintextCredentialsPath,
  getUserDataDir,
  getLegacyConfigDir
};
