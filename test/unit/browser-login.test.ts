import { expect, test } from "bun:test";

import { clientIdOf, isCapyCookieDomain, isCapyPageUrl } from "../../src/adapters/capy/browser-login.ts";

test("browser-login：只信任 capy.ai / clerk.capy.ai / *.capy.ai 的 https 页面", () => {
  expect(isCapyPageUrl("https://capy.ai/sign-in")).toBe(true);
  expect(isCapyPageUrl("https://clerk.capy.ai/sign-in")).toBe(true);
  expect(isCapyPageUrl("https://app.capy.ai/")).toBe(true);
  expect(isCapyPageUrl("https://capy.ai:443/x")).toBe(true);
  expect(isCapyPageUrl("http://capy.ai/sign-in")).toBe(false);
  expect(isCapyPageUrl("https://evilcapy.ai/")).toBe(false);
  expect(isCapyPageUrl("https://capy.ai.evil.com/")).toBe(false);
  expect(isCapyPageUrl("https://google.com/")).toBe(false);
  expect(isCapyPageUrl("")).toBe(false);
  expect(isCapyPageUrl(null)).toBe(false);
  expect(isCapyPageUrl("not a url")).toBe(false);
});

test("browser-login：__client 必须是 capy 域的 cookie", () => {
  expect(isCapyCookieDomain("capy.ai")).toBe(true);
  expect(isCapyCookieDomain(".capy.ai")).toBe(true);
  expect(isCapyCookieDomain("clerk.capy.ai")).toBe(true);
  expect(isCapyCookieDomain(".clerk.capy.ai")).toBe(true);
  expect(isCapyCookieDomain("google.com")).toBe(false);
  expect(isCapyCookieDomain("evilcapy.ai")).toBe(false);
  expect(isCapyCookieDomain("")).toBe(false);
  expect(isCapyCookieDomain(null)).toBe(false);
});

function b64url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

test("browser-login：clientIdOf 只认 payload 里字符串 id，畸形 JWT 返回空串", () => {
  expect(clientIdOf("header." + b64url(JSON.stringify({ id: "client_123" })) + ".sig")).toBe("client_123");
  expect(clientIdOf("")).toBe("");
  expect(clientIdOf("notajwt")).toBe("");
  expect(clientIdOf("a.b")).toBe(""); // b 不是合法 JSON
  expect(clientIdOf("a." + b64url(JSON.stringify({ id: 123 })) + ".sig")).toBe("");
  expect(clientIdOf("a." + b64url(JSON.stringify({})) + ".sig")).toBe("");
  expect(clientIdOf("a." + b64url("\"just-a-string\"") + ".sig")).toBe("");
  expect(clientIdOf("a." + b64url("[1,2]") + ".sig")).toBe("");
  expect(clientIdOf("a.!!!.sig")).toBe("");
});
