"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ResponseCache, buildCacheKey } = require("../src/response-cache");

test("buildCacheKey is stable for semantically equal objects", () => {
  const a = buildCacheKey({ body: { b: 2, a: 1 }, protocol: "x" });
  const b = buildCacheKey({ protocol: "x", body: { a: 1, b: 2 } });
  assert.equal(a, b);
});

test("ResponseCache stores and expires values", async () => {
  const cache = new ResponseCache({ ttlMs: 20, maxEntries: 2 });
  cache.set("a", { ok: true });
  assert.deepEqual(cache.get("a"), { ok: true });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(cache.get("a"), null);
});
