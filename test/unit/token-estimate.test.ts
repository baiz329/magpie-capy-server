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

test("estimateTokensOfMessages：图片按张计 85 token（M-04）", () => {
  const tokens = estimateTokensOfMessages([
    {
      role: "user",
      content: [
        { type: "text", text: "look" },
        { type: "image_url", url: "data:image/png;base64,AA==", name: "pic" },
        { type: "image_url", url: "data:image/png;base64,AA==", name: "pic2" },
      ],
    },
  ]);
  expect(tokens).toBe(estimateTokens("look") + 85 * 2);
});

test("estimateTokensOfMessages：PDF 只按 mediaType 计，URL-only 不计（M-04）", () => {
  const dataUrl = `data:application/pdf;base64,${"A".repeat(400_000)}`;
  const pdf = estimateTokensOfMessages([
    { role: "user", content: [{ type: "file", data: dataUrl, mediaType: "application/pdf" }] },
  ]);
  // 400_000 字符 base64 ≈ 300_000 字节 → 3 × 100 token。
  expect(pdf).toBe(300);
  const urlOnly = estimateTokensOfMessages([
    {
      role: "user",
      content: [{ type: "file", url: "https://example.test/a-very-long-file-name.pdf", mediaType: "application/pdf" }],
    },
  ]);
  expect(urlOnly).toBe(0);
  const notPdf = estimateTokensOfMessages([
    { role: "user", content: [{ type: "file", data: dataUrl, mediaType: "image/png" }] },
  ]);
  expect(notPdf).toBe(0);
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
