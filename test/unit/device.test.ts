import { expect, test } from "bun:test";

import { DeviceUseCase } from "../../src/application/device.ts";
import type { AccountSession } from "../../src/domain/account.ts";
import type { DeviceRuntimePort } from "../../src/ports/device-runtime.ts";

const session: AccountSession = {
  accountId: "a@b.c",
  uid: "user_1",
  orgId: "org_1",
  clientId: "c".repeat(32),
  accessToken: "capy_key",
  clerk: { clientJwt: "client", sessionId: "sess" },
  source: "local",
};

test("single-flight：并发 ensure 只调用一次", async () => {
  let calls = 0;
  const runtime: DeviceRuntimePort = {
    async ensure() {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { id: "device_1", name: "magpie-headless", connected: true };
    },
    close() {},
  };
  const useCase = new DeviceUseCase(runtime);
  const [a, b] = await Promise.all([useCase.ensure(session), useCase.ensure(session)]);
  expect(a.id).toBe("device_1");
  expect(b.id).toBe("device_1");
  expect(calls).toBe(1);
});

test("失败后允许重试", async () => {
  let calls = 0;
  const runtime: DeviceRuntimePort = {
    async ensure() {
      calls += 1;
      if (calls === 1) throw new Error("boom");
      return { id: "device_1", name: "magpie-headless", connected: true };
    },
    close() {},
  };
  const useCase = new DeviceUseCase(runtime);
  await expect(useCase.ensure(session)).rejects.toThrow("boom");
  const device = await useCase.ensure(session);
  expect(device.id).toBe("device_1");
  expect(calls).toBe(2);
});
