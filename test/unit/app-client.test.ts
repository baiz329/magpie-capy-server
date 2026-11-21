import { expect, test } from "bun:test";

import { CapyAppClient } from "../../src/adapters/capy/app-client.ts";

/**
 * 真实桌面端建对话请求（2026-11-21 桌面版 DevTools 抓包，app.har entry 0，
 * 已脱敏，见 spec/capture/desktop-create-jam-2026-11-21.json）。
 * 下面断言的是线上的字段集、字段顺序、显式 null 与 UUID clientKey。
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 录下发出的请求，返回最小建线程响应。 */
function captureFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init: init ?? {} });
    return new Response(JSON.stringify({ id: "jam_1", primaryMachine: { kind: "device" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const probe = { currentVersion: async () => "0.9.2" };

function bodyOf(call: { init: RequestInit }): Record<string, unknown> {
  const text = String(call.init.body ?? "");
  return JSON.parse(text) as Record<string, unknown>;
}

function headersOf(call: { init: RequestInit }): Headers {
  return new Headers(call.init.headers as HeadersInit);
}

test("createJam 请求体与桌面端一致：16 字段、线上顺序、显式 null", async () => {
  const { fetchImpl, calls } = captureFetch();
  const client = new CapyAppClient(fetchImpl, undefined, probe);
  await client.createJam("jwt", "org_1", {
    jamId: "jam_01TEST",
    requestId: "01TESTREQUESTID000000000001",
    clientKey: "req_1",
    message: "hi",
    modelId: "deepseek/deepseek-v4.1-flash-ads",
    deviceId: "dev_1",
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://api.capy.ai/app/orgs/org_1/jams");
  const body = bodyOf(calls[0]!);
  // 字段集与线上顺序（app.har entry 0 的 postData 原文顺序）。
  expect(Object.keys(body)).toEqual([
    "jamId",
    "requestId",
    "title",
    "message",
    "model",
    "mentions",
    "files",
    "clientKey",
    "machineSize",
    "device",
    "branches",
    "environmentVariables",
    "slackChannelId",
    "promptVariant",
    "personal",
    "memberIds",
  ]);
  expect(body.jamId).toBe("jam_01TEST");
  expect(body.requestId).toBe("01TESTREQUESTID000000000001");
  expect(body.title).toBeNull();
  expect(body.message).toBe("hi");
  // model 内顺序也是线上的：modelId、reasoningMode、modes。
  const model = body.model as Record<string, unknown>;
  expect(Object.keys(model)).toEqual(["modelId", "reasoningMode", "modes"]);
  expect(model.modelId).toBe("deepseek/deepseek-v4.1-flash-ads");
  expect(model.reasoningMode).toBeNull();
  expect(model.modes).toBeNull();
  expect(body.mentions).toBeNull();
  expect(body.files).toBeNull();
  expect(body.machineSize).toBeNull();
  expect(body.device).toEqual({ deviceId: "dev_1", workspace: { kind: "worktree" } });
  expect(body.branches).toBeNull();
  expect(body.environmentVariables).toBeNull();
  expect(body.slackChannelId).toBeNull();
  expect(body.promptVariant).toBeNull();
  expect(body.personal).toBeNull();
  expect(body.memberIds).toBeNull();
});

test("createJam clientKey 是独立 UUID，不等于 ULID 的 requestId", async () => {
  const { fetchImpl, calls } = captureFetch();
  const client = new CapyAppClient(fetchImpl, undefined, probe);
  await client.createJam("jwt", "org_1", {
    jamId: "jam_01TEST",
    requestId: "01TESTREQUESTID000000000001",
    clientKey: "req_1",
    message: "hi",
    modelId: "particle/particle-1",
    deviceId: "dev_1",
  });
  const body = bodyOf(calls[0]!);
  const clientKey = String(body.clientKey ?? "");
  expect(clientKey).toMatch(UUID_RE);
  expect(clientKey).not.toBe(body.requestId);
  expect(clientKey).not.toBe("req_1");
});

test("createJam 有值时 files/promptVariant/reasoningMode 按原值发送", async () => {
  const { fetchImpl, calls } = captureFetch();
  const client = new CapyAppClient(fetchImpl, undefined, probe);
  const files = [{ fileId: "file_1", name: "red.png", mediaType: "image/png", sizeBytes: 785 }];
  await client.createJam("jwt", "org_1", {
    jamId: "jam_01TEST",
    requestId: "01TESTREQUESTID000000000001",
    clientKey: "req_1",
    message: "hi",
    modelId: "particle/particle-1",
    reasoningMode: "high",
    deviceId: "dev_1",
    files,
    promptVariant: "minimal",
  });
  const body = bodyOf(calls[0]!);
  expect(body.files).toEqual(files);
  expect(body.promptVariant).toBe("minimal");
  const model = body.model as Record<string, unknown>;
  expect(model.reasoningMode).toBe("high");
  expect(model.modes).toBeNull();
});

test("createJam 请求头与桌面端一致：capy://app、无 referer、cross-site、en-US", async () => {
  const { fetchImpl, calls } = captureFetch();
  const client = new CapyAppClient(fetchImpl, undefined, probe);
  await client.createJam("jwt", "org_1", {
    jamId: "jam_01TEST",
    requestId: "01TESTREQUESTID000000000001",
    clientKey: "req_1",
    message: "hi",
    modelId: "particle/particle-1",
    deviceId: "dev_1",
  });
  const headers = headersOf(calls[0]!);
  expect(headers.get("authorization")).toBe("Bearer jwt");
  expect(headers.get("origin")).toBe("capy://app");
  expect(headers.get("referer")).toBeNull();
  expect(headers.get("accept")).toBe("*/*");
  expect(headers.get("accept-language")).toBe("en-US");
  expect(headers.get("content-type")).toBe("application/json");
  expect(headers.get("sec-fetch-site")).toBe("cross-site");
  expect(headers.get("sec-fetch-mode")).toBe("cors");
  expect(headers.get("sec-fetch-dest")).toBe("empty");
  expect(headers.get("sec-ch-ua")).toContain('Chromium";v="156"');
  expect(headers.get("sec-ch-ua-mobile")).toBe("?0");
  expect(headers.get("sec-ch-ua-platform")).toBe('"Windows"');
  expect(headers.get("priority")).toBe("u=1, i");
  const ua = headers.get("user-agent") ?? "";
  expect(ua).toContain("Capy/0.9.2");
  expect(ua).toContain("Chrome/156.0.8078.80");
  expect(ua).toContain("Electron/45.2.3");
  expect(headers.get("x-capy-client-surface")).toBe("desktop");
  expect(headers.get("x-capy-client-features")).toBe("message-edit,visual");
  expect(headers.get("x-capy-client-timezone")).toBeTruthy();
});

test("createJam ads 模型带 ads-models 能力位", async () => {
  const { fetchImpl, calls } = captureFetch();
  const client = new CapyAppClient(fetchImpl, undefined, probe);
  await client.createJam("jwt", "org_1", {
    jamId: "jam_01TEST",
    requestId: "01TESTREQUESTID000000000001",
    clientKey: "req_1",
    message: "hi",
    modelId: "deepseek/deepseek-v4.1-flash-ads",
    deviceId: "dev_1",
    ads: true,
  });
  const headers = headersOf(calls[0]!);
  expect(headers.get("x-capy-client-features")).toBe("message-edit,visual,ads-models");
});
