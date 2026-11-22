import { isAuthError } from "../domain/errors.ts";
import type { Balance, UsageSnapshot, UsageTotals, UsageWindow } from "../domain/usage.ts";
import type { CapyPublicPort } from "../ports/capy-public.ts";
import type { CachePort } from "../ports/platform.ts";
import { keyHash } from "./key-hash.ts";

export interface UsageUseCaseOptions {
  readonly publicApi: CapyPublicPort;
  readonly cache?: CachePort;
  readonly cacheTtlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

export class UsageUseCase {
  private readonly options: UsageUseCaseOptions;

  constructor(options: UsageUseCaseOptions) {
    this.options = options;
  }

  async load(apiKey: string, signal?: AbortSignal): Promise<UsageSnapshot> {
    // 缓存键用密钥哈希，不用 apiKey 尾部（M-05）。
    const key = `usage:${await keyHash(apiKey)}`;
    const hit = this.options.cache?.get<UsageSnapshot>(key);
    if (hit) return hit;
    try {
      const [usage, balance] = await Promise.all([
        this.options.publicApi.usage(apiKey, signal),
        this.options.publicApi.balance(apiKey, signal),
      ]);
      const snapshot = buildUsage(usage, balance);
      this.options.cache?.set(key, snapshot, this.options.cacheTtlMs ?? DEFAULT_TTL_MS);
      return snapshot;
    } catch (error) {
      if (isAuthError(error)) throw error;
      return {
        windows: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

export function buildUsage(usage: UsageTotals, balance: Balance): UsageSnapshot {
  const windows: UsageWindow[] = [];
  const currency = String(balance.currency ?? "USD").toUpperCase();
  const unlimited = balance.unlimited === true;
  const remaining = balance.remainingDollars;
  const hasRemaining = remaining !== null && remaining !== undefined && Number.isFinite(Number(remaining));
  const resetsAt = isoOf(balance.periodEnd);

  if (unlimited) {
    windows.push({ name: "余额", used: 0, display: "无限额度", unit: currency });
  } else if (hasRemaining) {
    const value = Number(remaining);
    windows.push({
      name: "余额",
      used: value > 0 ? 0 : 100,
      display: value > 0 ? `${money(value, currency)} 可用` : "余额已用尽",
      unit: currency,
      ...(resetsAt ? { resetsAt } : {}),
    });
  } else {
    // 余额未知：与"已用尽"区分开。used=100 是 Magpie 的路由策略——
    // 余额未知/为零时让账号沉底，不是 Capy API 返回的字段。
    windows.push({
      name: "余额",
      used: 100,
      display: "余额未知",
      ...(resetsAt ? { resetsAt } : {}),
    });
  }

  const tokens = tokensText(usage.tokens);
  if (tokens) {
    windows.push({ name: "Token", used: 0, aside: true, display: tokens, unit: "tokens" });
  }

  return {
    windows,
    ...(unlimited ? { plan: "Unlimited" } : {}),
    ...(hasRemaining ? { balance: money(Number(remaining), currency) } : {}),
  };
}

export function withDeviceWindow(snapshot: UsageSnapshot, device: { connected: boolean; name?: string }): UsageSnapshot {
  return {
    ...snapshot,
    windows: [
      ...snapshot.windows,
      {
        name: "无头设备",
        used: device.connected ? 0 : 100,
        aside: true,
        display: device.connected
          ? `已连接${device.name ? ` · ${device.name}` : ""}`
          : "未连接（点击对话后自动连接）",
      },
    ],
  };
}

export function money(value: number, currency = "USD"): string {
  const symbol = currency === "USD" ? "$" : `${currency} `;
  if (!Number.isFinite(value)) return `${symbol}0`;
  // 负号放货币符号前面（-$5.25，不是 $-5.25）；整数不补小数，
  // 有小数时保留两位（>=100 也不丢小数）。
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const body = Number.isInteger(abs) ? String(abs) : abs.toFixed(2);
  return `${sign}${symbol}${body}`;
}

function tokensText(tokens: UsageTotals["tokens"]): string {
  const input = Number(tokens?.inputTokens);
  const output = Number(tokens?.outputTokens);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return "";
  const compact = (value: number) => {
    if (!Number.isFinite(value)) return "0";
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
    return String(value);
  };
  return `输入 ${compact(input)} / 输出 ${compact(output)} tokens`;
}

function isoOf(value: string | number | null | undefined): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") {
    return new Date(value > 1e12 ? value : value * 1000).toISOString();
  }
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

