"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { discoverAccioAppPath } = require("../src/discovery");

test("discoverAccioAppPath returns explicit existing path", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "accio-app-discovery-"));
  const appPath = path.join(tempDir, "Accio.app");
  fs.mkdirSync(appPath);

  assert.equal(discoverAccioAppPath(appPath), appPath);
});
