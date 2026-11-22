import { expect, test } from "bun:test";

import {
  createProxyFetch,
  describeProxy,
  resolveProxyUrl,
} from "../../src/adapters/platform/proxy-fetch.ts";

test("proxy：describeProxy 只输出 scheme://host:port，不带凭据", () => {
  expect(describeProxy("http://user:secretpass@proxy.example.com:8080")).toBe("http://proxy.example.com:8080");
  expect(describeProxy("https://proxy.example.com")).toBe("https://proxy.example.com:443");
  expect(describeProxy("proxy.example.com:3128")).toBe("http://proxy.example.com:3128");
  expect(describeProxy("")).toBe("configured");
  expect(describeProxy("not a url :::")).toBe("configured");
});

test("proxy：MAGPIE_CAPY_PROXY=off 真正禁用，不再读 HTTPS_PROXY", () => {
  const env = { MAGPIE_CAPY_PROXY: "off", HTTPS_PROXY: "http://proxy.example.com:8080" };
  expect(resolveProxyUrl({ env })).toBe("");
  expect(resolveProxyUrl({ env: { MAGPIE_CAPY_PROXY: "false", HTTPS_PROXY: "http://proxy.example.com:8080" } })).toBe("");
  expect(resolveProxyUrl({ env: { HTTPS_PROXY: "http://proxy.example.com:8080" } })).toBe("http://proxy.example.com:8080");
  expect(resolveProxyUrl({ proxy: false, env })).toBe("");
  expect(resolveProxyUrl({ proxy: "off", env })).toBe("");
});

test("proxy：代理失败默认 fail-closed，不静默直连", async () => {
  const previous = process.env.MAGPIE_CAPY_PROXY_FALLBACK;
  delete process.env.MAGPIE_CAPY_PROXY_FALLBACK;
  try {
    let calls = 0;
    const baseFetch = (async () => {
      calls += 1;
      throw new Error("Unable to connect to proxy server");
    }) as unknown as typeof fetch;
    const warns: string[] = [];
    const proxied = createProxyFetch(baseFetch, "http://proxy.example.com:8080", {
      onWarn: (m) => warns.push(m),
    });
    await expect(proxied("https://example.com/x")).rejects.toThrow(/proxy/i);
    expect(calls).toBe(1);
    expect(warns.join(" ")).not.toContain("proxy.example.com:8080");
    // warn 里只应出现脱敏后的 label，不应出现完整代理 URL（无凭据场景也一样）。
    expect(warns.join(" ")).not.toMatch(/secret|password/);
  } finally {
    if (previous !== undefined) process.env.MAGPIE_CAPY_PROXY_FALLBACK = previous;
  }
});

test("proxy：MAGPIE_CAPY_PROXY_FALLBACK=direct 才允许直连兜底", async () => {
  const previous = process.env.MAGPIE_CAPY_PROXY_FALLBACK;
  process.env.MAGPIE_CAPY_PROXY_FALLBACK = "direct";
  try {
    const seen: (RequestInit & { proxy?: string })[] = [];
    const baseFetch = (async (_input: unknown, init: RequestInit & { proxy?: string } = {}) => {
      seen.push(init);
      if (init.proxy) throw new Error("Unable to connect to proxy server");
      return new Response("direct-ok");
    }) as unknown as typeof fetch;
    const warns: string[] = [];
    const proxied = createProxyFetch(baseFetch, "http://proxy.example.com:8080", {
      onWarn: (m) => warns.push(m),
    });
    const res = await proxied("https://example.com/x");
    expect(await res.text()).toBe("direct-ok");
    expect(seen.length).toBe(2);
    expect(seen[1]?.proxy).toBeUndefined();
    expect(warns.join(" ")).toContain("http://proxy.example.com:8080");
  } finally {
    if (previous === undefined) delete process.env.MAGPIE_CAPY_PROXY_FALLBACK;
    else process.env.MAGPIE_CAPY_PROXY_FALLBACK = previous;
  }
});

test("proxy：非代理错误直接抛，不兜底、不二次重发", async () => {
  const previous = process.env.MAGPIE_CAPY_PROXY_FALLBACK;
  delete process.env.MAGPIE_CAPY_PROXY_FALLBACK;
  try {
    let calls = 0;
    const baseFetch = (async () => {
      calls += 1;
      throw new Error("boom: TLS handshake failed");
    }) as unknown as typeof fetch;
    const proxied = createProxyFetch(baseFetch, "http://proxy.example.com:8080", {});
    await expect(proxied("https://example.com/x")).rejects.toThrow("TLS handshake");
    expect(calls).toBe(1);
  } finally {
    if (previous !== undefined) process.env.MAGPIE_CAPY_PROXY_FALLBACK = previous;
  }
});
