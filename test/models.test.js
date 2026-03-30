"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ModelsRegistry, extractGatewayModels, getStaticModelIds } = require("../src/models");

test("extractGatewayModels filters invisible entries", () => {
  const models = extractGatewayModels({
    data: [
      { id: "claude-opus-4-6", visible: true },
      { id: "hidden-model", visible: false }
    ]
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "claude-opus-4-6");
});

test("extractGatewayModels supports provider modelList payloads", () => {
  const models = extractGatewayModels({
    data: [
      {
        provider: "claude",
        providerDisplayName: "Claude",
        modelList: [
          { modelName: "claude-opus-4-6", visible: true, multimodal: true },
          { modelName: "hidden-model", visible: false }
        ]
      }
    ]
  });

  assert.equal(models.length, 1);
  assert.equal(models[0].id, "claude-opus-4-6");
  assert.equal(models[0].accio.provider, "claude");
  assert.equal(models[0].accio.multimodal, true);
});

test("ModelsRegistry returns gateway-discovered models and falls back to static aliases when needed", async () => {
  const registry = new ModelsRegistry(
    {
      baseUrl: "http://127.0.0.1:4097",
      modelsSource: "gateway",
      modelsCacheTtlMs: 1000,
      requestTimeoutMs: 1000
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            data: [
              { provider: "openai", modelList: [{ modelName: "gpt-5.4", visible: true }] },
              { provider: "claude", modelList: [{ modelName: "claude-opus-4-6", visible: true }] }
            ]
          };
        }
      })
    }
  );

  const models = await registry.listModels();
  const ids = models.map((model) => model.id);

  assert.deepEqual(ids, ["claude-opus-4-6", "gpt-5.4"]);
});

test("ModelsRegistry falls back to static models when gateway discovery fails", async () => {
  const registry = new ModelsRegistry(
    {
      baseUrl: "http://127.0.0.1:4097",
      modelsSource: "gateway",
      modelsCacheTtlMs: 1000,
      requestTimeoutMs: 1000
    },
    {
      fetchImpl: async () => {
        throw new Error("connect ECONNREFUSED");
      }
    }
  );

  const models = await registry.listModels();
  const ids = models.map((model) => model.id);

  assert.deepEqual(ids, getStaticModelIds());
});

test("ModelsRegistry hybrid mode merges gateway models with static aliases", async () => {
  const registry = new ModelsRegistry(
    {
      baseUrl: "http://127.0.0.1:4097",
      modelsSource: "hybrid",
      modelsCacheTtlMs: 1000,
      requestTimeoutMs: 1000
    },
    {
      fetchImpl: async () => ({
        ok: true,
        async json() {
          return {
            data: [
              { provider: "openai", modelList: [{ modelName: "gpt-5.4", visible: true }] }
            ]
          };
        }
      })
    }
  );

  const models = await registry.listModels();
  const ids = models.map((model) => model.id);

  assert.ok(ids.includes("gpt-5.4"));
  assert.ok(ids.includes("accio-bridge"));
  assert.ok(ids.includes("claude-opus-4-6"));
});

test("ModelsRegistry static mode skips gateway discovery entirely", async () => {
  let fetchCalls = 0;
  const registry = new ModelsRegistry(
    {
      baseUrl: "http://127.0.0.1:4097",
      modelsSource: "static",
      modelsCacheTtlMs: 1000,
      requestTimeoutMs: 1000
    },
    {
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("should not fetch");
      }
    }
  );

  const models = await registry.listModels();
  const ids = models.map((model) => model.id);

  assert.equal(fetchCalls, 0);
  assert.deepEqual(ids, getStaticModelIds());
});
