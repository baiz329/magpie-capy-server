import type { HeadlessCredential } from "./device-runtime.ts";

export interface ClockPort {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface IdPort {
  ulid(now?: number): string;
  uuid(): string;
}

export interface LogFields {
  readonly [key: string]: string | number | boolean | null | undefined;
}

export interface LoggerPort {
  event(name: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
}

export interface SecretStorePort {
  load(accountKey: string): Promise<HeadlessCredential | null>;
  save(accountKey: string, credential: HeadlessCredential): Promise<void>;
  clear(accountKey: string): Promise<void>;
}

export interface CachePort {
  get<T>(key: string): T | undefined;
  set<T>(key: string, value: T, ttlMs: number): void;
  delete(key: string): void;
  clear(): void;
}
