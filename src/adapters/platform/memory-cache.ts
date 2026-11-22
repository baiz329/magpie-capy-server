import type { CachePort } from "../../ports/platform.ts";

interface Entry {
  readonly value: unknown;
  readonly expiresAt: number;
}

/** 默认容量上限（M-05）：原来无上限，长跑进程会持续增长。 */
export const DEFAULT_MAX_ENTRIES = 128;

export class MemoryCache implements CachePort {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  private readonly maxEntries: number;

  constructor(now: () => number = Date.now, maxEntries: number = DEFAULT_MAX_ENTRIES) {
    this.now = now;
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0
      ? Math.floor(maxEntries)
      : DEFAULT_MAX_ENTRIES;
  }

  get<T>(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return hit.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const now = this.now();
    // 先清扫过期项，再按插入顺序淘汰最旧的。
    this.sweep(now);
    this.entries.delete(key); // 重新 set 视为新插入，排到 Map 末尾
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
    this.entries.set(key, { value, expiresAt: now + ttlMs });
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) {
      if (entry.expiresAt <= now) this.entries.delete(key);
    }
  }
}
