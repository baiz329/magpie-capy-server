import { expect, test } from "bun:test";

import { LoginUseCase } from "../../src/application/login.ts";
import { authRecordOf, sessionOfAuth } from "../../src/adapters/host/magpie-auth.ts";
import type { CapyAppPort } from "../../src/ports/capy-app.ts";
import { combineCookieInputs, cookieCredentialOf } from "../../src/adapters/capy/cookie-login.ts";
import type { LoginCredential, LoginSourcePort } from "../../src/ports/login.ts";

const key = `capy_${"a".repeat(43)}`;

function fakeApp(overrides: Partial<CapyAppPort> = {}): CapyAppPort {
  let mintedOrg = "";
  const base = {
    async sessionJwt() { return "jwt"; },
    async me() { return { id: "user_1", email: "a@b.c", preferredOrgId: "org_2" }; },
    async organizations() { return [{ id: "org_1" }, { id: "org_2" }]; },
    async mintApiKey(_jwt: string, orgId: string) {
      mintedOrg = orgId;
      return { plaintext: key, keyId: "key_1" };
    },
    async listDevices() { return []; },
    async renameDevice() {},
    async startDeviceCode() { throw new Error("unused"); },
    async approveDeviceCode() {},
    async pollDeviceCode() { throw new Error("unused"); },
    async createJam() { throw new Error("unused"); },
    async getJam() { throw new Error("unused"); },
    async getJamEvents() { return []; },
    async interruptJam() {},
  } as CapyAppPort;
  return Object.assign(base, overrides, {
    mintedOrg: () => mintedOrg,
  }) as CapyAppPort & { mintedOrg: () => string };
}

function fakeSources(credential: LoginCredential): LoginSourcePort {
  return {
    async local() { return credential; },
    async browser() { return credential; },
  };
}

const jwt = (payload: Record<string, string>) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;

 test("cookieCredentialOf：解析原始 Cookie 并从 __session.sid 取得 sessionId", () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_cookie" });
  const credential = cookieCredentialOf(`__client=${client}; __session=${session}`);
  expect(credential).toMatchObject({ clientJwt: client, sessionId: "sess_cookie", clientId: "client_id", source: "cookie" });
});

test("cookieCredentialOf：支持 Cookie-Editor JSON 数组", () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_cookie" });
  const credential = cookieCredentialOf(JSON.stringify([
    { name: "__client", value: client, domain: "capy.ai" },
    { name: "__session", value: session, domain: "capy.ai" },
  ]));
  expect(credential.sessionId).toBe("sess_cookie");
});

test("cookieCredentialOf：缺少 __client 或 session sid 时拒绝", () => {
  expect(() => cookieCredentialOf("__session=x.y.z")).toThrow("__client");
  expect(() => cookieCredentialOf(`__client=${jwt({ id: "client_id" })}; __session=${jwt({})}`)).toThrow("sessionId");
});

test("cookieCredentialOf：sessionId 顺序与 JSON 包装格式", () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_jwt" });
  const pair = `__client=${client}`;
  expect(cookieCredentialOf(`${pair}; clerk_active_context=sess_active:; __session=${session}`).sessionId).toBe("sess_active");
  expect(cookieCredentialOf(`${pair}; __session=${session}`).sessionId).toBe("sess_jwt");
  expect(cookieCredentialOf(`${pair}; __session_instance=${session}`).sessionId).toBe("sess_jwt");
  expect(cookieCredentialOf(`${pair}; sessionId=sess_manual`).sessionId).toBe("sess_manual");
  expect(() => cookieCredentialOf(`${pair}`)).toThrow("sessionId");
  expect(() => cookieCredentialOf("__client_uat=123; sessionId=sess_manual")).toThrow("__client");
  const wrapped = JSON.stringify({ url: "https://capy.ai", cookies: [{ name: "__client", value: client }, { name: "__session", value: session }] });
  expect(cookieCredentialOf(wrapped).sessionId).toBe("sess_jwt");
  expect(cookieCredentialOf(JSON.stringify({ __client: client, __session: session })).sessionId).toBe("sess_jwt");
});

test("cookieCredentialOf：空输入、错误 JSON 和 JWT 均安全失败", () => {
  expect(() => cookieCredentialOf("")).toThrow();
  expect(() => cookieCredentialOf("{invalid")).toThrow();
  const marker = "sensitive_marker_for_test";
  try {
    cookieCredentialOf(`__client=${marker}`);
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ kind: "sign_in_required" });
    expect(String(error)).not.toContain(marker);
  }
});

test("combineCookieInputs：两框拼成一串，第二框裸值自动补名字", () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_cookie" });
  const header = `__client=${client}; other=1`;
  // 第二框是 __session 裸值（JWT）→ 补 __session=
  const combined = combineCookieInputs(header, session);
  expect(combined).toBe(`${header}; __session=${session}`);
  expect(cookieCredentialOf(combined).sessionId).toBe("sess_cookie");
  // 第二框是 Clerk session id 裸值 → 补 sessionId=
  const byId = combineCookieInputs(header, "sess_manual");
  expect(byId).toBe(`${header}; sessionId=sess_manual`);
  expect(cookieCredentialOf(byId).sessionId).toBe("sess_manual");
  // 第二框已经是 name=value 形式 → 原样拼接
  const paired = combineCookieInputs(header, `__session=${session}`);
  expect(cookieCredentialOf(paired).sessionId).toBe("sess_cookie");
});

