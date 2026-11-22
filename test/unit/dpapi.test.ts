import { expect, test } from "bun:test";
import crypto from "node:crypto";

import {
  coerceAesKey,
  decryptChromiumAesGcm,
  dpapiProtect,
  dpapiUnprotect,
  powershellExecutable,
} from "../../src/adapters/platform/dpapi.ts";

test("dpapi：powershell 用绝对路径，不走 PATH 查找", () => {
  const exe = powershellExecutable();
  expect(exe.toLowerCase().endsWith("powershell.exe")).toBe(true);
  expect(exe).toContain("System32");
  expect(exe).not.toBe("powershell.exe");
  expect(exe.startsWith("C:") || exe.includes(":\\")).toBe(true);
});

test("dpapi：非 Windows 下 Protect/Unprotect 异步拒绝（不阻塞事件循环）", async () => {
  if (process.platform === "win32") return;
  await expect(dpapiProtect("capyd_placeholder")).rejects.toThrow(/Windows/);
  await expect(dpapiUnprotect(new Uint8Array([1, 2, 3]))).rejects.toThrow(/Windows/);
  // 必须是 Promise（异步 API），而不是同步抛错。
  const pending = dpapiProtect("x");
  expect(typeof pending.then).toBe("function");
  await expect(pending).rejects.toThrow(/Windows/);
});

test("dpapi：powershell 路径跟 SystemRoot 走，空值回退 C:\\Windows", () => {
  expect(powershellExecutable({ SystemRoot: "D:\\Win" })).toBe(
    "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(powershellExecutable({})).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(powershellExecutable({ SystemRoot: "   " })).toContain("C:\\Windows");
});

test("dpapi：decryptChromiumAesGcm 拒绝短密文与非 v10 前缀", () => {
  expect(() => decryptChromiumAesGcm(Buffer.from("short").toString("base64"), new Uint8Array(32))).toThrow(
    /长度异常/,
  );
  const notV10 = Buffer.concat([
    Buffer.from("x10"),
    Buffer.alloc(12),
    Buffer.alloc(4),
    Buffer.alloc(16),
  ]).toString("base64");
  expect(() => decryptChromiumAesGcm(notV10, new Uint8Array(32))).toThrow(/不是 v10 格式/);
});

test("dpapi：decryptChromiumAesGcm 篡改 tag 后认证失败，不返回明文", () => {
  const key = crypto.randomBytes(32);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update("secret", "utf8"), cipher.final()]);
  const tag = Buffer.from(cipher.getAuthTag());
  tag[0] = tag[0] === 0 ? 1 : 0; // 篡改认证标签
  const tampered = Buffer.concat([Buffer.from("v10"), nonce, body, tag]).toString("base64");
  expect(() => decryptChromiumAesGcm(tampered, key)).toThrow();
  // 未篡改时能解出原文（对照：不是“永远抛错”）。
  const good = Buffer.concat([
    Buffer.from("v10"),
    nonce,
    body,
    Buffer.from(cipher.getAuthTag()),
  ]).toString("base64");
  expect(decryptChromiumAesGcm(good, key)).toBe("secret");
});

test("dpapi：coerceAesKey 只接受 32 字节 key", () => {
  expect(() => coerceAesKey("abcd")).toThrow(/32 字节/);
  expect(() => coerceAesKey(Buffer.alloc(31))).toThrow(/32 字节/);
  expect(() => coerceAesKey(12345)).toThrow(/32 字节/);
  expect(() => coerceAesKey("zz".repeat(32))).toThrow(/32 字节/);
  expect(coerceAesKey("ab".repeat(32)).length).toBe(32);
});
