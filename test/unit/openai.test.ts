import { expect, test } from "bun:test";

import type { ChatEvent } from "../../src/domain/chat.ts";
import { buildPrompt } from "../../src/domain/chat.ts";
import { CapyError } from "../../src/domain/errors.ts";
import {
  encodeChatStream,
  encodeCompletion,
  encodeErrorResponse,
  encodeToolCallStream,
  parseChatRequest,
} from "../../src/protocol/openai.ts";

test("parseChatRequest：文本 / 图片 / reasoning_effort", () => {
  const request = parseChatRequest({
    model: "particle/particle-1",
    stream: true,
    reasoning_effort: "low",
    messages: [
      { role: "system", content: "be terse" },
      {
        role: "user",
        content: [
          { type: "text", text: "look" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } },
        ],
      },
    ],
  });
  expect(request.model).toBe("particle/particle-1");
  expect(request.stream).toBe(true);
  expect(request.reasoningEffort).toBe("low");
  expect(request.messages[1]?.content).toEqual([
    { type: "text", text: "look" },
    { type: "image_url", url: "data:image/png;base64,AA==" },
  ]);
});

test("parseChatRequest：assistant tool_calls 保留", () => {
  const request = parseChatRequest({
    model: "m",
    messages: [{
      role: "assistant",
      content: null,
      tool_calls: [{
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
      }],
    }],
  });
  expect(request.messages[0]?.toolCalls).toEqual([
    { id: "call_1", name: "get_weather", arguments: "{\"city\":\"Paris\"}" },
  ]);
});

test("parseChatRequest：空 messages / 未知 role → invalid_request", () => {
  expect(() => parseChatRequest({ model: "m", messages: [] })).toThrow(CapyError);
  expect(() => parseChatRequest({
    model: "m",
    messages: [{ role: "robot", content: "x" }],
  })).toThrow(CapyError);
});

