import { CapyError } from "../../domain/errors.ts";

export interface JsonResponse {
  readonly response: Response;
  readonly body: unknown;
  readonly text: string;
}

export async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit = {},
  timeoutMs = 30_000,
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
      response = await fetchImpl(url, { ...init, signal: controller.signal });
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

