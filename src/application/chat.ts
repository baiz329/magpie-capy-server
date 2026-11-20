import type { AccountSession } from "../domain/account.ts";
import { accountKey } from "../domain/account.ts";
import type { ChatEvent, ChatRequest } from "../domain/chat.ts";
import { buildPrompt } from "../domain/chat.ts";
import { isAdsModel } from "../domain/model.ts";
import { CapyError } from "../domain/errors.ts";
import type { JamCreated, JamDetail, JamFile } from "../ports/capy-app.ts";
import type { CapyAppPort } from "../ports/capy-app.ts";
import type { CapyPublicPort } from "../ports/capy-public.ts";
import type { ClockPort, IdPort } from "../ports/platform.ts";
import type { ToolBridgePort } from "../ports/tool-bridge.ts";
import { DeviceUseCase } from "./device.ts";
import { PublicSseNormalizer } from "./stream.ts";

export interface ChatUseCaseOptions {
  readonly app: CapyAppPort;
  readonly publicApi: CapyPublicPort;
  readonly device: DeviceUseCase;
  readonly ids: IdPort;
  readonly clock: ClockPort;
  readonly tools: ToolBridgePort;
  readonly toolsEnabled: boolean;
}

export interface ChatRunOptions {
  readonly signal?: AbortSignal;
  readonly files?: readonly JamFile[];
  readonly reasoningMode?: string;
  readonly promptVariant?: "minimal";
  readonly onThread?: (thread: JamCreated) => void;
  readonly onVariantFallback?: () => void;
}

interface JwtCacheEntry {
  readonly jwt: string;
  readonly expiresAt: number;
}

const JWT_TTL_MS = 50_000;

export class ChatUseCase {
  private readonly options: ChatUseCaseOptions;
  private readonly jwtCache = new Map<string, JwtCacheEntry>();

  constructor(options: ChatUseCaseOptions) {
    this.options = options;
  }

  async *stream(
    session: AccountSession,
    request: ChatRequest,
    run: ChatRunOptions = {},
  ): AsyncIterable<ChatEvent> {
    const device = await this.options.device.ensure(session, run.signal);
    const toolInstruction = this.options.toolsEnabled
      ? this.options.tools.instruction(request.tools ?? [], request.toolChoice)
      : "";
    const prompt = buildPrompt(request.messages, { toolInstruction });
    const jwt = await this.sessionJwt(session, run.signal);

    const create = async (promptVariant?: "minimal") => {
      const requestId = this.options.ids.ulid();
      return await this.options.app.createJam(jwt, session.orgId, {
        jamId: `jam_${this.options.ids.ulid()}`,
        requestId,
        clientKey: requestId,
        message: prompt,
        modelId: request.model,
        deviceId: device.id,
        ...(run.reasoningMode ? { reasoningMode: run.reasoningMode } : {}),
        ...(run.files && run.files.length > 0 ? { files: run.files } : {}),
        ...(promptVariant ? { promptVariant } : {}),
        ...(isAdsModel(request.model) ? { ads: true } : {}),
      }, run.signal);
    };

    let thread: JamCreated;
    try {
      thread = await create(run.promptVariant);
    } catch (error) {
      // minimal 是账号级开关；403 时改用 default 重试一次。
      if (run.promptVariant === "minimal" && error instanceof CapyError && error.status === 403) {
        run.onVariantFallback?.();
        thread = await create();
      } else {
        throw error;
      }
    }
    if (thread.primaryMachine.kind !== "device") {
      throw new CapyError(
        "upstream_unavailable",
        "Capy 没有把线程放到无头设备（返回了云端机器）",
      );
    }
    run.onThread?.(thread);

    // 状态检查失败就让请求失败，不静默跳过（否则 credits/desktop 阻塞会被掩盖）。
    const detail = await this.options.app.getJam(jwt, session.orgId, thread.id, run.signal);
    const blocked = askError(detail);
    if (blocked) throw blocked;

    const normalizer = new PublicSseNormalizer();
    try {
      for await (const frame of this.options.publicApi.streamThread(session.accessToken, thread.id, run.signal)) {
        for (const event of normalizer.push(frame)) yield event;
      }
      if (!normalizer.text && !normalizer.hasError) {
        const failure = await this.jamFailure(jwt, session.orgId, thread.id, run.signal);
        if (failure) {
          yield { type: "error", error: failure };
          return;
        }
      }
      for (const event of normalizer.finish()) yield event;
    } catch (error) {
      if (error instanceof CapyError) {
        yield { type: "error", error };
        return;
      }
      if (isAbort(error)) throw error;
      yield {
        type: "error",
        error: new CapyError("upstream_unavailable", errorMessage(error), { cause: error }),
      };
    }
  }

  private async jamFailure(
    jwt: string,
    orgId: string,
    jamId: string,
    signal?: AbortSignal,
  ): Promise<CapyError | null> {
    const detail = await this.options.app.getJam(jwt, orgId, jamId, signal).catch(() => null);
    const blocked = askError(detail);
    if (blocked) return blocked;
    if (detail?.status !== "failed") return null;
    const events = await this.options.app.getJamEvents(jwt, orgId, jamId, signal).catch(() => []);
    for (const event of [...events].reverse()) {
      if (event.kind !== "error") continue;
      const code = event.payload?.code ?? "";
      const message = event.payload?.message ?? "Capy 线程失败";
      return mapJamError(code, message);
    }
    return new CapyError("upstream_error", "Capy 线程失败，但没有返回错误详情");
  }

  async cancel(session: AccountSession, jamId: string): Promise<void> {
    try {
      const jwt = await this.sessionJwt(session);
      await this.options.app.interruptJam(jwt, session.orgId, jamId);
    } catch {
      // best-effort
    }
  }

  private async sessionJwt(session: AccountSession, signal?: AbortSignal): Promise<string> {
    const key = `${accountKey(session)}:${session.clerk.sessionId}`;
    const hit = this.jwtCache.get(key);
    const now = this.options.clock.now();
    if (hit && hit.expiresAt > now) return hit.jwt;
    const jwt = await this.options.app.sessionJwt(session.clerk, signal);
    this.jwtCache.set(key, { jwt, expiresAt: now + JWT_TTL_MS });
    return jwt;
  }
}

function askError(detail: JamDetail | null): CapyError | null {
  const ask = detail?.ask;
  if (!ask) return null;
  if (ask.kind === "credits") {
    return new CapyError("insufficient_quota", ask.text || "Capy 额度不足");
  }
  if (ask.kind === "desktop") {
    return new CapyError("upstream_unavailable", ask.text || "Capy 线程需要人工/桌面端操作");
  }
  return new CapyError("upstream_error", ask.text || `Capy 线程阻塞：${ask.kind}`);
}

function mapJamError(code: string, message: string): CapyError {
  if (code === "region_unsupported") return new CapyError("region_unsupported", message, { detail: code });
  if (code === "unauthorized") return new CapyError("sign_in_required", message, { detail: code });
  if (code === "forbidden") return new CapyError("upstream_error", message, { status: 403, detail: code });
  if (code === "rate_limited") return new CapyError("rate_limited", message, { detail: code });
  if (/quota|credit/iu.test(code)) return new CapyError("insufficient_quota", message, { detail: code });
  if (/ModelSelection/iu.test(code)) return new CapyError("model_not_found", message, { detail: code });
  return new CapyError("upstream_error", message, { detail: code });
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
