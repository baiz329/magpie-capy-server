import { expect, test } from "bun:test";

import { ChatUseCase } from "../../src/application/chat.ts";
import { DeviceUseCase } from "../../src/application/device.ts";
import { PromptToolBridge } from "../../src/application/tools.ts";
import type { AccountSession } from "../../src/domain/account.ts";
import type { ChatRequest } from "../../src/domain/chat.ts";
import { CapyError } from "../../src/domain/errors.ts";
import type { CapyAppPort, CreateJamInput, DeviceInfo, JamCreated } from "../../src/ports/capy-app.ts";
import type { CapyPublicPort, UpstreamSseFrame } from "../../src/ports/capy-public.ts";
import type { DeviceRuntimePort } from "../../src/ports/device-runtime.ts";
import type { ClockPort, IdPort } from "../../src/ports/platform.ts";

const session: AccountSession = {
  accountId: "a@b.c",
  uid: "user_1",
  orgId: "org_1",
  clientId: "c".repeat(32),
  accessToken: `capy_${"a".repeat(43)}`,
  clerk: { clientJwt: "client", sessionId: "sess_1" },
  source: "local",
};

const device: DeviceInfo = { id: "device_1", name: "magpie-headless", connected: true };

function ids(): IdPort {
  let i = 0;
  return {
    ulid: () => `${String(i++).padStart(2, "0")}${"0".repeat(24)}`,
    uuid: () => "uuid",
  };
}

const clock: ClockPort = {
  now: () => 1000,
  async sleep() {},
};

function fakeApp() {
  const calls: CreateJamInput[] = [];
  let interrupted = 0;
  const app: CapyAppPort = {
    async sessionJwt() { return "jwt"; },
    async me() { return { id: "user_1" }; },
    async organizations() { return [{ id: "org_1" }]; },
    async mintApiKey() { return { plaintext: "capy_key" }; },
    async listDevices() { return [device]; },
    async renameDevice() {},
    async startDeviceCode() { throw new Error("unused"); },
    async approveDeviceCode() {},
    async pollDeviceCode() { throw new Error("unused"); },
    async createJam(_jwt, _org, input): Promise<JamCreated> {
      calls.push(input);
      return {
        id: input.jamId,
        primaryMachine: { kind: "device", name: "magpie-headless" },
        ask: null,
      };
    },
    async getJam(_jwt, _org, id) {
      return { id, status: "idle", ask: null };
    },
    async getJamEvents() { return []; },
    async interruptJam() { interrupted += 1; },
  };
  return { app, calls, interrupted: () => interrupted };
}

function fakePublic(frames: UpstreamSseFrame[]): CapyPublicPort {
  return {
    async listModels() { return { items: [] }; },
    async *streamThread() {
      for (const frame of frames) yield frame;
    },
    async uploadFiles() { return []; },
    async usage() { return {}; },
    async balance() { return {}; },
  };
}

function fakeRuntime(): DeviceRuntimePort {
  return {
    async ensure() { return device; },
    peek() { return device; },
    close() {},
  };
}

function sse(event: string, data: unknown): UpstreamSseFrame {
  return { event, data: JSON.stringify(data) };
}

const request: ChatRequest = {
  model: "particle/particle-1",
  stream: false,
  messages: [{ role: "user", content: "ping" }],
};

test("ChatUseCase：ensure → createJam → SSE → 事件", async () => {
  const { app, calls } = fakeApp();
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([
      sse("assistant", { callId: "c1", text: "po" }),
      sse("assistant", { callId: "c1", text: "pong" }),
      sse("transcript", { source: "assistant", text: "pong", callId: "c1" }),
      sse("turn", { phase: "end", outcome: "settled" }),
      sse("run", { phase: "end" }),
      sse("done", {}),
    ]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });

  const events = [];
  for await (const event of useCase.stream(session, request)) events.push(event);

  expect(events).toEqual([
    { type: "delta", text: "po" },
    { type: "delta", text: "ng" },
    { type: "final", text: "pong" },
    { type: "done" },
  ]);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.message).toBe("ping");
  expect(calls[0]?.deviceId).toBe(device.id);
  expect(calls[0]?.modelId).toBe("particle/particle-1");
  expect(calls[0]?.clientKey).toBe(calls[0]?.requestId);
});

test("ChatUseCase：大段 delta 不再被平滑切分，直接原样发出（pacing 已删，M-11）", async () => {
  const big = "你好世界".repeat(60);
  const { app } = fakeApp();
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([
      sse("assistant", { callId: "c1", text: big }),
      sse("done", {}),
    ]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });

  const events: unknown[] = [];
  for await (const event of useCase.stream(session, request)) events.push(event);

  const deltas = events.filter((e): e is { type: "delta"; text: string } => (e as { type: string }).type === "delta");
  expect(deltas).toEqual([{ type: "delta", text: big }]);
});

