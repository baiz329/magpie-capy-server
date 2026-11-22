import type { ModelDefaultInfo, RawModel } from "../../domain/model.ts";
import type { Balance, UsageTotals } from "../../domain/usage.ts";
import { CapyError, mapUpstream } from "../../domain/errors.ts";
import type {
  CapyPublicPort,
  UpstreamSseFrame,
  UploadCandidate,
  UploadedFile,
} from "../../ports/capy-public.ts";
import { decodeSseStream } from "../../protocol/sse.ts";
import { createGuardedFetch, type GuardedLookup } from "../platform/guarded-fetch.ts";
import { fetchWith429Retry, MAX_429_RETRIES, requestJson } from "../platform/http.ts";
import { CAPY_PUBLIC, publicHeaders } from "./endpoints.ts";

function rawModels(items: unknown): RawModel[] {
  if (!Array.isArray(items)) return [];
  return items.flatMap((item): RawModel[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    if (!id) return [];
    const modes = Array.isArray(record.reasoningModes)
      ? record.reasoningModes.filter((mode): mode is string => typeof mode === "string")
      : undefined;
    return [{
      id,
      ...(typeof record.name === "string" ? { name: record.name } : {}),
      ...(modes ? { reasoningModes: modes } : {}),
    }];
  });
}

