"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { __test } = require("../src/routes/admin");

const {
  assertQuotaRefreshBoundUser,
  resolveQuotaRefreshPlan,
  resolveSnapshotQuotaCacheMode,
  shouldForceRefreshQuotaForAlias,
  shouldUseReadOnlyQuotaCacheForAlias
} = __test;

test("assertQuotaRefreshBoundUser allows matching bound user", () => {
  assert.doesNotThrow(() => {
    assertQuotaRefreshBoundUser("acct-1", "acct-1", { alias: "snapshot-a" });
  });
});

test("assertQuotaRefreshBoundUser allows missing expected or bound user", () => {
  assert.doesNotThrow(() => {
    assertQuotaRefreshBoundUser("", "acct-1", { alias: "snapshot-a" });
  });

  assert.doesNotThrow(() => {
    assertQuotaRefreshBoundUser("acct-1", "", { alias: "snapshot-a" });
  });
});

test("assertQuotaRefreshBoundUser rejects mismatched bound user", () => {
  let capturedError = null;

  try {
    assertQuotaRefreshBoundUser("acct-1", "acct-2", { alias: "snapshot-a" });
  } catch (error) {
    capturedError = error;
  }

  assert.ok(capturedError);
  assert.equal(capturedError.code, "ACCIO_QUOTA_USER_MISMATCH");
  assert.equal(capturedError.expectedUserId, "acct-1");
  assert.equal(capturedError.boundUserId, "acct-2");
  assert.equal(capturedError.alias, "snapshot-a");
  assert.match(capturedError.message, /expected acct-1, got acct-2/);
});

test("resolveQuotaRefreshPlan distinguishes full and partial refresh", () => {
  assert.deepEqual(resolveQuotaRefreshPlan(), {
    refreshAlias: "",
    forceQuotaRefresh: false,
    partialQuotaRefresh: false
  });

  assert.deepEqual(resolveQuotaRefreshPlan({ forceQuotaRefresh: true }), {
    refreshAlias: "",
    forceQuotaRefresh: true,
    partialQuotaRefresh: false
  });

  assert.deepEqual(resolveQuotaRefreshPlan({ forceQuotaRefresh: true, alias: "acct-a" }), {
    refreshAlias: "acct-a",
    forceQuotaRefresh: true,
    partialQuotaRefresh: true
  });
});

test("quota refresh plan helpers route aliases correctly", () => {
  const fullPlan = resolveQuotaRefreshPlan({ forceQuotaRefresh: true });
  assert.equal(shouldForceRefreshQuotaForAlias(fullPlan, "acct-a"), true);
  assert.equal(shouldUseReadOnlyQuotaCacheForAlias(fullPlan, "acct-a"), false);

  const partialPlan = resolveQuotaRefreshPlan({ forceQuotaRefresh: true, alias: "acct-a" });
  assert.equal(shouldForceRefreshQuotaForAlias(partialPlan, "acct-a"), true);
  assert.equal(shouldForceRefreshQuotaForAlias(partialPlan, "acct-b"), false);
  assert.equal(shouldUseReadOnlyQuotaCacheForAlias(partialPlan, "acct-a"), false);
  assert.equal(shouldUseReadOnlyQuotaCacheForAlias(partialPlan, "acct-b"), true);
});

test("resolveSnapshotQuotaCacheMode distinguishes cache usage modes", () => {
  assert.equal(resolveSnapshotQuotaCacheMode(), "use_cache");
  assert.equal(resolveSnapshotQuotaCacheMode({ forceRefresh: true }), "bypass_cache");
  assert.equal(resolveSnapshotQuotaCacheMode({ readOnlyCache: true }), "read_only_cache");
});
