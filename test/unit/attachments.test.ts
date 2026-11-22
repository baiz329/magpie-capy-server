import { expect, test } from "bun:test";

import { collectAttachments } from "../../src/application/attachments.ts";
import type { ChatMessage } from "../../src/domain/chat.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
const dataUrl = `data:image/png;base64,${png}`;

test("attachments：data URL 图片 → 上传候选 + 文本标记", async () => {
  const messages: ChatMessage[] = [{
    role: "user",
    content: [
      { type: "text", text: "look" },
      { type: "image_url", url: dataUrl, name: "red.png" },
    ],
  }];
  const result = await collectAttachments(messages, { fetchImpl: fetch });
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]?.name).toBe("red.png");
  expect(result.attachments[0]?.mediaType).toBe("image/png");
  expect(result.messages[0]?.content).toEqual([
    { type: "text", text: "look" },
    { type: "text", text: "[图片: red.png]" },
  ]);
});

test("attachments：没有 8 个/60 MB 的自造上限", async () => {
  const parts = Array.from({ length: 12 }, (_, i) => ({
    type: "image_url" as const,
    url: dataUrl,
    name: `img-${i}.png`,
  }));
  const result = await collectAttachments([{ role: "user", content: parts }], { fetchImpl: fetch });
  expect(result.attachments).toHaveLength(12);
});

test("attachments：本机/内网 URL 拒绝（SSRF）", async () => {
  // 注入必定抛错的 fetch：旧行为会走到网络请求（挂住），新行为在校验层就拒掉。
  const neverFetch = (async (): Promise<Response> => {
    throw new Error("must not fetch");
  }) as unknown as typeof fetch;
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "http://127.0.0.1/secret.png" }],
  }], { fetchImpl: neverFetch })).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "http://169.254.169.254/latest/meta-data/" }],
  }], { fetchImpl: neverFetch })).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "https://user:pass@example.com/x.png" }],
  }], { fetchImpl: neverFetch })).rejects.toMatchObject({ kind: "invalid_request" });
});

test("attachments：远程下载走 directFetch，不走 fetchImpl（不经用户代理）", async () => {
  const direct = (async (): Promise<Response> =>
    new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/png", "content-length": "3" },
    })) as unknown as typeof fetch;
  const viaProxy = (async (): Promise<Response> => {
    throw new Error("fetchImpl must not be used for remote attachments");
  }) as unknown as typeof fetch;
  const result = await collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "https://example.com/x.png", name: "x.png" }],
  }], { fetchImpl: viaProxy, directFetch: direct });
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments[0]?.bytes).toEqual(new Uint8Array([1, 2, 3]));
});

test("attachments：超过 32 个附件拒绝", async () => {
  const parts = Array.from({ length: 33 }, (_, i) => ({
    type: "image_url" as const,
    url: dataUrl,
    name: `img-${i}.png`,
  }));
  await expect(collectAttachments([{ role: "user", content: parts }], { fetchImpl: fetch }))
    .rejects.toMatchObject({ kind: "invalid_request" });
});

test("attachments：总大小超 128 MiB 拒绝（注入小上限验证）", async () => {
  const parts = [
    { type: "image_url" as const, url: dataUrl, name: "a.png" },
    { type: "image_url" as const, url: dataUrl, name: "b.png" },
  ];
  await expect(collectAttachments(
    [{ role: "user", content: parts }],
    { fetchImpl: fetch, limits: { maxTotalBytes: 10 } },
  )).rejects.toMatchObject({ kind: "invalid_request" });
});

test("attachments：文件名按码点截断，不切开代理对", async () => {
  const name = `${"😀".repeat(250)}.png`;
  const result = await collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: dataUrl, name }],
  }], { fetchImpl: fetch });
  const saved = result.attachments[0]?.name ?? "";
  expect(Array.from(saved).length).toBe(200);
  expect(saved).not.toContain("�");
});

test("attachments：data URL base64 非法字符拒绝，不再静默丢弃（P3-01）", async () => {
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "data:image/png;base64,AB!C", name: "bad.png" }],
  }], { fetchImpl: fetch })).rejects.toMatchObject({ kind: "invalid_request" });
});

test("attachments：0 字节 data URL 拒绝（P3-01）", async () => {
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "data:image/png;base64,", name: "empty.png" }],
  }], { fetchImpl: fetch })).rejects.toMatchObject({ kind: "invalid_request" });
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "data:text/plain,", name: "empty.txt" }],
  }], { fetchImpl: fetch })).rejects.toMatchObject({ kind: "invalid_request" });
});

test("attachments：data URL 百分号转义无效拒绝（P3-01）", async () => {
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "data:text/plain,%E0%A4%A", name: "bad.txt" }],
  }], { fetchImpl: fetch })).rejects.toMatchObject({ kind: "invalid_request" });
});

test("attachments：远程下载超时 → upstream_timeout（M-10）", async () => {
  const direct = (async (): Promise<Response> => {
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as typeof fetch;
  await expect(collectAttachments([{
    role: "user",
    content: [{ type: "image_url", url: "https://example.com/x.png", name: "x.png" }],
  }], { fetchImpl: fetch, directFetch: direct })).rejects.toMatchObject({ kind: "upstream_timeout" });
});
