import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { defaultDeviceName, machineResult } from "../../src/adapters/capy/device-tunnel.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "capy-machine-"));
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

const bashExecutable = process.env.MAGPIE_CAPY_BASH?.trim() || "bash";

test.skipIf(!Bun.which(bashExecutable))("machine：bash 执行命令", async () => {
  const dir = tempDir();
  try {
    const result = await machineResult("bash", { command: "echo capy-bash-ok", timeoutSeconds: 10 }, dir);
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
});

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
