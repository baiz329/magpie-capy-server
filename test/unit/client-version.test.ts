import { expect, test } from "bun:test";

import {
  CAPY_DOWNLOAD_URL,
  FALLBACK_DESKTOP_VERSION,
  createDesktopVersionProbe,
  desktopUserAgent,
  parseDesktopVersion,
} from "../../src/adapters/capy/client-version.ts";

function htmlWithVersion(version: string): string {
  return `<!DOCTYPE html><html><body><h1>Download Capy</h1><p>Version ${version}</p></body></html>`;
}

function okResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/html" } });
}

test("parseDesktopVersion：从下载页 HTML 提取版本号", () => {
  expect(parseDesktopVersion(htmlWithVersion("0.9.2"))).toBe("0.9.2");
  expect(parseDesktopVersion(htmlWithVersion("1.2.3"))).toBe("1.2.3");
  // 多个出现时取第一个
  expect(parseDesktopVersion("Version 0.9.2 and Version 0.9.3")).toBe("0.9.2");
  // 没有版本号返回 null
  expect(parseDesktopVersion("<html><body>no version here</body></html>")).toBeNull();
  expect(parseDesktopVersion("")).toBeNull();
});

test("desktopUserAgent：只刷新 Capy/ 段，Chrome/Electron 保持上次验证值", () => {
  expect(desktopUserAgent("0.9.2")).toBe(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Capy/0.9.2 Chrome/156.0.8078.80 Electron/45.2.3 Safari/537.36",
  );
  expect(desktopUserAgent("1.0.0")).toContain("Capy/1.0.0");
  expect(desktopUserAgent("1.0.0")).toContain("Chrome/156.0.8078.80");
  expect(desktopUserAgent("1.0.0")).toContain("Electron/45.2.3");
});

test("probe：从下载页取到版本并缓存，第二次调用不再请求", async () => {
  let calls = 0;
  const fetchImpl = (async (url: string): Promise<Response> => {
    calls += 1;
    expect(url).toBe(CAPY_DOWNLOAD_URL);
    return okResponse(htmlWithVersion("0.9.5"));
  }) as unknown as typeof fetch;
  const probe = createDesktopVersionProbe({ fetchImpl });
  expect(await probe.currentVersion()).toBe("0.9.5");
  expect(await probe.currentVersion()).toBe("0.9.5");
  expect(calls).toBe(1);
});

test("probe：下载页请求失败时回退到写死的 0.9.2", async () => {
  const fetchImpl = (async (): Promise<Response> => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const probe = createDesktopVersionProbe({ fetchImpl });
  expect(await probe.currentVersion()).toBe(FALLBACK_DESKTOP_VERSION);
});

test("probe：下载页没有版本号时回退到 0.9.2", async () => {
  const fetchImpl = (async (): Promise<Response> =>
    okResponse("<html><body>nothing</body></html>")) as unknown as typeof fetch;
  const probe = createDesktopVersionProbe({ fetchImpl });
  expect(await probe.currentVersion()).toBe(FALLBACK_DESKTOP_VERSION);
});

test("probe：下载页返回非 200 时回退到 0.9.2", async () => {
  const fetchImpl = (async (): Promise<Response> =>
    new Response("not found", { status: 404 })) as unknown as typeof fetch;
  const probe = createDesktopVersionProbe({ fetchImpl });
  expect(await probe.currentVersion()).toBe(FALLBACK_DESKTOP_VERSION);
});

test("probe：缓存过期后重新探测", async () => {
  let now = 0;
  let calls = 0;
  const fetchImpl = (async (): Promise<Response> => {
    calls += 1;
    return okResponse(htmlWithVersion(calls === 1 ? "0.9.5" : "0.9.6"));
  }) as unknown as typeof fetch;
  const probe = createDesktopVersionProbe({ fetchImpl, ttlMs: 1000, now: () => now });
  expect(await probe.currentVersion()).toBe("0.9.5");
  // 未过期：用缓存
  now = 999;
  expect(await probe.currentVersion()).toBe("0.9.5");
  expect(calls).toBe(1);
  // 过期：重新探测
  now = 1001;
  expect(await probe.currentVersion()).toBe("0.9.6");
  expect(calls).toBe(2);
});

test("probe：探测超时时回退到 0.9.2，不挂住请求", async () => {
  const fetchImpl = ((_: string): Promise<Response> =>
    new Promise(() => {})) as unknown as typeof fetch;
  const probe = createDesktopVersionProbe({ fetchImpl, timeoutMs: 10 });
  expect(await probe.currentVersion()).toBe(FALLBACK_DESKTOP_VERSION);
});

test("接线：CapyAppClient 用探测到的版本拼 UA 发请求", async () => {
  const { CapyAppClient } = await import("../../src/adapters/capy/app-client.ts");
  let sentUa = "";
  const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    sentUa = headers.get("user-agent") ?? "";
    return new Response(JSON.stringify({ id: "jam_1", primaryMachine: { kind: "device" } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  const probe = { currentVersion: async () => "0.9.5" };
  const client = new CapyAppClient(fetchImpl, undefined, probe);
  await client.createJam("jwt", "org_1", {
    jamId: "jam_1",
    requestId: "req_1",
    clientKey: "req_1",
    message: "hi",
    modelId: "particle/particle-1",
    deviceId: "dev_1",
  });
  expect(sentUa).toContain("Capy/0.9.5");
  expect(sentUa).toContain("Chrome/156.0.8078.80");
});
