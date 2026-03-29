"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { ModelsRegistry, extractGatewayModels } = require("../src/models");

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

test("ModelsRegistry returns gateway-discovered models only", async () => {
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
