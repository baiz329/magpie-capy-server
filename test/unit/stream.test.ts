import { expect, test } from "bun:test";

import { PublicSseNormalizer } from "../../src/application/stream.ts";
import type { SseFrame } from "../../src/protocol/sse.ts";

function frame(event: string, data: unknown): SseFrame {
  return { event, data: JSON.stringify(data) };
}

test("assistant 增量：累积 + finish", () => {
  const normalizer = new PublicSseNormalizer();
  const events = [
    ...normalizer.push(frame("assistant", { callId: "c1", text: "po" })),
    ...normalizer.push(frame("assistant", { callId: "c1", text: "pong" })),
    ...normalizer.finish(),
  ];
  expect(events).toEqual([
    { type: "delta", text: "po" },
    { type: "delta", text: "ng" },
    { type: "final", text: "pong" },
    { type: "done" },
  ]);
});

test("assistant 全文重复：只转发一次", () => {
  const normalizer = new PublicSseNormalizer();
  const first = normalizer.push(frame("assistant", { callId: "c1", text: "pong" }));
  const second = normalizer.push(frame("assistant", { callId: "c1", text: "pong" }));
  expect(first).toEqual([{ type: "delta", text: "pong" }]);
  expect(second).toEqual([]);
});

test("transcript 校正：只有 transcript 时补发 delta", () => {
  const normalizer = new PublicSseNormalizer();
  const events = [
    ...normalizer.push(frame("assistant", { callId: "c1", text: "po" })),
    ...normalizer.push(frame("transcript", { source: "assistant", text: "pong", callId: "c1" })),
    ...normalizer.finish(),
  ];
  expect(events).toEqual([
    { type: "delta", text: "po" },
    { type: "delta", text: "ng" },
    { type: "final", text: "pong" },
    { type: "done" },
  ]);
});

test("region_unsupported：error 事件，finish 不再 final", () => {
  const normalizer = new PublicSseNormalizer();
  const events = normalizer.push(frame("error", { code: "region_unsupported", message: "only US" }));
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("error");
  if (events[0]?.type === "error") {
    expect(events[0].error.kind).toBe("region_unsupported");
    expect(events[0].error.status).toBe(403);
  }
  expect(normalizer.finish()).toEqual([]);
});

test("user transcript / status / heartbeat 不进入事件流", () => {
  const normalizer = new PublicSseNormalizer();
  expect(normalizer.push(frame("transcript", { source: "user", text: "hi" }))).toEqual([]);
  expect(normalizer.push(frame("status", { status: "working" }))).toEqual([]);
  expect(normalizer.push({ event: "heartbeat", data: "{}" })).toEqual([]);
});
