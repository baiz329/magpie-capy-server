import { expect, test } from "bun:test";

import { CapyError } from "../../src/domain/errors.ts";
import { decodeSseStream, SseParser } from "../../src/protocol/sse.ts";

test("SSE：帧跨 chunk 边界", () => {
  const parser = new SseParser();
  expect(parser.feed("event: assistant\ndata: {\"a\"")).toEqual([]);
  const frames = parser.feed(":1}\n\n");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.event).toBe("assistant");
  expect(frames[0]?.data).toBe("{\"a\":1}");
});

test("SSE：CRLF 与多行 data", () => {
  const parser = new SseParser();
  const frames = parser.feed("event: transcript\r\ndata: one\r\ndata: two\r\n\r\n");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.data).toBe("one\ntwo");
});

test("SSE：注释/retry/空帧", () => {
  const parser = new SseParser();
  const frames = parser.feed(": comment\nretry: 2000\n\nevent: done\ndata: {}\n\n");
  expect(frames).toHaveLength(2);
  expect(frames[0]?.event).toBe("");
  expect(frames[0]?.retry).toBe(2000);
  expect(frames[1]?.event).toBe("done");
  expect(frames[1]?.retry).toBeUndefined();
});

test("SSE：字节流解码", async () => {
  async function* source() {
    yield new TextEncoder().encode("event: assistant\ndata: po");
    yield new TextEncoder().encode("ng\n\n");
  }
  const events = [];
  for await (const frame of decodeSseStream(source())) events.push(frame);
  expect(events).toHaveLength(1);
  expect(events[0]?.data).toBe("pong");
});

test("SSE：CR-only 行结束符也能成帧（P3-02）", () => {
  const parser = new SseParser();
  const frames = parser.feed("event: done\rdata: {}\r\r");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.event).toBe("done");
  expect(frames[0]?.data).toBe("{}");
});

test("SSE：空首行 data 保留换行（P3-02）", () => {
  const parser = new SseParser();
  const frames = parser.feed("event: assistant\ndata: \ndata: two\n\n");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.data).toBe("\ntwo");
});

test("SSE：retry 只认纯十进制数字（P3-02）", () => {
  const parser = new SseParser();
  expect(parser.feed("retry: 0x10\n\n")).toEqual([]);
  expect(parser.feed("retry: 1e3\n\n")).toEqual([]);
  const frames = parser.feed("retry: 2000\n\n");
  expect(frames).toHaveLength(1);
  expect(frames[0]?.retry).toBe(2000);
});

test("SSE：缓冲按字节计上限 4MB，多字节字符不按码元放水（P3-02）", () => {
  const parser = new SseParser();
  // "é" 占 2 字节：210 万个字符 ≈ 4.2MB 字节，字符数不到 4M，必须触发上限。
  expect(() => parser.feed(`event: x\ndata: ${"é".repeat(2_100_000)}`)).toThrow(CapyError);
  const ok = new SseParser();
  expect(ok.feed("event: done\ndata: {}\n\n")).toHaveLength(1);
});

test("SSE：end() 收尾残帧", () => {
  const parser = new SseParser();
  expect(parser.feed("event: done\ndata: {}")).toEqual([]);
  const frames = parser.end();
  expect(frames).toHaveLength(1);
  expect(frames[0]?.event).toBe("done");
});
