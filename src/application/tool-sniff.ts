import type { ChatEvent } from "../domain/chat.ts";
import type { ToolParseResult } from "../ports/tool-bridge.ts";
import { parseToolCalls } from "./tools.ts";

/** 前缀嗅探结果：确认是工具调用，或按普通文本流式透传。 */
export type SniffResult =
  | { readonly kind: "tool"; readonly text: string; readonly calls: ToolParseResult["calls"] }
  | { readonly kind: "text"; readonly events: AsyncIterable<ChatEvent> };

/** 对象缓冲上限（字节）：只有「首个非空白字符是 `{`」时才缓冲，普通回答不受影响。 */
export const SNIFF_LIMIT_BYTES = 64 * 1024;

const utf8 = new TextEncoder();
function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/** 增量括号扫描器：跨多次 delta 保持状态，整体 O(n)。 */
class ObjectScanner {
  private depth = 0;
  private started = false;
  private inString = false;
  private escaped = false;
  private closed = false;

  feed(text: string): void {
    for (const ch of text) {
      if (this.closed) return;
      if (this.inString) {
        if (this.escaped) this.escaped = false;
        else if (ch === "\\") this.escaped = true;
        else if (ch === '"') this.inString = false;
        continue;
      }
      if (ch === '"') this.inString = true;
      else if (ch === "{") {
        this.depth += 1;
        this.started = true;
      } else if (ch === "}") {
        this.depth -= 1;
        if (this.started && this.depth === 0) this.closed = true;
      }
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/**
 * 工具前缀嗅探（H-12）。
 *
 * 先缓冲到首个非空白字符：
 *  - 不是 `{` → 立刻按文本流式透传（含已缓冲事件，零额外延迟）；
 *  - 是 `{` → 最多缓冲 `limitBytes`（按字节计），尝试解析完整 `tool_calls` 信封；
 *    闭合后不是合法工具调用、超限、或流结束仍未闭合 → 都按文本透传。
 *
 * 返回的 `events` 会**重放已缓冲事件并继续消费同一个上游迭代器**，
 * 不会二次建线程。
 */
export async function sniffToolPrefix(
  events: AsyncIterable<ChatEvent>,
  allowedNames: readonly string[],
  limitBytes: number = SNIFF_LIMIT_BYTES,
): Promise<SniffResult> {
  const iterator = events[Symbol.asyncIterator]();
  const buffered: ChatEvent[] = [];
  const scanner = new ObjectScanner();
  let buffer = "";
  let bufferBytes = 0;

  const asText = (): SniffResult => ({ kind: "text", events: replay(buffered, iterator) });

  for (;;) {
    let step: IteratorResult<ChatEvent>;
    try {
      step = await iterator.next();
    } catch {
      return asText();
    }
    if (step.done) return asText();
    const event = step.value;
    buffered.push(event);

    if (event.type === "delta") {
      buffer += event.text;
      bufferBytes += byteLength(event.text);
      const leading = buffer.trimStart();
      if (leading === "") continue;
      if (leading[0] !== "{") return asText();
      scanner.feed(event.text);
      if (scanner.isClosed) {
        const candidate = buffer.trim();
        const parsed = parseToolCalls(candidate, allowedNames);
        if (!parsed) return asText();
        await closeQuietly(iterator);
        return { kind: "tool", text: candidate, calls: parsed.calls };
      }
      if (bufferBytes > limitBytes) return asText();
      continue;
    }

    // final / error / done 在任何对象闭合前到达：整段按文本透传。
    return asText();
  }
}

async function closeQuietly(iterator: AsyncIterator<ChatEvent>): Promise<void> {
  try {
    await iterator.return?.(undefined);
  } catch {
    // 上游已经结束或不可关闭：忽略。
  }
}

/**
 * 先逐字重放已缓冲的原始事件，再继续消费同一个迭代器。
 * try/finally：调用方中途取消时，把 return() 传给底层迭代器（M-11）。
 */
async function* replay(
  buffered: readonly ChatEvent[],
  iterator: AsyncIterator<ChatEvent>,
): AsyncIterable<ChatEvent> {
  try {
    for (const event of buffered) yield event;
    for (;;) {
      const step = await iterator.next();
      if (step.done) return;
      yield step.value;
    }
  } finally {
    try {
      await iterator.return?.(undefined);
    } catch {
      // 上游已经结束或不可关闭：忽略。
    }
  }
}
