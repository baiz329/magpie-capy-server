import { expect, test } from "bun:test";

import { MemoryCache } from "../../src/adapters/platform/memory-cache.ts";

test("memory-cache：上限 128 条，按插入顺序淘汰最旧（M-05）", () => {
  const cache = new MemoryCache(() => 0);
  for (let i = 0; i < 130; i += 1) cache.set(`k${i}`, i, 60_000);
  expect(cache.get("k0")).toBeUndefined();
  expect(cache.get("k1")).toBeUndefined();
  expect(cache.get("k2")).toBe(2);
  expect(cache.get("k129")).toBe(129);
});

test("memory-cache：set 时先清扫过期项，过期项不占容量（M-05）", () => {
  let now = 0;
  const cache = new MemoryCache(() => now, 3);
  cache.set("a", 1, 100);
  cache.set("b", 2, 100);
  now = 200;
  cache.set("c", 3, 60_000);
  expect(cache.get("a")).toBeUndefined();
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("c")).toBe(3);
});

test("memory-cache：重新 set 已有键视为新插入，不提前淘汰（M-05）", () => {
  const cache = new MemoryCache(() => 0, 2);
  cache.set("a", 1, 60_000);
  cache.set("b", 2, 60_000);
  cache.set("a", 10, 60_000);
  cache.set("c", 3, 60_000);
  expect(cache.get("a")).toBe(10);
  expect(cache.get("b")).toBeUndefined();
  expect(cache.get("c")).toBe(3);
});
