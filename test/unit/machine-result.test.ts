import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "bun:test";

import { machineResult } from "../../src/adapters/capy/device-tunnel.ts";

function setup(content: string): { dir: string; path: string } {
  const dir = mkdtempSync(join(tmpdir(), "capy-edit-"));
  const path = join(dir, "a.txt");
  writeFileSync(path, content, "utf8");
  return { dir, path };
}

test("edit：newString 里的 $&/$1 按字面写，不被 String.replace 解释（M-01）", async () => {
  const { dir, path } = setup("hello foo world");
  try {
    const out = await machineResult("edit", { path: "a.txt", oldString: "foo", newString: "$& $1" }, dir);
    expect(out.status).toBe("succeeded");
    expect(readFileSync(path, "utf8")).toBe("hello $& $1 world");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("edit：replaceAll 分支同样按字面写 $ 模式（M-01）", async () => {
  const { dir, path } = setup("foo and foo");
  try {
    const out = await machineResult(
      "edit",
      { path: "a.txt", oldString: "foo", newString: "$'", replaceAll: true },
      dir,
    );
    expect(out.status).toBe("succeeded");
    expect(readFileSync(path, "utf8")).toBe("$' and $'");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
