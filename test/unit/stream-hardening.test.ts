import { expect, test } from "bun:test";

import { PublicSseNormalizer } from "../../src/application/stream.ts";
import type { SseFrame } from "../../src/protocol/sse.ts";

function frame(event: string, data: unknown): SseFrame {
  return { event, data: JSON.stringify(data) };
}

test("stream-hardening：无 done 断流 → finish 只出 error，不出假 final/done（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  normalizer.push(frame("assistant", { callId: "c1", text: "pong" }));
  const events = normalizer.finish();
  expect(events).toHaveLength(1);
  expect(events[0]?.type).toBe("error");
  if (events[0]?.type === "error") {
    expect(events[0].error.kind).toBe("upstream_unavailable");
    expect(events[0].error.message).toContain("上游流在完成前中断");
  }
  // finish 幂等：第二次不再重复产出。
  expect(normalizer.finish()).toEqual([]);
});

test("stream-hardening：run(phase=end) 也算完成（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  normalizer.push(frame("assistant", { callId: "c1", text: "pong" }));
  normalizer.push(frame("run", { phase: "end" }));
  expect(normalizer.completed).toBe(true);
  expect(normalizer.finish()).toEqual([
    { type: "final", text: "pong" },
    { type: "done" },
  ]);
});

test("stream-hardening：turn dropped 清空累积，finish 不出旧 final（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  normalizer.push(frame("assistant", { callId: "c1", text: "pong" }));
  normalizer.push(frame("turn", { phase: "end", outcome: "dropped" }));
  expect(normalizer.text).toBe("");
  normalizer.push(frame("done", {}));
  expect(normalizer.finish()).toEqual([{ type: "done" }]);
});

test("stream-hardening：dropped 后新一轮 delta 只认新文本（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  normalizer.push(frame("assistant", { callId: "c1", text: "pong" }));
  normalizer.push(frame("turn", { phase: "end", outcome: "dropped" }));
  const delta = normalizer.push(frame("assistant", { callId: "c1", text: "hi" }));
  expect(delta).toEqual([{ type: "delta", text: "hi" }]);
  normalizer.push(frame("done", {}));
  expect(normalizer.finish()).toEqual([
    { type: "final", text: "hi" },
    { type: "done" },
  ]);
});

test("stream-hardening：新 callId 清旧 final，终态不回写上一轮（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  normalizer.push(frame("assistant", { callId: "c1", text: "po" }));
  normalizer.push(frame("transcript", { source: "assistant", text: "pong", callId: "c1" }));
  normalizer.push(frame("assistant", { callId: "c2", text: "hello" }));
  normalizer.push(frame("done", {}));
  expect(normalizer.finish()).toEqual([
    { type: "final", text: "hello" },
    { type: "done" },
  ]);
});

test("stream-hardening：上一轮的 transcript 不能覆盖新一轮（H-11，final 校验 callId）", () => {
  const normalizer = new PublicSseNormalizer();
  normalizer.push(frame("assistant", { callId: "c1", text: "po" }));
  normalizer.push(frame("assistant", { callId: "c2", text: "hi" }));
  // 迟到的 c1 终态：必须忽略，不能把 "pong" 写回。
  expect(normalizer.push(frame("transcript", { source: "assistant", text: "pong", callId: "c1" }))).toEqual([]);
  normalizer.push(frame("done", {}));
  expect(normalizer.finish()).toEqual([
    { type: "final", text: "hi" },
    { type: "done" },
  ]);
});

test("stream-hardening：更短前缀快照是回退，不重复下发；之后再长回来只补增量（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  expect(normalizer.push(frame("assistant", { callId: "c1", text: "pong" })))
    .toEqual([{ type: "delta", text: "pong" }]);
  // 服务端修正回退到 "po"：不下发 delta。
  expect(normalizer.push(frame("assistant", { callId: "c1", text: "po" }))).toEqual([]);
  expect(normalizer.push(frame("assistant", { callId: "c1", text: "pong" })))
    .toEqual([{ type: "delta", text: "ng" }]);
});

test("stream-hardening：合法重复增量不被吞掉（H-11）", () => {
  const normalizer = new PublicSseNormalizer();
  expect(normalizer.push(frame("assistant", { callId: "c1", text: "ab" })))
    .toEqual([{ type: "delta", text: "ab" }]);
  // 增量 "b" 与已发尾部重复，但是新的增量：照常下发。
  expect(normalizer.push(frame("assistant", { callId: "c1", text: "b" })))
    .toEqual([{ type: "delta", text: "b" }]);
  expect(normalizer.text).toBe("abb");
});