test("ChatUseCase：ADS 模型建线程带 ads 能力位", async () => {
  const { app, calls } = fakeApp();
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  for await (const _event of useCase.stream(session, {
    ...request,
    model: "zai/glm-5.3-flash-ads",
  })) { /* drain */ }
  expect(calls[0]?.ads).toBe(true);
});

test("ChatUseCase：线程 failed 且无文本时返回 jam error，而不是空完成", async () => {
  const base = fakeApp();
  const app: CapyAppPort = {
    ...base.app,
    async getJam(_jwt, _org, id) {
      return { id, status: "failed", ask: null };
    },
    async getJamEvents() {
      return [{
        id: "event_1",
        kind: "error",
        payload: { code: "region_unsupported", message: "only US/CA/UK" },
      }];
    },
  };
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const events = [];
  for await (const event of useCase.stream(session, request)) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("error");
  if (events[0]?.type === "error") {
    expect(events[0].error.kind).toBe("region_unsupported");
    expect(events[0].error.status).toBe(403);
  }
});

test("ChatUseCase：cancel 调 interrupt", async () => {
  const { app, interrupted } = fakeApp();
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  await useCase.cancel(session, "jam_1");
  expect(interrupted()).toBe(1);
});

test("ChatUseCase：建线程 429 直接抛 rate_limited，不静默降级", async () => {
  const base = fakeApp();
  const app: CapyAppPort = {
    ...base.app,
    async createJam(): Promise<JamCreated> {
      throw new CapyError("rate_limited", "Capy 限流");
    },
  };
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  let caught: unknown = null;
  try {
    for await (const _event of useCase.stream(session, request)) { /* drain */ }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapyError);
  if (caught instanceof CapyError) {
    expect(caught.kind).toBe("rate_limited");
    expect(caught.status).toBe(429);
    expect(caught.retryable).toBe(true);
  }
});

test("ChatUseCase：建线程 401 直接抛 sign_in_required，不重试", async () => {
  const base = fakeApp();
  let calls = 0;
  const app: CapyAppPort = {
    ...base.app,
    async createJam(): Promise<JamCreated> {
      calls += 1;
      throw new CapyError("sign_in_required", "Capy 登录已失效，请重新登录");
    },
  };
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  let caught: unknown = null;
  try {
    for await (const _event of useCase.stream(session, request)) { /* drain */ }
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapyError);
  if (caught instanceof CapyError) {
    expect(caught.kind).toBe("sign_in_required");
    expect(caught.status).toBe(401);
  }
  expect(calls).toBe(1);
});