test("buildPrompt：单条 user 原样；多轮/系统块", () => {
  expect(buildPrompt([{ role: "user", content: "  ping  " }])).toBe("ping");
  const multi = buildPrompt([
    { role: "system", content: "be terse" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
    { role: "user", content: "again" },
  ]);
  expect(multi).toContain("<system>\nbe terse\n</system>");
  expect(multi).toContain("<conversation>");
  expect(multi).toContain("<user>\nagain\n</user>");
  expect(multi).toContain("Reply to the last user message.");
});

test("buildPrompt：超长单条 user 原样保留，不按 160k 字符裁剪", () => {
  const content = `HEAD-${"a".repeat(120_000)}${"b".repeat(120_000)}-TAIL`;
  const text = buildPrompt([{ role: "user", content }]);
  expect(text).toBe(content);
  expect(text.length).toBeGreaterThan(160_000);
});

test("buildPrompt：超长多轮不丢任何消息", () => {
  const messages = Array.from({ length: 40 }, (_, i) => ({
    role: "user" as const,
    content: `MSG_${i}_${"x".repeat(5000)}`,
  }));
  const text = buildPrompt(messages);
  expect(text.length).toBeGreaterThan(160_000);
  expect(text).toContain("MSG_0_");
  expect(text).toContain("MSG_39_");
  expect(text).not.toMatch(/已省略|已截断/);
});

test("buildPrompt：超长 system 原样保留，不被压缩", () => {
  const system = `SYS_${"s".repeat(200_000)}`;
  const question = `QUESTION-${"q".repeat(20_000)}-END`;
  const text = buildPrompt([
    { role: "system", content: system },
    { role: "user", content: question },
  ]);
  expect(text.length).toBeGreaterThan(200_000);
  expect(text).toContain(system);
  expect(text).toContain(question);
  expect(text).not.toMatch(/已省略|已截断/);
});

test("encodeChatStream：chunk / stop / [DONE]", async () => {
  async function* events(): AsyncIterable<ChatEvent> {
    yield { type: "delta", text: "po" };
    yield { type: "delta", text: "ng" };
    yield { type: "final", text: "pong" };
    yield { type: "done" };
  }
  const response = encodeChatStream(events(), {
    id: "chatcmpl-1",
    model: "particle/particle-1",
    created: 1,
  });
  const text = await response.text();
  expect(text).toContain("\"content\":\"po\"");
  expect(text).toContain("\"content\":\"ng\"");
  expect(text).toContain("\"finish_reason\":\"stop\"");
  expect(text).toContain("data: [DONE]");
});

test("encodeChatStream：带用量时在 [DONE] 前发 usage chunk（choices 为空）", async () => {
  async function* events(): AsyncIterable<ChatEvent> {
    yield { type: "delta", text: "po" };
    yield { type: "delta", text: "ng" };
    yield { type: "final", text: "pong" };
    yield { type: "done" };
  }
  const response = encodeChatStream(events(), {
    id: "chatcmpl-1",
    model: "particle/particle-1",
    created: 1,
  }, { promptTokens: 10, estimateCompletionTokens: (text) => text.length });
  const text = await response.text();
  // usage chunk：choices 为空，usage 为估算值；必须在 [DONE] 之前，stop chunk 之后。
  const lines = text.split("\n").filter((line) => line.startsWith("data: {"));
  const usageLine = lines.find((line) => line.includes('"usage"'));
  expect(usageLine).toBeDefined();
  const chunk = JSON.parse(usageLine!.slice("data: ".length)) as {
    choices: unknown[];
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  expect(chunk.choices).toEqual([]);
  expect(chunk.usage).toEqual({ prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  const usageAt = text.indexOf(usageLine!);
  expect(text.indexOf("data: [DONE]", usageAt)).toBeGreaterThan(usageAt);
  expect(text.indexOf('"finish_reason":"stop"')).toBeLessThan(usageAt);
});

test("encodeChatStream：不传用量时不发 usage chunk（兼容旧行为）", async () => {
  async function* events(): AsyncIterable<ChatEvent> {
    yield { type: "delta", text: "pong" };
    yield { type: "done" };
  }
  const response = encodeChatStream(events(), {
    id: "chatcmpl-1",
    model: "particle/particle-1",
    created: 1,
  });
  const text = await response.text();
  expect(text).not.toContain('"usage"');
  expect(text).toContain("data: [DONE]");
});

test("encodeToolCallStream：带用量时在 [DONE] 前发 usage chunk", async () => {
  const response = encodeToolCallStream(
    { id: "chatcmpl-1", model: "particle/particle-1", created: 1 },
    [{ id: "call_1", name: "get_weather", arguments: "{}" }],
    { promptTokens: 10, completionTokens: 3 },
  );
  const text = await response.text();
  const usageAt = text.indexOf('"usage":{"prompt_tokens":10,"completion_tokens":3,"total_tokens":13}');
  expect(usageAt).toBeGreaterThan(-1);
  expect(text.indexOf("data: [DONE]", usageAt)).toBeGreaterThan(usageAt);
});

test("encodeToolCallStream：不传用量时不发 usage chunk", async () => {
  const response = encodeToolCallStream(
    { id: "chatcmpl-1", model: "particle/particle-1", created: 1 },
    [{ id: "call_1", name: "get_weather", arguments: "{}" }],
  );
  const text = await response.text();
  expect(text).not.toContain('"usage"');
  expect(text).toContain("data: [DONE]");
});

test("encodeErrorResponse：401 带 sign-in header", async () => {
  const response = encodeErrorResponse(new CapyError("sign_in_required", "expired"));
  expect(response.status).toBe(401);
  expect(response.headers.get("x-magpie-sign-in")).toBe("expired");
  const body = await response.json() as { error: { code: string } };
  expect(body.error.code).toBe("sign_in_required");
});

test("encodeErrorResponse：429 返回 429，不带 sign-in header（网关据此切下一个账号）", async () => {
  const response = encodeErrorResponse(new CapyError("rate_limited", "Capy 限流"));
  expect(response.status).toBe(429);
  expect(response.headers.get("x-magpie-sign-in")).toBeNull();
  const body = await response.json() as { error: { code: string; status: number; type: string } };
  expect(body.error.code).toBe("rate_limited");
  expect(body.error.status).toBe(429);
  expect(body.error.type).toBe("rate_limit_error");
});

test("encodeCompletion：上报传入的估算用量；不传则为 0", async () => {
  const withUsage = await encodeCompletion("id1", "m", 1, "你好", { promptTokens: 10, completionTokens: 3 }).json() as {
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  expect(withUsage.usage).toEqual({ prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 });
  const withoutUsage = await encodeCompletion("id2", "m", 1, "hi").json() as {
    usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  };
  expect(withoutUsage.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});
