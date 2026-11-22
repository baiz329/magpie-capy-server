import { expect, test } from "bun:test";

import { readCapyInstall } from "../../src/adapters/capy/local-login.ts";

/**
 * 本机导入的负向用例。
 *
 * readCapyInstall 在非 Windows 上直接拒绝（平台守卫在读文件之前），
 * 所以文件级负向（缺文件、坏 JSON、缺 os_crypt key）只能在 Windows 上跑；
 * 这里先覆盖平台守卫与“不把内部路径泄漏进错误”的底线。
 * 文件级用例见 Windows 人工验收（smoke 时由真机覆盖）。
 */
test("local-login：非 Windows 下直接拒绝，不读任何文件", async () => {
  if (process.platform === "win32") return;
  let caught: unknown;
  try {
    await readCapyInstall("/definitely/not/a/capy/dir");
  } catch (error) {
    caught = error;
  }
  const err = caught as { kind?: string; message?: string } | undefined;
  expect(err?.kind).toBe("invalid_request");
  expect(err?.message).toContain("只支持 Windows");
  expect(err?.message).not.toContain("/definitely/not/a/capy/dir");
});
