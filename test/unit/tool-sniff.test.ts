import { expect, test } from "bun:test";

import type { ChatEvent } from "../../src/domain/chat.ts";
import { sniffToolPrefix, SNIFF_LIMIT_BYTES } from "../../src/application/tool-sniff.ts";

const allowed = ["get_weather"];

async function* fromEvents(events: ChatEvent[], onClose?: () => void): AsyncIterable<ChatEvent> {
  try {
    for (const event of events) yield event;
  } finally {
    onClose?.();
  }
}

async function collect(events: AsyncIterable<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

test("tool-sniff：首字符不是 { → 立即文本透传，含已缓冲事件（H-12）", async () => {
  const events: ChatEvent[] = [
    { type: "delta", text: "Hello" },
    { type: "delta", text: " world" },
    { type: "done" },
  ];
  const result = await sniffToolPrefix(fromEvents(events), allowed);
  expect(result.kind).toBe("text");
  if (result.kind !== "text") return;
  expect(await collect(result.events)).toEqual(events);
});

test("tool-sniff：空白前缀后是 { 且闭合为合法工具调用 → tool，并关闭上游（H-12）", async () => {
  let closed = false;
  const events: ChatEvent[] = [
    { type: "delta", text: "  " },
    { type: "delta", text: "{\"tool_calls\":[{\"name\":\"get_weather\",\"arguments\":{\"city\":\"Paris\"}}]}" },
    { type: "delta", text: "不应被消费" },
    { type: "done" },
  ];
  const result = await sniffToolPrefix(fromEvents(events, () => { closed = true; }), allowed);
  expect(result.kind).toBe("tool");
  if (result.kind !== "tool") return;
  expect(result.calls).toEqual([{ name: "get_weather", arguments: "{\"city\":\"Paris\"}" }]);
  expect(closed).toBe(true);
});

test("tool-sniff：闭合后不是合法工具调用 → 文本透传（H-12）", async () => {
  const events: ChatEvent[] = [
    { type: "delta", text: "{\"hello\": 1}" },
    { type: "delta", text: " more" },
    { type: "done" },
  ];
  const result = await sniffToolPrefix(fromEvents(events), allowed);
  expect(result.kind).toBe("text");
  if (result.kind !== "text") return;
  expect(await collect(result.events)).toEqual(events);
});

test("tool-sniff：流结束仍未闭合 → 文本透传（H-12）", async () => {
  const events: ChatEvent[] = [
    { type: "delta", text: "{\"tool_calls\":[{\"name\":\"get_weather\"" },
    { type: "done" },
  ];
  const result = await sniffToolPrefix(fromEvents(events), allowed);
  expect(result.kind).toBe("text");
  if (result.kind !== "text") return;
  expect(await collect(result.events)).toEqual(events);
});

test("tool-sniff：超 64KB 仍未闭合 → 文本透传，上限按字节计（H-12）", async () => {
  // "é" 占 2 字节：40KB 字符已超 64KB 字节上限。
  const big = `{"tool_calls":[{"name":"get_weather","arguments":{"note":"${"é".repeat(40_000)}"}}]`;
  expect(new TextEncoder().encode(big).length).toBeGreaterThan(SNIFF_LIMIT_BYTES);
  const events: ChatEvent[] = [
    { type: "delta", text: big.slice(0, 1000) },
    { type: "delta", text: big.slice(1000) },
    { type: "done" },
  ];
  const result = await sniffToolPrefix(fromEvents(events), allowed);
  expect(result.kind).toBe("text");
  if (result.kind !== "text") return;
  expect(await collect(result.events)).toEqual(events);
});

test("tool-sniff：名字不在白名单 → 文本透传（H-12）", async () => {
  const events: ChatEvent[] = [
    { type: "delta", text: "{\"tool_calls\":[{\"name\":\"evil\",\"arguments\":{}}]}" },
    { type: "done" },
  ];
  const result = await sniffToolPrefix(fromEvents(events), allowed);
  expect(result.kind).toBe("text");
});

test("tool-sniff：replay 中途取消 → 向底层迭代器传 return()（M-11）", async () => {
  let closed = false;
  async function* infinite(): AsyncIterable<ChatEvent> {
    try {
      yield { type: "delta", text: "Hello" };
      for (;;) yield { type: "delta", text: " more" };
    } finally {
      closed = true;
    }
  }
  const result = await sniffToolPrefix(infinite(), allowed);
  expect(result.kind).toBe("text");
  if (result.kind !== "text") return;
  const iterator = result.events[Symbol.asyncIterator]();
  await iterator.next();
  await iterator.return?.(undefined);
  expect(closed).toBe(true);
});
