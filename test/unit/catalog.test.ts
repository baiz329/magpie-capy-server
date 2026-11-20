import { expect, test } from "bun:test";

import { CatalogUseCase } from "../../src/application/catalog.ts";
import { CapyError } from "../../src/domain/errors.ts";
import type { CapyPublicPort } from "../../src/ports/capy-public.ts";

function publicPort(overrides: Partial<CapyPublicPort> = {}): CapyPublicPort {
  return {
    async listModels() {
      return {
        items: [
          { id: "openai/gpt-6.2-astra", name: "GPT-6.2 Astra" },
          { id: "particle/particle-1", name: "Particle-1" },
        ],
        default: {
          modelId: "particle/particle-1",
          source: "personal",
          skipped: [],
        },
      };
    },
    async *streamThread() {},
    async uploadFiles() { return []; },
    async usage() { return {}; },
    async balance() { return {}; },
    ...overrides,
  };
}

test("catalog：保留 Capy /models.default，不自己编默认模型", async () => {
  const useCase = new CatalogUseCase({
    publicPort: publicPort(),
    fallback: [],
    toolsEnabled: true,
  });
  const snapshot = await useCase.load("capy_key");
  expect(snapshot.default?.modelId).toBe("particle/particle-1");
  expect(snapshot.default?.source).toBe("personal");
  expect(snapshot.models[0]?.id).toBe("particle/particle-1");
});

test("catalog：live 失败用调用方给的静态快照，且不伪造 default", async () => {
  const useCase = new CatalogUseCase({
    publicPort: publicPort({
      async listModels() { throw new Error("offline"); },
    }),
    fallback: [{ id: "particle/particle-1", name: "Particle-1" }],
    toolsEnabled: true,
  });
  const snapshot = await useCase.load("capy_key");
  expect(snapshot.default).toBeUndefined();
  expect(snapshot.models.some((model) => model.id === "particle/particle-1")).toBe(true);
});

test("catalog：401 不被静态兜底掩盖", async () => {
  const useCase = new CatalogUseCase({
    publicPort: publicPort({
      async listModels() { throw new CapyError("sign_in_required", "expired"); },
    }),
    fallback: [{ id: "particle/particle-1" }],
    toolsEnabled: true,
  });
  await expect(useCase.load("capy_key")).rejects.toMatchObject({ kind: "sign_in_required" });
});
