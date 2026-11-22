import { CapyError } from "../domain/errors.ts";

export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

export interface SseParserOptions {
  /** 单帧缓冲上限（字节）；超过即认为上游不是 SSE。 */
  readonly maxBufferBytes?: number;
}

const DEFAULT_MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const LINE_BREAK = /\r\n|\r|\n/u;
const RETRY_DIGITS = /^\d+$/u;

const utf8 = new TextEncoder();
function byteLength(text: string): number {
  return utf8.encode(text).length;
}

/**
 * 找"空行"（两个相邻的行结束符）。
 * 不能用 `/(?:\r\n|\r|\n){2,}/`：回溯会把一个 `\r\n` 当成两个换行，
 * 于是每一行都被当成帧边界。
 */
function findFrameBoundary(buffer: string): { index: number; length: number } | null {
  let cursor = 0;
  for (;;) {
    const first = LINE_BREAK.exec(buffer.slice(cursor));
    if (!first) return null;
    const start = cursor + first.index;
    const afterFirst = start + first[0].length;
    const second = LINE_BREAK.exec(buffer.slice(afterFirst));
    if (!second) return null;
    if (second.index === 0) {
      return { index: start, length: first[0].length + second[0].length };
    }
    cursor = afterFirst;
  }
}

/**
 * 增量 SSE 解析器。
 * 只处理 `event:` / `data:` / `id:` / `retry:`；注释与未知字段忽略。
 * 行结束符按 `\r\n` / `\r` / `\n` 三种切分；缓冲按字节计上限 4MB。
 */
export class SseParser {
  private buffer = "";
  private bufferBytes = 0;
  private readonly maxBufferBytes: number;

  constructor(options: SseParserOptions = {}) {
    this.maxBufferBytes = Math.max(1024, options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES);
  }

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    this.bufferBytes += byteLength(chunk);
    if (this.bufferBytes > this.maxBufferBytes) {
      this.buffer = "";
      this.bufferBytes = 0;
      throw new CapyError(
        "upstream_unavailable",
        `SSE 帧超过 ${Math.round(this.maxBufferBytes / (1024 * 1024))} MB 上限，上游可能不是事件流`,
      );
    }
    const frames: SseFrame[] = [];
    for (;;) {
      const boundary = findFrameBoundary(this.buffer);
      if (!boundary) break;
      const raw = this.buffer.slice(0, boundary.index);
      const consumed = this.buffer.slice(0, boundary.index + boundary.length);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.bufferBytes -= byteLength(consumed);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  end(): SseFrame[] {
    const raw = this.buffer;
    this.buffer = "";
    this.bufferBytes = 0;
    const frame = raw.trim() ? parseFrame(raw) : null;
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "";
  // null 哨兵区分"还没有 data 行"与"data 行是空值"：
  // 首行 `data:` 为空时，后续 data 行要接 `\n`，不能把空行吞掉。
  let data: string | null = null;
  let id = "";
  let retry: number | undefined;

  for (const line of raw.split(LINE_BREAK)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /u, "") : "";
    if (field === "event") event = value;
    else if (field === "data") data = data === null ? value : `${data}\n${value}`;
    else if (field === "id") id = value;
    else if (field === "retry") {
      // 只接受十进制数字：`0x10` / `1e3` 都按非法忽略。
      const text = value.trim();
      if (RETRY_DIGITS.test(text)) {
        const n = Number(text);
        if (Number.isFinite(n) && n >= 0) retry = n;
      }
    }
  }

  if (!event && data === null && retry === undefined) return null;
  return {
    event,
    data: data ?? "",
    ...(id ? { id } : {}),
    ...(retry === undefined ? {} : { retry }),
  };
}

/** 把字节流解成 SSE 帧。 */
export async function* decodeSseStream(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<SseFrame> {
  const decoder = new TextDecoder();
  const parser = new SseParser();
  for await (const chunk of source) {
    for (const frame of parser.feed(decoder.decode(chunk, { stream: true }))) {
      yield frame;
    }
  }
  const tail = decoder.decode();
  for (const frame of parser.feed(tail)) yield frame;
  for (const frame of parser.end()) yield frame;
}