test("ChatUseCase：流开始前 429 只出一个 error 事件（rate_limited），前面没有 delta", async () => {
  const { app } = fakeApp();
  const throwingPublic: CapyPublicPort = {
    async listModels() { return { items: [] }; },
    async *streamThread(): AsyncIterable<UpstreamSseFrame> {
      throw new CapyError("rate_limited", "Capy 限流");
    },
    async uploadFiles() { return []; },
    async usage() { return {}; },
    async balance() { return {}; },
  };
  const useCase = new ChatUseCase({
    app,
    publicApi: throwingPublic,
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const events = [];
  for await (const event of useCase.stream(session, request)) events.push(event);
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("error");
  if (events[0]?.type === "error") {
    expect(events[0].error.kind).toBe("rate_limited");
    expect(events[0].error.status).toBe(429);
  }
});

test("ChatUseCase：并发 stream 共享同一次 sessionJwt（single-flight，H-13(3)）", async () => {
  const base = fakeApp();
  let jwtCalls = 0;
  const app: CapyAppPort = {
    ...base.app,
    async sessionJwt() {
      jwtCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "jwt";
    },
  };
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([
      sse("assistant", { callId: "c1", text: "pong" }),
      sse("done", {}),
    ]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const drain = async () => {
    const out = [];
    for await (const event of useCase.stream(session, request)) out.push(event);
    return out;
  };
  const [first, second] = await Promise.all([drain(), drain()]);
  expect(jwtCalls).toBe(1);
  expect(first[first.length - 1]).toEqual({ type: "done" });
  expect(second[second.length - 1]).toEqual({ type: "done" });
});

test("ChatUseCase：run.modelId 优先于 request.model，createJam 与 ads 都用它（H-14(1)）", async () => {
  const { app, calls } = fakeApp();
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([sse("done", {})]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  for await (const _event of useCase.stream(session, { ...request, model: "short-name" }, {
    modelId: "zai/glm-5.3-flash-ads",
  })) { /* drain */ }
  expect(calls[0]?.modelId).toBe("zai/glm-5.3-flash-ads");
  expect(calls[0]?.ads).toBe(true);
});

test("ChatUseCase：minimal 遇到 403 就不带 variant 重试一次（H-13(1) 回归）", async () => {
  const base = fakeApp();
  let calls = 0;
  const app: CapyAppPort = {
    ...base.app,
    async createJam(_jwt: string, _org: string, input: CreateJamInput): Promise<JamCreated> {
      calls += 1;
      if (calls === 1) {
        throw new CapyError("upstream_error", "minimal variant not supported", {
          status: 403,
          detail: "promptVariant not supported for this account",
        });
      }
      return { id: input.jamId, primaryMachine: { kind: "device", name: "magpie-headless" }, ask: null };
    },
  };
  let fallback = 0;
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([sse("done", {})]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const events = [];
  for await (const event of useCase.stream(session, request, {
    promptVariant: "minimal",
    onVariantFallback: () => { fallback += 1; },
  })) events.push(event);
  expect(calls).toBe(2);
  expect(fallback).toBe(1);
  expect(events[events.length - 1]).toEqual({ type: "done" });
});

test("ChatUseCase：minimal 403 且 detail 不含 variant（Capy 真实返回 capy/Forbidden）也降级重试（H-13(1) 回归）", async () => {
  const base = fakeApp();
  let calls = 0;
  const variants: (string | undefined)[] = [];
  const app: CapyAppPort = {
    ...base.app,
    async createJam(_jwt: string, _org: string, input: CreateJamInput): Promise<JamCreated> {
      calls += 1;
      variants.push(input.promptVariant);
      if (calls === 1) {
        // Capy 真实返回 {"_tag":"capy/Forbidden"}，detail 里没有 variant 这个词。
        throw new CapyError("upstream_error", "forbidden", { status: 403, detail: "capy/Forbidden" });
      }
      return { id: input.jamId, primaryMachine: { kind: "device", name: "magpie-headless" }, ask: null };
    },
  };
  let fallback = 0;
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([sse("done", {})]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const events = [];
  for await (const event of useCase.stream(session, request, {
    promptVariant: "minimal",
    onVariantFallback: () => { fallback += 1; },
  })) events.push(event);
  expect(calls).toBe(2);
  expect(variants).toEqual(["minimal", undefined]);
  expect(fallback).toBe(1);
  expect(events[events.length - 1]).toEqual({ type: "done" });
});

test("ChatUseCase：minimal 降级重试也 403 → 错误透传，只重试一次（H-13(1) 回归）", async () => {
  const base = fakeApp();
  let calls = 0;
  const app: CapyAppPort = {
    ...base.app,
    async createJam(): Promise<JamCreated> {
      calls += 1;
      throw new CapyError("upstream_error", "forbidden", { status: 403, detail: "capy/Forbidden" });
    },
  };
  let fallback = 0;
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  let caught: unknown = null;
  try {
    for await (const _event of useCase.stream(session, request, {
      promptVariant: "minimal",
      onVariantFallback: () => { fallback += 1; },
    })) { /* drain */ }
  } catch (error) {
    caught = error;
  }
  expect(calls).toBe(2);
  expect(fallback).toBe(1);
  expect(caught).toBeInstanceOf(CapyError);
});

test("ChatUseCase：消费方中途取消 → interruptJam（M-11）", async () => {
  const { app, interrupted } = fakeApp();
  const useCase = new ChatUseCase({
    app,
    publicApi: fakePublic([
      sse("assistant", { callId: "c1", text: "po" }),
      sse("assistant", { callId: "c1", text: "pong" }),
      sse("done", {}),
    ]),
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const iterator = useCase.stream(session, request)[Symbol.asyncIterator]();
  const first = await iterator.next();
  expect(first.value).toEqual({ type: "delta", text: "po" });
  await iterator.return?.(undefined);
  expect(interrupted()).toBe(1);
});

test("ChatUseCase：见 done 即断开，不再拉取后续帧（H-11）", async () => {
  const { app } = fakeApp();
  const frames = [
    sse("assistant", { callId: "c1", text: "pong" }),
    sse("done", {}),
    sse("assistant", { callId: "c1", text: "late" }),
  ];
  let pulled = 0;
  const countingPublic: CapyPublicPort = {
    async listModels() { return { items: [] }; },
    async *streamThread() {
      for (const frame of frames) {
        pulled += 1;
        yield frame;
      }
    },
    async uploadFiles() { return []; },
    async usage() { return {}; },
    async balance() { return {}; },
  };
  const useCase = new ChatUseCase({
    app,
    publicApi: countingPublic,
    device: new DeviceUseCase(fakeRuntime()),
    ids: ids(),
    clock,
    tools: new PromptToolBridge(),
    toolsEnabled: false,
  });
  const events = [];
  for await (const event of useCase.stream(session, request)) events.push(event);
  expect(pulled).toBe(2);
  expect(events).toEqual([
    { type: "delta", text: "pong" },
    { type: "final", text: "pong" },
    { type: "done" },
  ]);
});
