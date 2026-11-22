import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  defaultDeviceName,
  machineResult,
  resolveWorktreeBase,
  writeFileSafely,
  type MachineContext,
} from "../../src/adapters/capy/device-tunnel.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capy-machine-"));
}

function fullContext(dir: string, extra: Partial<MachineContext> = {}): MachineContext {
  return { base: dir, root: dir, capability: "full", ...extra };
}

test("machine：默认设备名使用主机名，支持 env 覆盖", () => {
  const previous = process.env.MAGPIE_CAPY_DEVICE_NAME;
  delete process.env.MAGPIE_CAPY_DEVICE_NAME;
  try {
    expect(defaultDeviceName()).toBe(os.hostname());
  } finally {
    if (previous !== undefined) process.env.MAGPIE_CAPY_DEVICE_NAME = previous;
  }
  process.env.MAGPIE_CAPY_DEVICE_NAME = "baijiu";
  try {
    expect(defaultDeviceName()).toBe("baijiu");
  } finally {
    delete process.env.MAGPIE_CAPY_DEVICE_NAME;
  }
});

test("machine：工作区根支持 MAGPIE_CAPY_WORKTREE_BASE 覆盖", () => {
  const previous = process.env.MAGPIE_CAPY_WORKTREE_BASE;
  delete process.env.MAGPIE_CAPY_WORKTREE_BASE;
  try {
    expect(resolveWorktreeBase()).toBe(path.join(os.homedir(), ".capy", "worktrees"));
    expect(resolveWorktreeBase("/tmp/explicit")).toBe("/tmp/explicit");
    process.env.MAGPIE_CAPY_WORKTREE_BASE = "/tmp/from-env";
    expect(resolveWorktreeBase()).toBe("/tmp/from-env");
    expect(resolveWorktreeBase("/tmp/explicit")).toBe("/tmp/explicit");
    process.env.MAGPIE_CAPY_WORKTREE_BASE = "~/wt";
    expect(resolveWorktreeBase()).toBe(path.join(os.homedir(), "wt"));
  } finally {
    if (previous !== undefined) process.env.MAGPIE_CAPY_WORKTREE_BASE = previous;
    else delete process.env.MAGPIE_CAPY_WORKTREE_BASE;
  }
});

const bashExecutable = process.env.MAGPIE_CAPY_BASH?.trim() || "bash";

