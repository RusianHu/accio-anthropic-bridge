"use strict";

const path = require("node:path");
const { loadEnvFile } = require("./env-file");

loadEnvFile(path.resolve(__dirname, "..", ".env"));

require("./server");
