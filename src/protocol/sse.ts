export interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly id?: string;
  readonly retry?: number;
}

/**
 * 增量 SSE 解析器。
 * 只处理 `event:` / `data:` / `id:` / `retry:`；注释与未知字段忽略。
 */
export class SseParser {
  private buffer = "";

  feed(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];
    for (;;) {
      const match = /\r?\n\r?\n/u.exec(this.buffer);
      if (!match) break;
      const raw = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      const frame = parseFrame(raw);
      if (frame) frames.push(frame);
    }
    return frames;
  }

  end(): SseFrame[] {
    const raw = this.buffer;
    this.buffer = "";
    const frame = raw.trim() ? parseFrame(raw) : null;
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "";
  let data = "";
  let id = "";
  let retry: number | undefined;

  for (const line of raw.split(/\r?\n/u)) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon >= 0 ? line.slice(0, colon) : line;
    const value = colon >= 0 ? line.slice(colon + 1).replace(/^ /u, "") : "";
    if (field === "event") event = value;
    else if (field === "data") data = data ? `${data}\n${value}` : value;
    else if (field === "id") id = value;
    else if (field === "retry") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) retry = n;
    }
  }

  if (!event && !data && retry === undefined) return null;
  return {
    event,
    data,
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
