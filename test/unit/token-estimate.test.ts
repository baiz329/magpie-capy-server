import { expect, test } from "bun:test";

import { estimateTokens, estimateTokensOfMessages } from "../../src/adapters/platform/token-estimate.ts";

test("estimateTokens：CJK 按字计，ASCII 约 4 字符 1 token", () => {
  expect(estimateTokens("")).toBe(0);
  expect(estimateTokens("你好")).toBe(2);
  expect(estimateTokens("hi")).toBe(1);
  expect(estimateTokens("abcdefgh")).toBe(2);
  expect(estimateTokens("你好hello")).toBe(4);
});

test("estimateTokensOfMessages：抽取文本内容估算", () => {
  const tokens = estimateTokensOfMessages([
    { role: "system", content: "be terse" },
    { role: "user", content: "你好，请回答" },
  ]);
  // "be terse" 8 字符 → 2；"你好，请回答" 6 个 CJK 字符 → 6；合计 8。
  expect(tokens).toBe(8);
});

test("estimateTokensOfMessages：多段内容与图片占位符计入", () => {
  const tokens = estimateTokensOfMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", url: "data:image/png;base64,AA==", name: "pic" },
      ],
    },
  ]);
  expect(tokens).toBe(estimateTokens("look[图片: pic]"));
});

test("estimateTokensOfMessages：工具调用名称与参数计入", () => {
  const tokens = estimateTokensOfMessages([
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call_1", name: "get_weather", arguments: '{"city":"Paris"}' }],
    },
  ]);
  expect(tokens).toBe(estimateTokens('get_weather{"city":"Paris"}'));
});
