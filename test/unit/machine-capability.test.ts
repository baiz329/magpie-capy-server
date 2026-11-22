import { expect, test } from "bun:test";

import {
  allowedHandlers,
  machineCapabilityOf,
  refusalFor,
  shouldWarnFull,
} from "../../src/adapters/capy/machine-capability.ts";

test("machine-capability：默认 files，未知值回落 files 并 warn", () => {
  expect(machineCapabilityOf({})).toBe("files");
  expect(machineCapabilityOf({ MAGPIE_CAPY_MACHINE_TOOLS: "" })).toBe("files");
  expect(machineCapabilityOf({ MAGPIE_CAPY_MACHINE_TOOLS: "off" })).toBe("off");
  expect(machineCapabilityOf({ MAGPIE_CAPY_MACHINE_TOOLS: "full" })).toBe("full");
  const warns: string[] = [];
  expect(machineCapabilityOf({ MAGPIE_CAPY_MACHINE_TOOLS: "yes" }, (m) => warns.push(m))).toBe("files");
  expect(warns.length).toBe(1);
  expect(shouldWarnFull("full")).toBe(true);
  expect(shouldWarnFull("files")).toBe(false);
});

test("machine-capability：off 时所有 handler 拒；files 时 bash 拒、文件放行", () => {
  for (const handler of ["read", "write", "edit", "file_read", "file_write", "bash", "worktree_ensure"]) {
    expect(refusalFor(handler, "off")).not.toBeNull();
  }
  expect(refusalFor("bash", "files")).toMatch(/full/);
  for (const handler of ["read", "write", "edit", "file_read", "file_write", "worktree_ensure", "worktree_list"]) {
    expect(refusalFor(handler, "files")).toBeNull();
  }
  expect(refusalFor("bash", "full")).toBeNull();
  expect(allowedHandlers("files").has("bash")).toBe(false);
  expect(allowedHandlers("full").has("bash")).toBe(true);
});

test("machine-capability：占位 handler 永远 Unavailable", () => {
  for (const handler of ["bash_output", "volume_landed", "volume_probe"]) {
    expect(refusalFor(handler, "full")).toMatch(/未实现/);
  }
  expect(refusalFor("definitely-not-a-handler", "full")).toMatch(/未实现/);
  expect(refusalFor("", "full")).toMatch(/未实现/);
});
