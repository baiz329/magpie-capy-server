import { expect, test } from "bun:test";

import { authRecordOf } from "../../src/adapters/host/magpie-auth.ts";
import CapyNextPlugin from "../../src/entry/plugin.ts";

const auth = authRecordOf({
  accountId: "a@b.c",
  uid: "user_1",
  orgId: "org_1",
  clientId: "",
  accessToken: "capy_key",
  clerk: { clientJwt: "jwt", sessionId: "sess_1" },
  source: "local",
});

async function loaderFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const plugin = await CapyNextPlugin({});
  const loader = await (plugin as unknown as {
    auth: {
      loader: (getAuth: () => Promise<Record<string, unknown> | null>) => Promise<{ fetch: typeof fetch }>;
    };
  }).auth.loader(async () => auth);
  return loader.fetch(input, init);
}

test("entry：chat/completions 非 POST 拒 405（P3-09）", async () => {
  const response = await loaderFetch("https://example.com/v1/chat/completions", { method: "GET" });
  expect(response.status).toBe(405);
  const body = await response.json() as { error: { code: string } };
  expect(body.error.code).toBe("invalid_request");
});

test("entry：请求体超 2MB 拒 413（P3-09）", async () => {
  const response = await loaderFetch("https://example.com/v1/chat/completions", {
    method: "POST",
    body: "x".repeat(2 * 1024 * 1024 + 1),
  });
  expect(response.status).toBe(413);
});

test("entry：messages 超 200 条拒 400（P3-09）", async () => {
  const messages = Array.from({ length: 201 }, () => ({ role: "user", content: "hi" }));
  const response = await loaderFetch("https://example.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "capy-free", messages }),
  });
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("200");
});

test("entry：dispose() 关隧道，未连接时也不抛错（M-15）", async () => {
  const plugin = await CapyNextPlugin({});
  expect(() => (plugin as unknown as { dispose: () => void }).dispose()).not.toThrow();
});

test("entry：请求体不是合法 JSON 拒 400", async () => {
  const response = await loaderFetch("https://example.com/v1/chat/completions", {
    method: "POST",
    body: "{not json",
  });
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { message: string } };
  expect(body.error.message).toContain("不是合法 JSON");
});

test("entry：messages 为空 / 缺 model / 坏 role 拒 400", async () => {
  const empty = await loaderFetch("https://example.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "particle/particle-1", messages: [] }),
  });
  expect(empty.status).toBe(400);

  const noModel = await loaderFetch("https://example.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(noModel.status).toBe(400);
  const noModelBody = await noModel.json() as { error: { message: string } };
  expect(noModelBody.error.message).toContain("缺少 model");

  const badRole = await loaderFetch("https://example.com/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify({ model: "particle/particle-1", messages: [{ role: "alien", content: "hi" }] }),
  });
  expect(badRole.status).toBe(400);
});

test("entry：未实现端点拒 501", async () => {
  const response = await loaderFetch("https://example.com/v1/embeddings", {
    method: "POST",
    body: JSON.stringify({ model: "particle/particle-1", input: "hi" }),
  });
  expect(response.status).toBe(501);
});
