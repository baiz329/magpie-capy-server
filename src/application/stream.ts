import type { ChatEvent } from "../domain/chat.ts";
import { CapyError } from "../domain/errors.ts";
import type { SseFrame } from "../protocol/sse.ts";

interface AssistantPayload {
  readonly callId?: unknown;
  readonly text?: unknown;
}

interface TranscriptPayload {
  readonly source?: unknown;
  readonly text?: unknown;
  readonly callId?: unknown;
}

interface ErrorPayload {
  readonly code?: unknown;
  readonly message?: unknown;
}

interface TurnPayload {
  readonly phase?: unknown;
  readonly outcome?: unknown;
}

interface RunPayload {
  readonly phase?: unknown;
}

/**
 * Capy Public SSE → ChatEvent。
 *
 * - assistant 帧：按 callId 累积；若服务端一次给全文，用前缀去重；
 *   更短的前缀快照是服务端"修正"（回退），只更新累积，不重复下发 delta；
 *   非前缀的增量（哪怕与已发内容重复）照常累积下发，不吞掉。
 * - transcript(source=assistant)：最终文本校正，只认当前 callId 的 final；
 *   新 callId 出现时清掉旧 final，避免旧终态覆盖新一轮 delta。
 * - error：映射成 CapyError。
 * - done / run(phase=end)：标记"上游已正常完成"，由 finish() 产出 final + done。
 * - turn(phase=end, outcome=dropped)：本轮文本不可信，清空累积。
 * - finish() 仅在见过终态时产出 final + done；否则产出 error，
 *   绝不把断流包装成假成功。
 */
export class PublicSseNormalizer {
  private readonly partial = new Map<string, string>();
  private finalText = "";
  private lastText = "";
  private lastCallId = "";
  private sawDelta = false;
  private sawDone = false;
  private sawRunEnd = false;
  private dropped = false;
  private errored = false;
  private finished = false;
  /** finish() 是否已经产出过终态事件（保证幂等）。 */
  private finishEmitted = false;

  push(frame: SseFrame): ChatEvent[] {
    if (this.errored || this.finished) return [];
    switch (frame.event) {
      case "assistant":
        return this.onAssistant(parseJson<AssistantPayload>(frame.data));
      case "transcript":
        return this.onTranscript(parseJson<TranscriptPayload>(frame.data));
      case "error":
        return this.onError(parseJson<ErrorPayload>(frame.data));
      case "turn":
        this.onTurn(parseJson<TurnPayload>(frame.data));
        return [];
      case "run":
        this.onRun(parseJson<RunPayload>(frame.data));
        return [];
      case "done":
        // done 帧本身不产出事件；真正的 final+done 由 finish() 统一产出，
        // 保证事件序列仍是 delta…final,done。
        this.sawDone = true;
        this.finished = true;
        return [];
      default:
        // status / heartbeat / retry 等不进事件流。
        return [];
    }
  }

  finish(): ChatEvent[] {
    if (this.errored || this.finishEmitted) return [];
    this.finishEmitted = true;
    if (!this.completed) {
      this.finished = true;
      return [{
        type: "error",
        error: new CapyError("upstream_unavailable", "上游流在完成前中断"),
      }];
    }
    const events: ChatEvent[] = [];
    const text = this.dropped ? "" : (this.finalText || this.lastText);
    if (text) events.push({ type: "final", text });
    events.push({ type: "done" });
    this.finished = true;
    return events;
  }

  /** done 帧或 run(phase=end) 任一到达即视为完成；调用方可据此断开上游读取。 */
  get completed(): boolean {
    return this.sawDone || this.sawRunEnd;
  }

  get text(): string {
    return this.dropped ? "" : (this.finalText || this.lastText);
  }

  get hasError(): boolean {
    return this.errored;
  }

  private onAssistant(payload: AssistantPayload | null): ChatEvent[] {
    if (!payload) return [];
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    const piece = typeof payload.text === "string" ? payload.text : "";
    if (!callId || !piece) return [];

    // 新 callId 出现：旧一轮的 final 不能再当终态。
    if (this.lastCallId && callId !== this.lastCallId) {
      this.finalText = "";
    }
    this.lastCallId = callId;

    const previous = this.partial.get(callId) ?? "";
    // 更短且是已累积文本的前缀 → 服务端在"修正"（回退到更短的快照），
    // 只更新累积，不重复下发 delta。
    if (piece.length < previous.length && previous.startsWith(piece)) {
      this.partial.set(callId, piece);
      this.lastText = piece;
      this.dropped = false;
      return [];
    }
    const grows = piece.startsWith(previous);
    const next = grows ? piece : previous + piece;
    const delta = grows ? piece.slice(previous.length) : piece;
    this.partial.set(callId, next);
    this.lastText = next;
    this.dropped = false;
    if (!delta) return [];
    this.sawDelta = true;
    return [{ type: "delta", text: delta }];
  }

  private onTranscript(payload: TranscriptPayload | null): ChatEvent[] {
    if (!payload || payload.source !== "assistant") return [];
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text) return [];
    const callId = typeof payload.callId === "string" ? payload.callId : "";
    // final 只认当前 callId：上一轮的终态不能覆盖新一轮已发 delta。
    if (callId && this.lastCallId && callId !== this.lastCallId) return [];
    if (callId) this.lastCallId = callId;
    const previous = this.lastText;
    this.finalText = text;
    this.lastText = text;
    this.dropped = false;

    if (!this.sawDelta) {
      this.sawDelta = true;
      return [{ type: "delta", text }];
    }
    if (previous && text.startsWith(previous) && text.length > previous.length) {
      return [{ type: "delta", text: text.slice(previous.length) }];
    }
    return [];
  }

  private onTurn(payload: TurnPayload | null): void {
    if (payload?.phase !== "end" || payload.outcome !== "dropped") return;
    // 本轮被上游丢弃：清空该轮累积，后续 finish() 不能把这段文本当最终答案。
    this.partial.clear();
    this.finalText = "";
    this.lastText = "";
    this.lastCallId = "";
    this.sawDelta = false;
    this.dropped = true;
  }

  private onRun(payload: RunPayload | null): void {
    if (payload?.phase === "end") this.sawRunEnd = true;
  }

  private onError(payload: ErrorPayload | null): ChatEvent[] {
    const code = typeof payload?.code === "string" ? payload.code : "";
    const message = typeof payload?.message === "string" && payload.message
      ? payload.message
      : "Capy 原生流返回错误";
    this.errored = true;
    return [{ type: "error", error: mapStreamError(code, message) }];
  }
}

function mapStreamError(code: string, message: string): CapyError {
  if (code === "region_unsupported") {
    return new CapyError("region_unsupported", message, { detail: code });
  }
  if (code === "unauthorized") {
    return new CapyError("sign_in_required", message, { detail: code });
  }
  if (code === "forbidden") {
    return new CapyError("upstream_error", message, { status: 403, detail: code });
  }
  if (code === "rate_limited") {
    return new CapyError("rate_limited", message, { detail: code });
  }
  return new CapyError("upstream_error", message, { detail: code });
}

function parseJson<T>(value: string): T | null {
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as T) : null;
  } catch {
    return null;
  }
}
