import { expect, test } from "bun:test";

import {
  MAX_429_RETRIES,
  parseRetryAfterMs,
  requestJson,
  retryDelayMs,
} from "../../src/adapters/platform/http.ts";

function headers(init: Record<string, string> = {}): Headers {
  return new Headers(init);
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

test("parseRetryAfterMs：秒数 / HTTP 日期 / 无效值", () => {
  expect(parseRetryAfterMs("2")).toBe(2000);
  expect(parseRetryAfterMs("0")).toBe(0);
  expect(parseRetryAfterMs(null)).toBeNull();
  expect(parseRetryAfterMs("")).toBeNull();
  expect(parseRetryAfterMs("abc")).toBeNull();
  expect(parseRetryAfterMs("-5")).toBeNull();
  // 超过上限封顶 30s
  expect(parseRetryAfterMs("120")).toBe(30_000);
  // HTTP 日期：相对 now 的毫秒数
  const now = Date.parse("2026-11-21T00:00:00.000Z");
  expect(parseRetryAfterMs("Sat, 21 Nov 2026 00:00:05 GMT", now)).toBe(5000);
  // 过去的日期 → 0
  expect(parseRetryAfterMs("Sat, 21 Nov 2026 00:00:00 GMT", now + 1000)).toBe(0);
  expect(parseRetryAfterMs("not a date")).toBeNull();
});

test("retryDelayMs：优先 Retry-After，否则 1s/2s 退避", () => {
  expect(retryDelayMs(headers({ "retry-after": "3" }), 1)).toBe(3000);
  expect(retryDelayMs(headers({ "retry-after": "120" }), 1)).toBe(30_000);
  expect(retryDelayMs(headers(), 1)).toBe(1000);
  expect(retryDelayMs(headers(), 2)).toBe(2000);
  expect(retryDelayMs(headers({ "retry-after": "bad" }), 1)).toBe(1000);
});

test("requestJson：429 按 Retry-After 重试，最多 2 次，第三次 200 成功", async () => {
  const calls: number[] = [];
  const delays: number[] = [];
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n += 1;
    calls.push(n);
    if (n <= 2) return jsonResponse(429, { error: "slow down" }, { "retry-after": "0" });
    return jsonResponse(200, { ok: true });
  }) as unknown as typeof fetch;
  const sleep = async (ms: number) => {
    delays.push(ms);
  };
  const result = await requestJson(fetchImpl, "https://example.test/x", {}, 30_000, {
    maxRetries: MAX_429_RETRIES,
    sleep,
  });
  expect(result.response.status).toBe(200);
  expect(result.body).toEqual({ ok: true });
  expect(calls).toEqual([1, 2, 3]);
  expect(delays).toEqual([0, 0]);
});

test("requestJson：429 一直失败时只发 3 次请求（1 次 + 2 次重试），返回 429 响应", async () => {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n += 1;
    return jsonResponse(429, { error: "slow down" }, { "retry-after": "0" });
  }) as unknown as typeof fetch;
  const result = await requestJson(fetchImpl, "https://example.test/x", {}, 30_000, {
    maxRetries: MAX_429_RETRIES,
    sleep: async () => {},
  });
  expect(result.response.status).toBe(429);
  expect(n).toBe(3);
});

test("requestJson：401 不重试，立即返回", async () => {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n += 1;
    return jsonResponse(401, { error: "unauthorized" });
  }) as unknown as typeof fetch;
  const result = await requestJson(fetchImpl, "https://example.test/x", {}, 30_000, {
    maxRetries: MAX_429_RETRIES,
    sleep: async () => {},
  });
  expect(result.response.status).toBe(401);
  expect(n).toBe(1);
});

test("requestJson：500 不重试，立即返回", async () => {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n += 1;
    return jsonResponse(500, { error: "boom" });
  }) as unknown as typeof fetch;
  const result = await requestJson(fetchImpl, "https://example.test/x", {}, 30_000, {
    maxRetries: MAX_429_RETRIES,
    sleep: async () => {},
  });
  expect(result.response.status).toBe(500);
  expect(n).toBe(1);
});

test("requestJson：默认不重试（不传 retry 选项）", async () => {
  let n = 0;
  const fetchImpl = (async (): Promise<Response> => {
    n += 1;
    return jsonResponse(429, { error: "slow down" });
  }) as unknown as typeof fetch;
  const result = await requestJson(fetchImpl, "https://example.test/x", {});
  expect(result.response.status).toBe(429);
  expect(n).toBe(1);
});

test("requestJson：重试等待时调用方取消，立即停止重试（不再发请求）", async () => {
  const controller = new AbortController();
  let calls = 0;
  const fetchImpl = (async (): Promise<Response> => {
    calls += 1;
    return jsonResponse(429, { error: "slow down" }, { "retry-after": "5" });
  }) as unknown as typeof fetch;
  const sleep = async (_ms: number, signal?: AbortSignal) => {
    // 模拟真实 sleep：监听取消
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new DOMException("Aborted", "AbortError"));
      signal?.addEventListener("abort", onAbort, { once: true });
      setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, 50);
    });
  };
  const promise = requestJson(fetchImpl, "https://example.test/x", { signal: controller.signal }, 30_000, {
    maxRetries: MAX_429_RETRIES,
    sleep,
  });
  controller.abort();
  // 调用方取消与 fetch 中断走同一映射：上游不可用；关键是重试立即停止
  await expect(promise).rejects.toMatchObject({ name: "CapyError", kind: "upstream_unavailable" });
  expect(calls).toBe(1);
});
