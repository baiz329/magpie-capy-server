import { expect, test } from "bun:test";

import { isSecretKey, redact, redactFields, truncate } from "../../src/observability/redact.ts";

test("redact：capydc_ 与预签名 URL 参数脱敏", () => {
  expect(redact("token capydc_abcdef123456 rest")).toBe("token capydc_… rest");
  expect(redact("device capyd_abcdef123456")).toBe("device capyd_…");
  const url = "https://bucket.s3.amazonaws.com/f?X-Amz-Algorithm=AWS4-HMAC-SHA256"
    + "&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20261122%2Fus-east-1%2Fs3%2Faws4_request"
    + "&X-Amz-Signature=abcdef1234567890";
  const out = redact(url);
  expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
  expect(out).not.toContain("abcdef1234567890");
  expect(out).toContain("X-Amz-Credential=[redacted]");
  expect(out).toContain("X-Amz-Signature=[redacted]");
  expect(out).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
  const sig = redact("https://example.com/up?Signature=abc123&Expires=999");
  expect(sig).toContain("Signature=[redacted]");
  expect(sig).not.toContain("abc123");
});

test("redact：sess_/__session/sessionId/userinfo/sk-/ghp_/AIza 脱敏", () => {
  expect(redact("sess_abcdef123456")).toBe("sess_…");
  expect(redact("__session=abc123; path=/")).toBe("__session=[redacted]; path=/");
  expect(redact("https://example.com/cb?sessionId=abc123&x=1")).toContain("sessionId=[redacted]");
  expect(redact("https://example.com/cb?sid=abc123")).toContain("sid=[redacted]");
  expect(redact("https://user:s3cret@example.com/x")).toBe("https://[redacted]@example.com/x");
  expect(redact("key sk-abcdef1234567890")).toBe("key sk-…");
  expect(redact("ghp_abcdefghij1234567890")).toBe("ghp_…");
  expect(redact("AIzaSyAbcdefghij1234567890")).toBe("AIza…");
  expect(redact("Authorization: Bearer abc.def.ghi")).toContain("[redacted]");
  expect(redact("plain text without secrets")).toBe("plain text without secrets");
});

test("redactFields：递归脱敏 + 凭据键名整字段置换 + 超长截断", () => {
  const out = redactFields({
    message: "failed with capyd_abcdef123456",
    nested: { apiKey: "sk-abcdef1234567890", count: 3 },
    list: ["capy_abcdef123456", "ok"],
    long: "x".repeat(600),
  });
  expect(out?.message).toBe("failed with capyd_…");
  expect((out?.nested as unknown as Record<string, unknown>)?.apiKey).toBe("[redacted]");
  expect((out?.nested as unknown as Record<string, unknown>)?.count).toBe(3);
  expect((out?.list as unknown as unknown[])[0]).toBe("capy_…");
  expect((out?.list as unknown as unknown[])[1]).toBe("ok");
  expect(String(out?.long).length).toBeLessThan(600);
  expect(String(out?.long)).toContain("[len=600]");
  expect(redactFields(undefined)).toBeUndefined();
  expect(isSecretKey("apiKey")).toBe(true);
  expect(isSecretKey("clerkCookie")).toBe(true);
  expect(isSecretKey("__session")).toBe(true);
  expect(isSecretKey("name")).toBe(false);
  expect(isSecretKey("count")).toBe(false);
  expect(truncate("x".repeat(600))).toContain("[len=600]");
  expect(truncate("short")).toBe("short");
});
