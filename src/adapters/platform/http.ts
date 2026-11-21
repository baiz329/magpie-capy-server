import { CapyError } from "../../domain/errors.ts";

export interface JsonResponse {
  readonly response: Response;
  readonly body: unknown;
  readonly text: string;
}

/** 429 有界重试：最多重试次数（只针对 429；401/其它状态不重试）。 */
export const MAX_429_RETRIES = 2;
/** Retry-After 的等待上限，避免上游给一个很大的值把请求拖死。 */
export const MAX_RETRY_AFTER_MS = 30_000;

export type SleepFn = (ms: number, signal?: AbortSignal) => Promise<void>;

export interface Retry429Options {
  /** 最多重试次数，默认 MAX_429_RETRIES。只针对 HTTP 429。 */
  readonly maxRetries?: number;
  /** 等待函数，默认 setTimeout 实现；测试可注入 fake。 */
  readonly sleep?: SleepFn;
}

/** 解析 Retry-After（秒数或 HTTP 日期）→ 毫秒；缺失/无效返回 null。 */
export function parseRetryAfterMs(value: string | null, nowMs: number = Date.now()): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  // 只接受标准 IMF-fixdate（"Sat, 21 Nov 2026 00:00:05 GMT"），避免
  // Date.parse 把 "-5" 这类非法值误解析成日期。
  if (!/^[A-Za-z]{3},\s\d{1,2}\s[A-Za-z]{3}\s\d{4}\s\d{2}:\d{2}:\d{2}\sGMT$/.test(trimmed)) return null;
  const dateMs = Date.parse(trimmed);
  if (Number.isNaN(dateMs)) return null;
  return Math.max(0, Math.min(dateMs - nowMs, MAX_RETRY_AFTER_MS));
}

/**
 * 429 重试等待：优先用上游 Retry-After；没有时按 1s/2s 退避。
 * attempt 从 1 开始（第 1 次重试）。
 */
export function retryDelayMs(headers: Headers, attempt: number, nowMs: number = Date.now()): number {
  const after = parseRetryAfterMs(headers.get("retry-after"), nowMs);
  if (after !== null) return after;
  return Math.min(1000 * Math.max(1, attempt), MAX_RETRY_AFTER_MS);
}

/** 默认等待：setTimeout + AbortSignal，取消时抛 AbortError。 */
export async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 只针对 HTTP 429 的有界重试：每次 429 且还有重试次数时，按 Retry-After
 *（没有则 1s/2s 退避）等待后重发。其它状态直接返回，不重试。
 * fetch 本身抛错（网络/取消）直接透传，由调用方映射。
 */
export async function fetchWith429Retry(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: Retry429Options = {},
): Promise<Response> {
  const maxRetries = options.maxRetries ?? MAX_429_RETRIES;
  const sleep = options.sleep ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    const response = await fetchImpl(url, init);
    if (response.status !== 429 || attempt >= maxRetries) return response;
    const delay = retryDelayMs(response.headers, attempt + 1);
    attempt += 1;
    // 读掉/取消 429 响应体，避免连接泄漏
    await response.body?.cancel().catch(() => {});
    await sleep(delay, init.signal ?? undefined);
  }
}

export async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
  retry?: Retry429Options,
): Promise<JsonResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  const signal = init.signal;
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    let response: Response;
    try {
      response = retry
        ? await fetchWith429Retry(fetchImpl, url, { ...init, signal: controller.signal }, retry)
        : await fetchImpl(url, { ...init, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) {
        throw new CapyError("upstream_timeout", "连接 Capy 超时，请检查网络/代理后重试", { cause: error });
      }
      throw new CapyError("upstream_unavailable", `连接 Capy 失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    const text = await response.text();
    let body: unknown = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { response, body, text };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
