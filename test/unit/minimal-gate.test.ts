import { expect, test } from "bun:test";

import { MinimalVariantGate } from "../../src/application/minimal-gate.ts";

test("minimal-gate：一个账号降级不影响另一个账号继续发 minimal（H-13(1)）", () => {
  const gate = new MinimalVariantGate(false);
  expect(gate.isUnsupported("acc-a")).toBe(false);
  expect(gate.isUnsupported("acc-b")).toBe(false);
  gate.markUnsupported("acc-a");
  expect(gate.isUnsupported("acc-a")).toBe(true);
  expect(gate.isUnsupported("acc-b")).toBe(false);
});

test("minimal-gate：configuredVariant 为 default/off 时全账号默认不发 minimal", () => {
  const gate = new MinimalVariantGate(true);
  expect(gate.isUnsupported("acc-a")).toBe(true);
  expect(gate.isUnsupported("acc-b")).toBe(true);
  gate.markUnsupported("acc-a");
  expect(gate.isUnsupported("acc-a")).toBe(true);
  expect(gate.isUnsupported("acc-b")).toBe(true);
});
