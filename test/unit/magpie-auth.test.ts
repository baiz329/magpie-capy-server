import { createHash } from "node:crypto";
import { expect, test } from "bun:test";

import { authRecordOf, sessionOfAuth } from "../../src/adapters/host/magpie-auth.ts";

test("sessionOfAuth：uid 回退链恢复 record.uid 到末位（M-08）", () => {
  const record = {
    access: "capy_testkey",
    refresh: JSON.stringify({ clientJwt: "jwt", sessionId: "sess_1", orgId: "org_1" }),
    uid: "user_from_record",
    metadata: {},
  };
  expect(sessionOfAuth(record).uid).toBe("user_from_record");
  // refresh/metadata 有值时优先。
  const withMeta = {
    ...record,
    refresh: JSON.stringify({ clientJwt: "jwt", sessionId: "sess_1", orgId: "org_1", userId: "user_refresh" }),
    metadata: { userId: "user_meta" },
  };
  expect(sessionOfAuth(withMeta).uid).toBe("user_refresh");
});

test("sessionOfAuth：accountId 用 sha256(access) 前 8 位，不用 key 尾部（M-08）", () => {
  const access = "capy_SECRETKEYTAIL";
  const record = {
    access,
    refresh: JSON.stringify({ clientJwt: "jwt", sessionId: "sess_1", orgId: "org_1" }),
    metadata: {},
  };
  const expected = createHash("sha256").update(access).digest("hex").slice(0, 8);
  expect(sessionOfAuth(record).accountId).toBe(expected);
  expect(sessionOfAuth(record).accountId).not.toContain("TAIL");
});

test("sessionOfAuth：source 从 metadata 读回，往返保留（M-08）", () => {
  const session = {
    accountId: "a@b.c",
    uid: "user_1",
    orgId: "org_1",
    clientId: "",
    accessToken: "capy_key",
    clerk: { clientJwt: "jwt", sessionId: "sess_1" },
    source: "cookie" as const,
  };
  const record = authRecordOf(session);
  expect(sessionOfAuth(record).source).toBe("cookie");
});

function signInErrorKind(record: unknown): string | undefined {
  try {
    sessionOfAuth(record);
  } catch (error) {
    return (error as { kind?: string }).kind;
  }
  return undefined;
}

test("magpie-auth：sessionOfAuth 缺 access / 缺 refresh / 坏 refresh 一律 sign_in_required", () => {
  expect(signInErrorKind({})).toBe("sign_in_required");
  expect(signInErrorKind(null)).toBe("sign_in_required");
  expect(signInErrorKind({ access: "capy_x" })).toBe("sign_in_required");
  expect(signInErrorKind({
    access: "capy_x",
    refresh: JSON.stringify({ clientJwt: "jwt" }), // 缺 sessionId
    metadata: {},
  })).toBe("sign_in_required");
  expect(signInErrorKind({
    access: "capy_x",
    refresh: "not json at all",
    metadata: {},
  })).toBe("sign_in_required");
  expect(signInErrorKind({
    access: "capy_x",
    refresh: JSON.stringify({ clientJwt: "jwt", sessionId: "sess_1" }),
    metadata: {},
  })).toBe("sign_in_required"); // 缺 orgId
});

test("magpie-auth：sessionOfAuth 未知 source 回退 refresh，已知来源大小写不敏感", () => {
  const base = {
    access: "capy_x",
    refresh: JSON.stringify({ clientJwt: "jwt", sessionId: "sess_1", orgId: "org_1" }),
  };
  expect(sessionOfAuth({ ...base, metadata: { source: "bogus" } }).source).toBe("refresh");
  expect(sessionOfAuth({ ...base, metadata: { source: "COOKIE" } }).source).toBe("cookie");
  expect(sessionOfAuth({ ...base, metadata: {} }).source).toBe("refresh");
});