function modelDefault(value: unknown): ModelDefaultInfo | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const modelId = typeof record.modelId === "string" ? record.modelId : "";
  if (!modelId) return undefined;
  const skipped = Array.isArray(record.skipped)
    ? record.skipped.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const s = item as Record<string, unknown>;
      return [{
        modelId: String(s.modelId ?? ""),
        source: String(s.source ?? ""),
        reason: String(s.reason ?? ""),
      }];
    })
    : [];
  return {
    modelId,
    source: typeof record.source === "string" ? record.source : "",
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

export interface CapyPublicClientOptions {
  /** SSE 连续无数据的空闲上限（毫秒）；超过即断开并报 upstream_timeout。 */
  readonly sseIdleMs?: number;
  /** 预签名 PUT 的 DNS 解析（测试注入；默认 node:dns）。 */
  readonly presignLookup?: GuardedLookup;
}

/** SSE 空闲 deadline 默认值（M-10）：长推理也应有心跳/数据，2 分钟无数据即断开。 */
export const DEFAULT_SSE_IDLE_MS = 120_000;

export class CapyPublicClient implements CapyPublicPort {
  private readonly fetchImpl: typeof fetch;
  /**
   * 预签名 PUT 专用（H-01/M-12）：上游给的 target.url 由服务端签发，
   * 不是用户可控输入，因此豁免 DNS 解析判定——代理环境会把域名解析到
   * 198.18.169.x 这类禁段，不豁免会把附件上传整个堵死。
   * 仍保留 https:443、0 跳重定向、60s 超时；字面量私网主机名照常拦。
   * 用户提供的附件下载 URL 仍走完整 DNS 判定（见 entry 的 attachmentFetch）。
   */
  private readonly presignPut: typeof fetch;
  private readonly sseIdleMs: number;

  constructor(fetchImpl: typeof fetch = fetch, options: CapyPublicClientOptions = {}) {
    this.fetchImpl = fetchImpl;
    this.presignPut = createGuardedFetch(fetchImpl, {
      requireHttps: true,
      allowPorts: [443],
      maxRedirects: 0,
      timeoutMs: 60_000,
      skipDnsCheck: true,
      ...(options.presignLookup ? { lookup: options.presignLookup } : {}),
    });
    this.sseIdleMs = Math.max(1, options.sseIdleMs ?? DEFAULT_SSE_IDLE_MS);
  }

  async listModels(apiKey: string, signal?: AbortSignal): Promise<{
    readonly items: readonly RawModel[];
    readonly default?: ModelDefaultInfo;
  }> {
    const { response, body, text } = await requestJson(
      this.fetchImpl,
      `${CAPY_PUBLIC}/models`,
      { method: "GET", headers: publicHeaders(apiKey), ...(signal ? { signal } : {}) },
      20_000,
    );
    if (!response.ok) throw mapUpstream(response.status, body, text.slice(0, 300));
    const record = body as Record<string, unknown>;
    const fallback = modelDefault(record.default);
    return {
      items: rawModels(record.items),
      ...(fallback ? { default: fallback } : {}),
    };
  }

  async *streamThread(
    apiKey: string,
    threadId: string,
    signal?: AbortSignal,
  ): AsyncIterable<UpstreamSseFrame> {
    const url = `${CAPY_PUBLIC}/threads/${encodeURIComponent(threadId)}/stream?until=run`;
    let response: Response;
    try {
      // 初始 GET 是幂等读：429 有界重试（最多 2 次，尊重 Retry-After）；
      // 流一旦开始出数据就不再重试（见下方的 !response.ok → mapUpstream）。
      response = await fetchWith429Retry(this.fetchImpl, url, {
        method: "GET",
        headers: {
          ...publicHeaders(apiKey),
          accept: "text/event-stream",
        },
        ...(signal ? { signal } : {}),
      }, { maxRetries: MAX_429_RETRIES });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new CapyError("upstream_unavailable", `连接 Capy 流失败：${errorText(error)}`, { cause: error });
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      let body: unknown = null;
      try { body = JSON.parse(text); } catch {}
      throw mapUpstream(response.status, body, text.slice(0, 300));
    }
    if (!response.body) throw new CapyError("upstream_unavailable", "Capy 流没有响应体");
    const body = response.body;
    const idleMs = this.sseIdleMs;
    async function* chunks(): AsyncIterable<Uint8Array> {
      const reader = body.getReader();
      try {
        for (;;) {
          // 每次 read 都受空闲 deadline 约束（M-10）：流挂住不再无限等。
          const { done, value } = await readWithIdleDeadline(reader.read(), idleMs);
          if (done) return;
          if (value) yield value;
        }
      } finally {
        await reader.cancel().catch(() => undefined);
      }
    }
    for await (const frame of decodeSseStream(chunks())) {
      yield {
        event: frame.event,
        data: frame.data,
        ...(frame.id ? { id: frame.id } : {}),
      };
    }
  }

  async uploadFiles(
    apiKey: string,
    files: readonly UploadCandidate[],
    signal?: AbortSignal,
  ): Promise<readonly UploadedFile[]> {
    if (files.length === 0) return [];
    const { response, body, text } = await requestJson(
      this.fetchImpl,
      `${CAPY_PUBLIC}/files`,
      {
        method: "POST",
        headers: publicHeaders(apiKey, { "content-type": "application/json" }),
        body: JSON.stringify({
          files: files.map((file) => ({
            name: file.name,
            mediaType: file.mediaType,
            sizeBytes: file.bytes.length,
          })),
        }),
        ...(signal ? { signal } : {}),
      },
      30_000,
    );
    if (!response.ok) throw mapUpstream(response.status, body, text.slice(0, 300));
    const targets = (body as { targets?: unknown })?.targets;
    if (!Array.isArray(targets) || targets.length !== files.length) {
      throw new CapyError("upstream_error", "Capy 没有返回足够的文件上传目标");
    }
    // 先校验全部目标，再有界并发上传（P3-03：3 路，保序返回）。
    const jobs = files.map((file, i) => {
      const target = targets[i] as { fileId?: unknown; url?: unknown } | undefined;
      if (!file || !target || typeof target.fileId !== "string" || typeof target.url !== "string") {
        throw new CapyError("upstream_error", "Capy 文件上传目标缺少 fileId/url");
      }
      return { file, target: target as { fileId: string; url: string } };
    });
    const out: UploadedFile[] = new Array<UploadedFile>(jobs.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(3, jobs.length) }, async () => {
      for (;;) {
        const index = next++;
        if (index >= jobs.length) return;
        const job = jobs[index]!;
        // PUT 调用包 try/catch：60s 超时映射为 upstream_timeout（M-10）。
        let put: Response;
        try {
          put = await this.presignPut(job.target.url, {
            method: "PUT",
            headers: {
              "content-type": job.file.mediaType,
              "content-length": String(job.file.bytes.length),
            },
            body: job.file.bytes as unknown as BodyInit,
            ...(signal ? { signal } : {}),
          });
        } catch (error) {
          if (error instanceof DOMException && error.name === "TimeoutError") {
            throw new CapyError("upstream_timeout", "附件上传超时", { cause: error });
          }
          if (signal?.aborted) throw error;
          throw new CapyError("upstream_unavailable", `附件上传失败：${errorText(error)}`, { cause: error });
        }
        if (!put.ok) {
          const detail = await put.text().catch(() => "");
          throw new CapyError("upstream_error", `附件上传失败（HTTP ${put.status}）`, {
            detail: detail.slice(0, 200),
          });
        }
        out[index] = {
          fileId: job.target.fileId,
          name: job.file.name,
          mediaType: job.file.mediaType,
          sizeBytes: job.file.bytes.length,
        };
      }
    });
    await Promise.all(workers);
    return out;
  }

  async usage(apiKey: string, signal?: AbortSignal): Promise<UsageTotals> {
    const { response, body, text } = await requestJson(
      this.fetchImpl,
      `${CAPY_PUBLIC}/usage`,
      { method: "GET", headers: publicHeaders(apiKey), ...(signal ? { signal } : {}) },
      20_000,
    );
    if (!response.ok) throw mapUpstream(response.status, body, text.slice(0, 300));
    return (body ?? {}) as UsageTotals;
  }

  async balance(apiKey: string, signal?: AbortSignal): Promise<Balance> {
    const { response, body, text } = await requestJson(
      this.fetchImpl,
      `${CAPY_PUBLIC}/usage/balance`,
      { method: "GET", headers: publicHeaders(apiKey), ...(signal ? { signal } : {}) },
      20_000,
    );
    if (!response.ok) throw mapUpstream(response.status, body, text.slice(0, 300));
    return (body ?? {}) as Balance;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 单次 read 的空闲 deadline：超时即 upstream_timeout，不再无限等上游。 */
async function readWithIdleDeadline<T>(promise: Promise<T>, idleMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new CapyError(
            "upstream_timeout",
            `Capy 流超过 ${Math.round(idleMs / 1000)}s 没有数据，已断开`,
          )),
          Math.max(1, idleMs),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