test.skipIf(!Bun.which(bashExecutable))("machine：bash 执行命令", async () => {
  const dir = tempDir();
  try {
    const result = await machineResult("bash", { command: "echo capy-bash-ok", timeoutSeconds: 10 }, fullContext(dir));
    expect(result.status).toBe("succeeded");
    if (result.status === "succeeded") {
      const value = result.result as { kind: string; stdout: string; exitCode: number };
      expect(value.kind).toBe("bash");
      expect(value.stdout).toContain("capy-bash-ok");
      expect(value.exitCode).toBe(0);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("machine：write / read / edit / file_read / file_write", async () => {
  const dir = tempDir();
  try {
    const write = await machineResult("write", { path: "a.txt", content: "hello\nworld\n" }, dir);
    expect(write.status).toBe("succeeded");
    const read = await machineResult("read", { path: "a.txt" }, dir);
    expect(read.status).toBe("succeeded");
    if (read.status === "succeeded") {
      expect((read.result as { content: string }).content).toContain("world");
    }
    const edit = await machineResult("edit", { path: "a.txt", oldString: "world", newString: "capy" }, dir);
    expect(edit.status).toBe("succeeded");
    const fileRead = await machineResult("file_read", { path: "a.txt" }, dir);
    expect(fileRead.status).toBe("succeeded");
    if (fileRead.status === "succeeded") {
      expect((fileRead.result as { content: { text: string } }).content.text).toContain("capy");
    }
    const fileWrite = await machineResult("file_write", { path: "b.txt", content: "b" }, dir);
    expect(fileWrite.status).toBe("succeeded");
    const missing = await machineResult("file_read", { path: "nope.txt" }, dir);
    expect(missing.status).toBe("succeeded");
    if (missing.status === "succeeded") {
      expect((missing.result as { kind: string }).kind).toBe("missing");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine：默认 files 档 bash 被拒；off 档所有 handler 被拒", async () => {
  const dir = tempDir();
  try {
    const bash = await machineResult("bash", { command: "echo hi" }, dir);
    expect(bash.status).toBe("failed");
    if (bash.status === "failed") expect(bash.error.code).toBe("MachineServer.Unavailable");
    const off = await machineResult("read", { path: "a.txt" }, { base: dir, root: dir, capability: "off" });
    expect(off.status).toBe("failed");
    if (off.status === "failed") expect(off.error.code).toBe("MachineServer.Unavailable");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine：路径穿越与符号链接逃逸返回 Refused", async () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "a.txt"), "inside");
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    const escape = await machineResult("read", { path: "../secret.txt" }, dir);
    expect(escape.status).toBe("failed");
    if (escape.status === "failed") expect(escape.error.code).toBe("MachineServer.Refused");
    const absolute = await machineResult("read", { path: path.join(outside, "secret.txt") }, dir);
    expect(absolute.status).toBe("failed");
    if (absolute.status === "failed") expect(absolute.error.code).toBe("MachineServer.Refused");
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "evil.txt"));
    const link = await machineResult("read", { path: "evil.txt" }, dir);
    expect(link.status).toBe("failed");
    if (link.status === "failed") expect(link.error.code).toBe("MachineServer.Refused");
    const writeLink = await machineResult("write", { path: "evil.txt", content: "pwned" }, dir);
    expect(writeLink.status).toBe("failed");
    expect(fs.readFileSync(path.join(outside, "secret.txt"), "utf8")).toBe("secret");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("machine：worktree_ensure 永远对 base 校验；worktree_list 真列目录", async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.join(dir, "proj-a"));
    fs.mkdirSync(path.join(dir, "proj-b"));
    fs.writeFileSync(path.join(dir, "top.txt"), "x");
    const list = await machineResult("worktree_list", {}, dir);
    expect(list.status).toBe("succeeded");
    if (list.status === "succeeded") {
      const entries = (list.result as { entries: { name: string }[] }).entries;
      expect(entries.map((e) => e.name)).toEqual(["proj-a", "proj-b"]);
    }
    const outside = await machineResult(
      "worktree_ensure",
      { root: path.join(path.dirname(dir), "outside-root") },
      { base: dir, root: dir },
    );
    expect(outside.status).toBe("failed");
    if (outside.status === "failed") expect(outside.error.code).toBe("MachineServer.Refused");
    const inside = await machineResult("worktree_ensure", { root: path.join(dir, "proj-c") }, dir);
    expect(inside.status).toBe("succeeded");
    expect(fs.existsSync(path.join(dir, "proj-c"))).toBe(true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine：占位 handler 返回 Unavailable，不给假成功", async () => {
  const dir = tempDir();
  try {
    for (const handler of ["bash_output", "volume_landed", "volume_probe"]) {
      const result = await machineResult(handler, {}, { base: dir, root: dir, capability: "full" });
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.error.code).toBe("MachineServer.Unavailable");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!Bun.which(bashExecutable))("machine：bash 不继承敏感环境变量、非零退出码记 isError、审计只记摘要", async () => {
  const dir = tempDir();
  const audits: { command: string; exitCode: number; durationMs: number }[] = [];
  try {
    const leak = await machineResult(
      "bash",
      { command: "echo \"key=${CAPY_TEST_SECRET_KEY:-empty} token=${MAGPIE_CAPY_FAKE_TOKEN:-empty}\"", timeoutSeconds: 10 },
      fullContext(dir, {
        env: {
          ...process.env,
          CAPY_TEST_SECRET_KEY: "capy_secret_value",
          MAGPIE_CAPY_FAKE_TOKEN: "capyd_secret_value",
          MY_API_KEY: "sk-secret-value",
        },
        audit: (entry) => audits.push(entry),
      }),
    );
    expect(leak.status).toBe("succeeded");
    if (leak.status === "succeeded") {
      const value = leak.result as { stdout: string };
      expect(value.stdout).not.toContain("capy_secret_value");
      expect(value.stdout).not.toContain("capyd_secret_value");
      expect(value.stdout).not.toContain("sk-secret-value");
    }
    expect(audits.length).toBe(1);
    expect(audits[0]?.exitCode).toBe(0);
    expect(audits[0]?.command.length).toBeLessThanOrEqual(201);

    const failing = await machineResult(
      "bash",
      { command: "echo out; echo err 1>&2; exit 3", timeoutSeconds: 10 },
      fullContext(dir, { audit: (entry) => audits.push(entry) }),
    );
    expect(failing.status).toBe("succeeded");
    if (failing.status === "succeeded") {
      const value = failing.result as { isError: boolean; exitCode: number };
      expect(value.isError).toBe(true);
      expect(value.exitCode).toBe(3);
    }
    expect(audits.length).toBe(2);
    expect(audits[1]?.exitCode).toBe(3);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

test("machine：read/file_read 超 8MB 返回 too-large，不整文件读进内存", async () => {
  const dir = tempDir();
  try {
    const big = path.join(dir, "big.bin");
    fs.writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1, 0x61));
    const read = await machineResult("read", { path: "big.bin" }, dir);
    expect(read.status).toBe("succeeded");
    if (read.status === "succeeded") expect((read.result as { kind: string }).kind).toBe("too-large");
    const fileRead = await machineResult("file_read", { path: "big.bin" }, dir);
    expect(fileRead.status).toBe("succeeded");
    if (fileRead.status === "succeeded") expect((fileRead.result as { kind: string }).kind).toBe("too-large");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("machine：writeFileSafely 新建与已存在都原子替换，不跟随软链", () => {
  const dir = tempDir();
  const outside = tempDir();
  try {
    const file = path.join(dir, "a.txt");
    writeFileSafely(file, "v1");
    expect(fs.readFileSync(file, "utf8")).toBe("v1");
    writeFileSafely(file, "v2");
    expect(fs.readFileSync(file, "utf8")).toBe("v2");
    expect(fs.readdirSync(dir).filter((n) => n.startsWith(".capy-tmp-"))).toEqual([]);
    fs.writeFileSync(path.join(outside, "victim.txt"), "victim");
    const link = path.join(dir, "link.txt");
    fs.symlinkSync(path.join(outside, "victim.txt"), link);
    expect(() => writeFileSafely(link, "pwned")).toThrow(/symlink/);
    expect(fs.readFileSync(path.join(outside, "victim.txt"), "utf8")).toBe("victim");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("machine：FileSecretStore 目录 0700、文件 0600、tmp 随机名、启动清残留", async () => {
  const { FileSecretStore } = await import("../../src/adapters/capy/device-tunnel.ts");
  const dir = tempDir();
  try {
    fs.writeFileSync(path.join(dir, "stale.123.abcdef.tmp"), "stale");
    const store = new FileSecretStore(dir);
    await store.save("user_1@org_1", {
      orgId: "org_1",
      deviceId: "dev_1",
      name: "test",
      token: `capyd_${"a".repeat(40)}`,
    });
    expect(fs.existsSync(path.join(dir, "stale.123.abcdef.tmp"))).toBe(false);
    const names = fs.readdirSync(dir);
    expect(names.filter((n) => n.endsWith(".tmp"))).toEqual([]);
    const file = path.join(dir, names.find((n) => n.startsWith("headless-")) ?? "");
    expect((fs.statSync(dir).mode & 0o777)).toBe(0o700);
    expect((fs.statSync(file).mode & 0o777)).toBe(0o600);
    const loaded = await store.load("user_1@org_1");
    expect(loaded?.deviceId).toBe("dev_1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
