"use strict";

const fs = require("node:fs");
const path = require("node:path");

const log = require("./logger");

const INVALIDATION_MS = 5 * 60 * 1000;

function normalizeMode(mode) {
  const value = String(mode || "auto").trim().toLowerCase();
  return ["auto", "gateway", "env", "file"].includes(value) ? value : "auto";
}

function normalizeStrategy(strategy) {
  const value = String(strategy || "round_robin").trim().toLowerCase();
  return ["round_robin", "random", "fixed"].includes(value) ? value : "round_robin";
}

function parseJsonFile(filePath) {
  const text = fs.readFileSync(filePath, "utf8");
  return JSON.parse(text);
}

class AuthProvider {
  constructor(config) {
    this.config = config;
    this.mode = normalizeMode(config.authMode);
    this.strategy = normalizeStrategy(config.authStrategy);
    this._rrIndex = 0;
    this._invalidAccounts = new Map();
  }

  _resolveAccountsPath() {
    return path.resolve(this.config.accountsPath || path.join(process.cwd(), "config", "accounts.json"));
  }

  _normalizeAccount(account) {
    if (!account || typeof account !== "object" || !account.accessToken) {
      return null;
    }

    return {
      id: String(account.id || account.accountId || `acct_${Math.random().toString(36).slice(2, 10)}`),
      accessToken: String(account.accessToken),
      enabled: account.enabled !== false,
      expiresAt: Number(account.expiresAt || 0) || null,
      source: account.source || "file"
    };
  }

  _loadFileAccounts() {
    const filePath = this._resolveAccountsPath();

    try {
      const parsed = parseJsonFile(filePath);
      const rawAccounts = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.accounts) ? parsed.accounts : [];
      const strategy = Array.isArray(parsed) ? this.strategy : normalizeStrategy(parsed && parsed.strategy);
      const accounts = rawAccounts.map((account) => this._normalizeAccount(account)).filter(Boolean);

      return {
        strategy,
        accounts,
        filePath,
        ok: true
      };
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        log.debug("auth provider file load failed", {
          filePath,
          error: error.message || String(error)
        });
      }

      return {
        strategy: this.strategy,
        accounts: [],
        filePath,
        ok: false
      };
    }
  }

  _loadEnvAccounts() {
    const accessToken = String(this.config.accessToken || "").trim();

    if (!accessToken) {
      return [];
    }

    return [
      {
        id: String(this.config.envAccountId || "env-default"),
        accessToken,
        enabled: true,
        expiresAt: Number(this.config.accessTokenExpiresAt || 0) || null,
        source: "env"
      }
    ];
  }

  _isAccountUsable(account) {
    if (!account || !account.enabled || !account.accessToken) {
      return false;
    }

    if (account.expiresAt && account.expiresAt <= Date.now()) {
      return false;
    }

    const invalidUntil = this._invalidAccounts.get(account.id) || 0;
    return invalidUntil <= Date.now();
  }

  _pickAccount(accounts, requestedAccountId) {
    if (requestedAccountId) {
      return accounts.find((account) => account.id === requestedAccountId) || null;
    }

    if (accounts.length === 0) {
      return null;
    }

    const strategy = normalizeStrategy(this._fileStrategy || this.strategy);

    if (strategy === "fixed") {
      return accounts[0];
    }

    if (strategy === "random") {
      return accounts[Math.floor(Math.random() * accounts.length)] || null;
    }

    const account = accounts[this._rrIndex % accounts.length] || null;
    this._rrIndex = (this._rrIndex + 1) % Math.max(1, accounts.length);
    return account;
  }

  getExternalAccounts() {
    if (this.mode === "file" || this.mode === "auto") {
      const fileState = this._loadFileAccounts();
      this._fileStrategy = fileState.strategy;
      const fileAccounts = fileState.accounts.filter((account) => this._isAccountUsable(account));

      if (fileAccounts.length > 0 || this.mode === "file") {
        return fileAccounts;
      }
    }

    if (this.mode === "env" || this.mode === "auto") {
      return this._loadEnvAccounts().filter((account) => this._isAccountUsable(account));
    }

    return [];
  }

  resolveCredential(options = {}) {
    const requestedAccountId = options.accountId ? String(options.accountId) : null;
    const excludeIds = new Set(Array.isArray(options.excludeIds) ? options.excludeIds : []);
    const candidates = this.getExternalAccounts().filter((account) => !excludeIds.has(account.id));
    const account = this._pickAccount(candidates, requestedAccountId);

    return account
      ? {
          accountId: account.id,
          token: account.accessToken,
          source: account.source
        }
      : null;
  }

  invalidateAccount(accountId) {
    if (!accountId) {
      return;
    }

    this._invalidAccounts.set(String(accountId), Date.now() + INVALIDATION_MS);
  }

  clearInvalidation(accountId) {
    if (!accountId) {
      return;
    }

    this._invalidAccounts.delete(String(accountId));
  }

  getSummary() {
    const fileState = this._loadFileAccounts();
    const envAccounts = this._loadEnvAccounts();

    return {
      mode: this.mode,
      strategy: normalizeStrategy(fileState.strategy || this.strategy),
      accountsPath: fileState.filePath,
      fileAccounts: fileState.accounts.map((account) => account.id),
      envAccounts: envAccounts.map((account) => account.id),
      activeExternalAccounts: this.getExternalAccounts().map((account) => account.id)
    };
  }
}

module.exports = {
  AuthProvider,
  normalizeMode,
  normalizeStrategy
};
