"use strict";

const fs = require("node:fs");
const path = require("node:path");

function loadAccountsFile(filePath) {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return { strategy: "round_robin", activeAccount: null, accounts: parsed };
    }

    return {
      strategy: parsed && parsed.strategy ? parsed.strategy : "round_robin",
      activeAccount: parsed && parsed.activeAccount ? parsed.activeAccount : null,
      accounts: parsed && Array.isArray(parsed.accounts) ? parsed.accounts : []
    };
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return { strategy: "round_robin", activeAccount: null, accounts: [] };
    }

    throw error;
  }
}

function writeAccountToFile(filePath, accountId, accessToken) {
  const resolvedPath = path.resolve(filePath);
  const state = loadAccountsFile(resolvedPath);
  const accounts = state.accounts.filter((account) => String(account.id || account.accountId) !== String(accountId));

  accounts.push({
    id: String(accountId),
    accessToken: String(accessToken),
    enabled: true,
    source: "gateway-capture"
  });

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  fs.writeFileSync(
    resolvedPath,
    JSON.stringify({ strategy: state.strategy, activeAccount: state.activeAccount, accounts }, null, 2) + "\n",
    "utf8"
  );

  return resolvedPath;
}

module.exports = {
  loadAccountsFile,
  writeAccountToFile
};
