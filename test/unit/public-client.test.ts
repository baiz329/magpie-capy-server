import { expect, test } from "bun:test";

import { CapyPublicClient } from "../../src/adapters/capy/public-client.ts";
import type { UploadCandidate } from "../../src/ports/capy-public.ts";

function filesResponse(targets: { fileId: string; url: string }[]): Response {
  return new Response(JSON.stringify({ targets }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

test("public-client：附件上传有界并发（3 路），结果保序", async () => {
  let concurrent = 0;
  let maxConcurrent = 0;
  const putOrder: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/files") && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { files: { name: string }[] };
      return filesResponse(body.files.map((f, i) => ({
        fileId: `file-${i}`,
        url: `https://93.184.216.34/up/${f.name}`,
      })));
    }
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 20));
    putOrder.push(url);
    concurrent -= 1;
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new CapyPublicClient(fetchImpl);
  const files: UploadCandidate[] = Array.from({ length: 6 }, (_, i) => ({
    name: `f${i}.png`,
    mediaType: "image/png",
    bytes: new Uint8Array([i]),
  }));
  const out = await client.uploadFiles("capy_key", files);
  expect(out.map((f) => f.fileId)).toEqual(["file-0", "file-1", "file-2", "file-3", "file-4", "file-5"]);
  expect(maxConcurrent).toBeGreaterThan(1);
  expect(maxConcurrent).toBeLessThanOrEqual(3);
  expect(putOrder).toHaveLength(6);
});

test("public-client：预签名 PUT 只接受 https:443，http 目标直接拒", async () => {
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/files")) {
      return filesResponse([{ fileId: "file-0", url: "http://93.184.216.34/up/x.png" }]);
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new CapyPublicClient(fetchImpl);
  await expect(client.uploadFiles("capy_key", [
    { name: "x.png", mediaType: "image/png", bytes: new Uint8Array([1]) },
  ])).rejects.toThrow(/https|拒绝/);
});

test("public-client：SSE 超过空闲上限无数据 → upstream_timeout，不无限挂住（M-10）", async () => {
  const fetchImpl = (async (): Promise<Response> =>
    new Response(new ReadableStream({}), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    })) as unknown as typeof fetch;
  const client = new CapyPublicClient(fetchImpl, { sseIdleMs: 50 });
  const stream = client.streamThread("capy_key", "jam_1");
  await expect((async () => {
    for await (const _event of stream) { /* consume */ }
  })()).rejects.toMatchObject({ kind: "upstream_timeout" });
});

test("public-client：预签名 PUT 超时 → upstream_timeout（M-10）", async () => {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/files") && init?.method === "POST") {
      return filesResponse([{ fileId: "file-0", url: "https://93.184.216.34/up/x.png" }]);
    }
    throw new DOMException("The operation timed out.", "TimeoutError");
  }) as unknown as typeof fetch;
  const client = new CapyPublicClient(fetchImpl);
  await expect(client.uploadFiles("capy_key", [
    { name: "x.png", mediaType: "image/png", bytes: new Uint8Array([1]) },
  ])).rejects.toMatchObject({ kind: "upstream_timeout" });
});

test("public-client：预签名 PUT 目标 DNS 解析到私网段也照常上传（代理环境）", async () => {
  // 信任假设：target.url 是 Capy 签发的（我们向 /files 要地址、Capy 签名返回），
  // 不是用户可控输入；代理环境下 DNS 会解析到 198.18.169.x 这类禁段，豁免 DNS 判定。
  // 用户提供的附件下载 URL 仍保留完整 DNS 判定（见 guarded-fetch 测试）。
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith("/files")) {
      return filesResponse([{ fileId: "file-0", url: "https://presign.example.com/up/x.png" }]);
    }
    return new Response("ok", { status: 200 });
  }) as unknown as typeof fetch;
  const client = new CapyPublicClient(fetchImpl, {
    presignLookup: async () => [{ address: "198.18.169.5", family: 4 }],
  });
  const out = await client.uploadFiles("capy_key", [
    { name: "x.png", mediaType: "image/png", bytes: new Uint8Array([1]) },
  ]);
  expect(out).toEqual([{ fileId: "file-0", name: "x.png", mediaType: "image/png", sizeBytes: 1 }]);
});
