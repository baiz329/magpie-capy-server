import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  JamRootRegistry,
  confine,
  isInside,
  jamIdOf,
  resolveMachineRoot,
} from "../../src/adapters/capy/machine-path.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capy-confine-"));
}

test("machine-path：相对穿越与绝对根外路径一律拒", () => {
  const dir = tempDir();
  try {
    expect(confine(dir, "../escape.txt").ok).toBe(false);
    expect(confine(dir, "../../etc/passwd").ok).toBe(false);
    expect(confine(dir, "/etc/passwd").ok).toBe(false);
    expect(confine(dir, "").ok).toBe(false);
    expect(confine(dir, "a\0b").ok).toBe(false);
    const ok = confine(dir, "sub/a.txt");
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.abs.startsWith(dir)).toBe(true);
    const self = confine(dir, ".");
    expect(self.ok).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine-path：符号链接逃逸被拒，根内链接放行", () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "evil.txt"));
    expect(confine(dir, "evil.txt").ok).toBe(false);
    fs.mkdirSync(path.join(dir, "real"));
    fs.writeFileSync(path.join(dir, "real", "a.txt"), "a");
    fs.symlinkSync(path.join(dir, "real"), path.join(dir, "linkdir"));
    expect(confine(dir, "linkdir/a.txt").ok).toBe(true);
    fs.symlinkSync(path.join(outside, "nope.txt"), path.join(dir, "dangling.txt"));
    expect(confine(dir, "dangling.txt").ok).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("machine-path：写操作不跟随末段软链", () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.writeFileSync(path.join(outside, "victim.txt"), "victim");
    fs.symlinkSync(path.join(outside, "victim.txt"), path.join(dir, "target.txt"));
    expect(confine(dir, "target.txt", { denySymlinkTarget: true }).ok).toBe(false);
    expect(confine(dir, "target.txt").ok).toBe(false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("machine-path：isInside 用 relative，不用 startsWith 前缀欺骗", () => {
  expect(isInside("/tmp/base", "/tmp/base-evil/x")).toBe(false);
  expect(isInside("/tmp/base", "/tmp/base/x")).toBe(true);
  expect(isInside("/tmp/base", "/tmp/base")).toBe(true);
  expect(isInside("/tmp/base", "/tmp/base/../evil/x")).toBe(false);
});

test("machine-path：Windows 规则（UNC/设备路径/盘符相对拒，大小写统一）", () => {
  const dir = "C:\\work\\base";
  expect(confine(dir, "\\\\server\\share\\x", { platform: "win32" }).ok).toBe(false);
  expect(confine(dir, "\\\\?\\C:\\x", { platform: "win32" }).ok).toBe(false);
  expect(confine(dir, "C:foo\\x", { platform: "win32" }).ok).toBe(false);
  expect(isInside("C:\\Work\\Base", "c:\\work\\base\\x", "win32")).toBe(true);
  expect(isInside("C:\\Work\\Base", "C:\\Work\\BaseEvil\\x", "win32")).toBe(false);
});

test("machine-path：JamRootRegistry TTL 30 分钟、容量 64 LRU", () => {
  let now = 0;
  const registry = new JamRootRegistry({ now: () => now, capacity: 3, ttlMs: 30 * 60_000 });
  registry.set("jam1", "/base/a");
  registry.set("jam2", "/base/b");
  registry.set("jam3", "/base/c");
  expect(registry.get("jam1")).toBe("/base/a");
  registry.set("jam4", "/base/d");
  expect(registry.size).toBe(3);
  expect(registry.get("jam2")).toBeUndefined();
  expect(registry.get("jam1")).toBe("/base/a");
  now += 31 * 60_000;
  expect(registry.get("jam1")).toBeUndefined();
  registry.set("", "/base/x");
  expect(registry.size).toBe(2);
});

test("machine-path：resolveMachineRoot 无归属退回 base", () => {
  const registry = new JamRootRegistry();
  registry.set("jam-1", "/base/jam-1");
  expect(resolveMachineRoot({ "x-capy-jam-id": "jam-1" }, "/base", registry)).toBe("/base/jam-1");
  expect(resolveMachineRoot({ "X-Capy-Thread-Id": "jam-1" }, "/base", registry)).toBe("/base/jam-1");
  expect(resolveMachineRoot({}, "/base", registry)).toBe("/base");
  expect(resolveMachineRoot({ "x-capy-jam-id": "unknown" }, "/base", registry)).toBe("/base");
  expect(jamIdOf({ "x-capy-jam-id": "  jam-9 " })).toBe("jam-9");
  expect(jamIdOf({})).toBe("");
});
