import { expect, test } from "bun:test";

import { createGuardedFetch, type GuardedLookup } from "../../src/adapters/platform/guarded-fetch.ts";

function okResponse(body = "ok", status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url, init);
  }) as typeof fetch;
}

const publicLookup: GuardedLookup = async (host) => {
  if (host === "example.com") return [{ address: "93.184.216.34", family: 4 }];
  if (host === "evil.example.com") return [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
  if (host === "v6.example.com") return [{ address: "2001:4860:4860::8888", family: 6 }];
  return [];
};

test("guarded-fetch：拒绝 userinfo / 非白名单端口 / 私网字面量", async () => {
  const guarded = createGuardedFetch(fakeFetch(() => okResponse()), { lookup: publicLookup });
  for (const url of [
    "https://user:pass@example.com/x.png",
    "https://example.com:8443/x.png",
    "http://127.0.0.1/x.png",
    "http://10.0.0.5/x.png",
    "http://169.254.169.254/latest/meta-data/",
    "http://[::ffff:127.0.0.1]/x",
    "http://localhost/x",
    "ftp://example.com/x",
  ]) {
    await expect(guarded(url)).rejects.toThrow();
  }
  const res = await guarded("https://example.com/x.png");
  expect(res.status).toBe(200);
});

test("guarded-fetch：DNS 任一解析到禁段即拒", async () => {
  const guarded = createGuardedFetch(fakeFetch(() => okResponse()), { lookup: publicLookup });
  await expect(guarded("https://evil.example.com/x")).rejects.toThrow(/内网/);
  await expect(guarded("https://no-such-host.example/x")).rejects.toThrow(/DNS/);
  const v6 = await guarded("https://v6.example.com/x");
  expect(v6.status).toBe(200);
});

test("guarded-fetch：逐跳重定向重校验，超 3 跳返回最后一跳响应", async () => {
  let calls = 0;
  const guarded = createGuardedFetch(fakeFetch((url) => {
    calls += 1;
    if (url === "https://example.com/a") return okResponse("", 302, { location: "https://example.com/b" });
    if (url === "https://example.com/b") return okResponse("", 302, { location: "http://127.0.0.1/evil" });
    return okResponse("final");
  }), { lookup: publicLookup });
  await expect(guarded("https://example.com/a")).rejects.toThrow(/内网|本机/);
  expect(calls).toBe(2);

  let hops = 0;
  const chain = createGuardedFetch(fakeFetch((url) => {
    hops += 1;
    const n = Number(url.split("/hop")[1]);
    if (Number.isInteger(n) && n < 5) return okResponse("", 302, { location: `https://example.com/hop${n + 1}` });
    return okResponse("done");
  }), { lookup: publicLookup, maxRedirects: 3 });
  const res = await chain("https://example.com/hop0");
  expect(res.status).toBe(302);
  expect(hops).toBe(4);
});

test("guarded-fetch：跨域重定向丢弃 Authorization/Cookie", async () => {
  const seen: Record<string, string>[] = [];
  const guarded = createGuardedFetch(fakeFetch((url, init) => {
    const headers = new Headers(init?.headers);
    seen.push({ url, auth: headers.get("authorization") ?? "", cookie: headers.get("cookie") ?? "" });
    if (url === "https://example.com/a") return okResponse("", 302, { location: "https://other.example/b" });
    return okResponse("ok");
  }), { lookup: async (host) => host.endsWith(".example") || host === "example.com" ? [{ address: "93.184.216.34", family: 4 }] : [] });
  await guarded("https://example.com/a", { headers: { authorization: "Bearer capy_secret", cookie: "__client=x" } });
  expect(seen[1]?.auth).toBe("");
  expect(seen[1]?.cookie).toBe("");
});

test("guarded-fetch：presign 模式要求 https:443、0 跳重定向", async () => {
  const put = createGuardedFetch(fakeFetch(() => okResponse("ok")), {
    lookup: publicLookup,
    requireHttps: true,
    allowPorts: [443],
    maxRedirects: 0,
    timeoutMs: 60_000,
  });
  await expect(put("http://example.com/x", { method: "PUT" })).rejects.toThrow(/https/);
  await expect(put("https://example.com:8443/x", { method: "PUT" })).rejects.toThrow(/端口/);
  const res = await put("https://example.com/x", { method: "PUT" });
  expect(res.status).toBe(200);
  const redir = createGuardedFetch(fakeFetch(() => okResponse("", 302, { location: "https://example.com/y" })), {
    lookup: publicLookup,
    requireHttps: true,
    allowPorts: [443],
    maxRedirects: 0,
  });
  const r = await redir("https://example.com/x", { method: "PUT" });
  expect(r.status).toBe(302);
});

test("guarded-fetch：超时 abort（15s 默认可注入短超时验证）", async () => {
  const slow = createGuardedFetch(fakeFetch(async (_url, init) => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 5000);
      init?.signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("aborted", "AbortError")); }, { once: true });
    });
    return okResponse();
  }), { lookup: publicLookup, timeoutMs: 50 });
  await expect(slow("https://example.com/slow")).rejects.toThrow();
});

test("guarded-fetch：skipDnsCheck 豁免 DNS 解析判定，但 https/端口/userinfo 照常拦（预签名 PUT）", async () => {
  // 代理环境会把域名解析到 198.18.169.x 这类禁段；Capy 签发的 URL 不走 DNS 判定。
  const proxyLookup: GuardedLookup = async () => [{ address: "198.18.169.5", family: 4 }];
  const presign = createGuardedFetch(fakeFetch(() => okResponse()), {
    lookup: proxyLookup,
    skipDnsCheck: true,
    requireHttps: true,
    allowPorts: [443],
    maxRedirects: 0,
    timeoutMs: 60_000,
  });
  const res = await presign("https://presign.example.com/up/x.png", { method: "PUT" });
  expect(res.status).toBe(200);
  // 对照：不豁免时同一解析结果被拒。
  const strict = createGuardedFetch(fakeFetch(() => okResponse()), { lookup: proxyLookup });
  await expect(strict("https://presign.example.com/up/x.png")).rejects.toThrow(/内网/);
  // 豁免只针对 DNS：https-only、端口、userinfo 仍拦。
  await expect(presign("http://presign.example.com/up/x.png", { method: "PUT" })).rejects.toThrow(/https/);
  await expect(presign("https://presign.example.com:8443/up/x.png", { method: "PUT" })).rejects.toThrow(/端口/);
  await expect(presign("https://user:pass@presign.example.com/up/x.png", { method: "PUT" })).rejects.toThrow();
});
