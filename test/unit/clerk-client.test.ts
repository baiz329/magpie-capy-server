import { expect, test } from "bun:test";

import { ClerkClient } from "../../src/adapters/capy/clerk-client.ts";
import { CapyError } from "../../src/domain/errors.ts";

function fakeJwt(): string {
  const b64 = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return [b64({ alg: "none" }), b64({ azp: "https://capy.ai" }), "sig"].join(".");
}

function jsonResponse(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

const clerk = { clientJwt: "client-jwt", sessionId: "sess_1" };

test("clerk：200 返回 JWT（H-14(3) 对照）", async () => {
  const client = new ClerkClient((async () =>
    jsonResponse(200, { jwt: fakeJwt() })) as unknown as typeof fetch);
  expect(await client.sessionJwt(clerk)).toBe(fakeJwt());
});

test("clerk：429 → rate_limited，带 retryAfterMs，不映射 401（H-14(3)）", async () => {
  const client = new ClerkClient((async () =>
    jsonResponse(429, { error: "slow" }, { "retry-after": "7" })) as unknown as typeof fetch);
  let caught: unknown = null;
  try {
    await client.sessionJwt(clerk);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapyError);
  if (caught instanceof CapyError) {
    expect(caught.kind).toBe("rate_limited");
    expect(caught.status).toBe(429);
    expect(caught.retryAfterMs).toBe(7000);
  }
});

test("clerk：5xx → upstream_unavailable，不映射 401（H-14(3)）", async () => {
  const client = new ClerkClient((async () =>
    jsonResponse(503, { error: "down" })) as unknown as typeof fetch);
  let caught: unknown = null;
  try {
    await client.sessionJwt(clerk);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapyError);
  if (caught instanceof CapyError) {
    expect(caught.kind).toBe("upstream_unavailable");
    expect(caught.status).toBe(503);
  }
});

test("clerk：401 仍是 sign_in_required（H-14(3)）", async () => {
  const client = new ClerkClient((async () =>
    jsonResponse(401, { error: "unauthorized" })) as unknown as typeof fetch);
  let caught: unknown = null;
  try {
    await client.sessionJwt(clerk);
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(CapyError);
  if (caught instanceof CapyError) {
    expect(caught.kind).toBe("sign_in_required");
    expect(caught.status).toBe(401);
  }
});