test("combineCookieInputs：只填一框原样返回；JSON 导出自包含", () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_cookie" });
  const header = `__client=${client}`;
  expect(combineCookieInputs(header, "")).toBe(header);
  expect(combineCookieInputs("", `__session=${session}`)).toBe(`__session=${session}`);
  // 只填第一框且没有会话信息 → 解析时提示补第二框
  expect(() => cookieCredentialOf(combineCookieInputs(header, ""))).toThrow("sessionId");
  // JSON 导出框合并：同名第一框优先，第二框独有的 cookie 得以保留（M-17）。
  // 第一框自包含也不再整框丢弃第二框；合并后是 header 串，不再是原 JSON。
  const json = JSON.stringify([
    { name: "__client", value: client, domain: "clerk.capy.ai" },
    { name: "__session", value: session, domain: "capy.ai" },
  ]);
  expect(cookieCredentialOf(combineCookieInputs(json, session)).sessionId).toBe("sess_cookie");
  expect(cookieCredentialOf(combineCookieInputs(header, json)).sessionId).toBe("sess_cookie");
  const withExtra = combineCookieInputs(json, JSON.stringify([
    { name: "__session_VSH_xxx", value: session, domain: "capy.ai" },
  ]));
  expect(withExtra).toContain("__session_VSH_xxx");
  expect(cookieCredentialOf(withExtra).sessionId).toBe("sess_cookie");
  expect(cookieCredentialOf(combineCookieInputs(json, "")).sessionId).toBe("sess_cookie");
});

test("LoginUseCase.complete：Cookie 凭据复用 complete 链路", async () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_cookie" });
  const useCase = new LoginUseCase({ app: fakeApp(), sources: fakeSources({ clientJwt: "unused", sessionId: "unused", userId: "", source: "cookie" }) });
  const result = await useCase.complete(cookieCredentialOf(`__client=${client}; __session=${session}`));
  expect(result.source).toBe("cookie");
  expect(result.accessToken).toBe(key);
});
test("login：本机导入 → org 选择 → API key → AccountSession", async () => {
  const app = fakeApp();
  const useCase = new LoginUseCase({
    app,
    sources: fakeSources({
      clientJwt: "client",
      sessionId: "sess_1",
      userId: "user_1",
      clientId: "client_real",
      source: "local",
    }),
  });
  const session = await useCase.login("local");
  expect(session.accessToken).toBe(key);
  expect(session.orgId).toBe("org_2");
  expect(session.source).toBe("local");
  expect(session.clientId).toBe("client_real");
  expect(session.accountId).toBe("a@b.c");
  expect((app as unknown as { mintedOrg: () => string }).mintedOrg()).toBe("org_2");
});

test("login：credential 指定 org 优先", async () => {
  const useCase = new LoginUseCase({
    app: fakeApp(),
    sources: fakeSources({
      clientJwt: "client",
      sessionId: "sess_1",
      userId: "user_1",
      orgId: "org_1",
      source: "browser",
    }),
  });
  const session = await useCase.login("browser");
  expect(session.orgId).toBe("org_1");
  expect(session.source).toBe("browser");
  expect(session.clientId).toBe("");
});

test("login：没有组织 → invalid_request", async () => {
  const app = fakeApp({
    async me() { return { id: "user_1" }; },
    async organizations() { return []; },
  });
  const useCase = new LoginUseCase({
    app,
    sources: fakeSources({ clientJwt: "c", sessionId: "s", userId: "u", source: "local" }),
  });
  await expect(useCase.login("local")).rejects.toMatchObject({ kind: "invalid_request", status: 400 });
});

test("login：mint 的 keyId 记录进 session，authRecordOf 往返保留；expires 可覆盖", async () => {
  const useCase = new LoginUseCase({
    app: fakeApp(),
    sources: fakeSources({
      clientJwt: "client",
      sessionId: "sess_1",
      userId: "user_1",
      source: "local",
    }),
  });
  const session = await useCase.login("local");
  expect(session.apiKeyId).toBe("key_1");
  const record = authRecordOf(session);
  expect((record.metadata as { keyId?: string }).keyId).toBe("key_1");
  expect(sessionOfAuth(record).apiKeyId).toBe("key_1");
  expect(authRecordOf(session, { expires: 123 }).expires).toBe(123);
});

test("cookieCredentialOf：单条 {name, value} 对象特判（M-17）", () => {
  const client = jwt({ id: "client_id" });
  const session = jwt({ sid: "sess_cookie" });
  // 单个对象不是数组：以前会被拆成 name=/value= 两对，现在认作一条 cookie。
  // 只有 __client、没有会话信息时报缺 sessionId（而不是报缺 __client）。
  expect(() => cookieCredentialOf(JSON.stringify({ name: "__client", value: client }))).toThrow("sessionId");
  expect(cookieCredentialOf(`__client=${client}; __session=${session}`).sessionId).toBe("sess_cookie");
});

test("cookieCredentialOf：不透明 __session 直接用作 session id 回退（M-17）", () => {
  const client = jwt({ id: "client_id" });
  const credential = cookieCredentialOf(`__client=${client}; __session=opaque-token-123`);
  expect(credential.sessionId).toBe("opaque-token-123");
});

test("login：多组织无偏好 → 报错文案是“有多个组织”，不是“没有组织”（M-18）", async () => {
  const app = fakeApp({
    async me() { return { id: "user_1" }; },
    async organizations() { return [{ id: "org_1" }, { id: "org_2" }]; },
  });
  const useCase = new LoginUseCase({
    app,
    sources: fakeSources({ clientJwt: "c", sessionId: "s", userId: "u", source: "local" }),
  });
  try {
    await useCase.login("local");
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toMatchObject({ kind: "invalid_request" });
    expect(error instanceof Error && error.message).toContain("有多个组织");
    expect(error instanceof Error && error.message).not.toContain("没有组织");
  }
});
