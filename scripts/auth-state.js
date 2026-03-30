#!/usr/bin/env node
"use strict";

const path = require("node:path");

const { loadEnvFile } = require("../src/env-file");
const {
  detectActiveStorage,
  readGatewayState,
  listSnapshots,
  snapshotActiveCredentials,
  activateSnapshot,
  getSnapshotRoot
} = require("../src/auth-state");

const REPO_ROOT = path.resolve(__dirname, "..");
loadEnvFile(path.join(REPO_ROOT, ".env"));

function usage() {
  process.stdout.write(
    [
      "Usage:",
      "  node scripts/auth-state.js status",
      "  node scripts/auth-state.js list",
      "  node scripts/auth-state.js snapshot <alias>",
      "  node scripts/auth-state.js activate <alias>",
      "",
      "Options:",
      "  --json   Output machine-readable JSON"
    ].join("\n") + "\n"
  );
}

function parseArgs(argv) {
  return {
    json: argv.includes("--json"),
    command: argv.find((item) => !item.startsWith("--")) || null,
    alias: argv.filter((item) => !item.startsWith("--"))[1] || null
  };
}

function print(value, asJson) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }

  if (typeof value === "string") {
    process.stdout.write(`${value}\n`);
    return;
  }

  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function commandStatus(asJson) {
  const storage = detectActiveStorage();
  const gateway = await readGatewayState();
  const output = {
    ok: true,
    snapshotRoot: getSnapshotRoot(),
    storage,
    gateway,
    snapshotCount: listSnapshots().length
  };

  if (asJson) {
    print(output, true);
    return;
  }

  const lines = [
    `Snapshot root: ${output.snapshotRoot}`,
    `Encrypted auth: ${storage.encryptedExists ? "present" : "missing"} (${storage.encryptedPath})`,
    `Plaintext auth: ${storage.plaintextExists ? "present" : "missing"} (${storage.plaintextPath})`,
    `Preferred active storage: ${storage.kind || "none"}`,
    `Saved snapshots: ${output.snapshotCount}`
  ];

  if (gateway.reachable) {
    lines.push(
      `Gateway: reachable at ${gateway.baseUrl}, authenticated=${gateway.authenticated ? "yes" : "no"}`
    );
    if (gateway.user && gateway.user.id) {
      lines.push(`Gateway user: ${gateway.user.id}${gateway.user.name ? ` (${gateway.user.name})` : ""}`);
    }
  } else {
    lines.push(`Gateway: unreachable at ${gateway.baseUrl}${gateway.error ? ` (${gateway.error})` : ""}`);
  }

  print(lines.join("\n"), false);
}

function commandList(asJson) {
  const snapshots = listSnapshots().map((entry) => ({
    alias: entry.alias,
    kind: entry.kind,
    capturedAt: entry.metadata && entry.metadata.capturedAt ? entry.metadata.capturedAt : null,
    gatewayUser: entry.metadata && entry.metadata.gatewayUser ? entry.metadata.gatewayUser : null,
    dir: entry.dir
  }));

  if (asJson) {
    print({ ok: true, snapshots }, true);
    return;
  }

  if (snapshots.length === 0) {
    print("No auth snapshots found.", false);
    return;
  }

  const lines = snapshots.map((entry) => {
    const user = entry.gatewayUser && entry.gatewayUser.id
      ? ` user=${entry.gatewayUser.id}${entry.gatewayUser.name ? `(${entry.gatewayUser.name})` : ""}`
      : "";
    return `${entry.alias}: kind=${entry.kind || "unknown"} capturedAt=${entry.capturedAt || "unknown"}${user}`;
  });

  print(lines.join("\n"), false);
}

async function commandSnapshot(alias, asJson) {
  if (!alias) {
    throw new Error("Snapshot alias is required");
  }

  const gateway = await readGatewayState();
  const result = snapshotActiveCredentials(alias, {
    gatewayUser: gateway.user || null
  });
  const output = {
    ok: true,
    alias: result.alias,
    dir: result.dir,
    kind: result.metadata.kind,
    capturedAt: result.metadata.capturedAt,
    gateway
  };

  if (asJson) {
    print(output, true);
    return;
  }

  print(
    [
      `Saved auth snapshot '${output.alias}' to ${output.dir}`,
      `Kind: ${output.kind}`,
      gateway.user && gateway.user.id
        ? `Gateway user at capture time: ${gateway.user.id}${gateway.user.name ? ` (${gateway.user.name})` : ""}`
        : gateway.reachable
          ? `Gateway authenticated: ${gateway.authenticated ? "yes" : "no"}`
          : `Gateway unreachable: ${gateway.error || gateway.baseUrl}`
    ].join("\n"),
    false
  );
}

async function commandActivate(alias, asJson) {
  if (!alias) {
    throw new Error("Snapshot alias is required");
  }

  const result = activateSnapshot(alias);
  const gateway = await readGatewayState();
  const output = {
    ok: true,
    alias: result.alias,
    kind: result.kind,
    destination: result.destination,
    gateway,
    note: gateway.reachable
      ? "Gateway is still running. Restart Accio or the local gateway before expecting the restored login state to take effect."
      : "Snapshot restored to disk. Start Accio or let the bridge autostart it when needed."
  };

  if (asJson) {
    print(output, true);
    return;
  }

  print(
    [
      `Activated auth snapshot '${output.alias}' -> ${output.destination}`,
      `Kind: ${output.kind}`,
      output.note
    ].join("\n"),
    false
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  switch (args.command) {
    case "status":
      await commandStatus(args.json);
      return;
    case "list":
      commandList(args.json);
      return;
    case "snapshot":
      await commandSnapshot(args.alias, args.json);
      return;
    case "activate":
      await commandActivate(args.alias, args.json);
      return;
    case null:
    case "help":
    case "--help":
    case "-h":
      usage();
      return;
    default:
      throw new Error(`Unknown command: ${args.command}`);
  }
}

main().catch((error) => {
  const payload = {
    ok: false,
    error: error && error.message ? error.message : String(error)
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exitCode = 1;
});
