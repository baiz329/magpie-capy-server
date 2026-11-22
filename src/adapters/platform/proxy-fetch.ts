import { execFileSync } from "node:child_process";

import { CapyError } from "../../domain/errors.ts";

const REG_PATH = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";
const PROXY_KEYS = [
  "MAGPIE_CAPY_PROXY",
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
] as const;
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);
const SYSTEM_PROXY_TTL_MS = 60_000;

let cachedSystemProxy: { at: number; value: string } = { at: 0, value: "" };

function regQuery(name: string): string {
  if (process.platform !== "win32") return "";
  const reg = `${process.env.SystemRoot || "C:\\Windows"}\\System32\\reg.exe`;
  try {
    const out = execFileSync(reg, ["query", REG_PATH, "/v", name], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = new RegExp(`${name}\\s+REG_\\w+\\s+(.+?)\\s*$`, "imu").exec(out);
    return match?.[1]?.trim() ?? "";
  } catch {
    return "";
  }
}

function normalizeProxyUrl(raw: unknown): string {
  let text = String(raw ?? "").trim().replace(/^"|"$/gu, "");
  if (!text) return "";
  if (text === "off" || text === "false" || text === "none") return "";
  if (/^[a-z]+=/iu.test(text) && text.includes(";")) {
    const map = new Map<string, string>();
    for (const part of text.split(";")) {
      const [key, value] = part.split("=");
      if (key && value) map.set(key.trim().toLowerCase(), value.trim());
    }
    text = map.get("https") ?? map.get("http") ?? "";
  }
  if (!text) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) text = `http://${text}`;
  try {
    const url = new URL(text);
    if (!url.hostname) return "";
    return url.toString().replace(/\/$/u, "");
  } catch {
    return "";
  }
}

/**
 * 只输出 `scheme://host:port`（H-02）：代理 URL 里可能带 `user:pass`，
 * 原来整条 URL 被打进 warn 日志等于把代理凭据写进磁盘。
 */
export function describeProxy(raw: string): string {
  const text = normalizeProxyUrl(raw);
  if (!text) return "configured";
  try {
    const url = new URL(text);
    const scheme = url.protocol.replace(/:$/u, "") || "http";
    const port = url.port || (scheme === "https" ? "443" : "80");
    return `${scheme}://${url.hostname}:${port}`;
  } catch {
    return "configured";
  }
}

/** 默认 fail-closed：只有显式 `MAGPIE_CAPY_PROXY_FALLBACK=direct` 才允许直连兜底。 */
function allowDirectFallback(): boolean {
  return String(process.env.MAGPIE_CAPY_PROXY_FALLBACK ?? "").trim().toLowerCase() === "direct";
}

function systemProxy(): string {
  if (process.platform !== "win32") return "";
  if (Date.now() - cachedSystemProxy.at < SYSTEM_PROXY_TTL_MS) return cachedSystemProxy.value;
  const enabled = regQuery("ProxyEnable").toLowerCase();
  const server = regQuery("ProxyServer");
  const value = /0x0*1\b|^1$/iu.test(enabled) || (!enabled && server)
    ? normalizeProxyUrl(server)
    : "";
  cachedSystemProxy = { at: Date.now(), value };
  return value;
}

function hostMatchesNoProxy(host: string, noProxy: string | undefined): boolean {
  const rules = String(noProxy ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (rules.length === 0) return false;
  const plain = host.toLowerCase();
  for (const rule of rules) {
    if (rule === "*") return true;
    const value = rule.replace(/^\./u, "");
    if (plain === value || plain.endsWith(`.${value}`)) return true;
  }
  return false;
}

export function resolveProxyUrl(options: {
  readonly proxy?: string | false;
  readonly env?: Record<string, string | undefined>;
} = {}): string {
  if (options.proxy === false) return "";
  if (typeof options.proxy === "string") {
    const explicit = options.proxy.trim().toLowerCase();
    if (explicit === "off" || explicit === "false" || explicit === "none") return "";
    if (explicit) return normalizeProxyUrl(options.proxy);
  }
  const env = options.env ?? process.env;
  // MAGPIE_CAPY_PROXY=off 是显式禁用：不再继续读 HTTPS_PROXY（H-03）。
  const envOff = String(env.MAGPIE_CAPY_PROXY ?? "").trim().toLowerCase();
  if (envOff === "off" || envOff === "false" || envOff === "none") return "";
  for (const key of PROXY_KEYS) {
    const value = normalizeProxyUrl(env[key]);
    if (value) return value;
  }
  return systemProxy();
}

function proxyConnectionError(error: unknown): boolean {
  return /ECONNREFUSED|ConnectionRefused|Unable to connect|proxy connect|proxy server/iu
    .test(String((error as { message?: unknown } | null)?.message ?? error));
}

/**
 * Bun 用 fetch 的 proxy 选项；Node 有 undici 就挂 ProxyAgent。
 *
 * 代理连不上时**默认失败**（fail-closed，H-03）：静默直连会让"必须走代理"的网络
 * 悄悄绕过代理，既不可预期也可能违反合规。需要兜底时显式设
 * `MAGPIE_CAPY_PROXY_FALLBACK=direct`。
 *
 * 另外：Bun 分支不再退到全局 `fetch`（H-03：那会绕过注入的 baseFetch，
 * 生产里等于绕过重试/超时/测试替身）。
 */
export function createProxyFetch(
  baseFetch: typeof fetch,
  proxyUrl: string,
  options: { readonly onWarn?: (message: string) => void } = {},
): typeof fetch {
  const url = normalizeProxyUrl(proxyUrl);
  if (!url) return baseFetch;
  const label = describeProxy(url);

  let warned = false;
  let undiciAgent: unknown = null;
  let undiciTried = false;
  const warn = (message: string) => {
    if (warned) return;
    warned = true;
    options.onWarn?.(message);
  };

  return async function proxyFetch(input, init = {}) {
    const target = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    let host = "";
    try { host = new URL(target).hostname; } catch {}
    if (host && (LOCAL_HOSTS.has(host) || hostMatchesNoProxy(host, process.env.NO_PROXY ?? process.env.no_proxy))) {
      return baseFetch(input, init);
    }

    const directInstead = (reason: string, error: unknown): Promise<Response> => {
      if (!allowDirectFallback()) throw error;
      warn(`${reason}，按 MAGPIE_CAPY_PROXY_FALLBACK=direct 本次直连`);
      return baseFetch(input, init);
    };

    if (typeof Bun !== "undefined") {
      const withProxy = { ...init, proxy: url } as RequestInit & { proxy: string };
      try {
        return await baseFetch(input, withProxy);
      } catch (error) {
        if (proxyConnectionError(error)) return directInstead(`代理 ${label} 连接失败`, error);
        throw error;
      }
    }

    if (!undiciTried) {
      undiciTried = true;
      try {
        // @ts-expect-error undici 是可选运行时依赖，类型不装
        const undici = await import("undici");
        if (typeof undici.ProxyAgent === "function") undiciAgent = new undici.ProxyAgent(url);
      } catch {
        undiciAgent = null;
      }
    }
    if (undiciAgent) {
      const withDispatcher = { ...init, dispatcher: undiciAgent } as RequestInit & { dispatcher: unknown };
      try {
        return await baseFetch(input, withDispatcher);
      } catch (error) {
        if (proxyConnectionError(error)) return directInstead(`代理 ${label} 连接失败`, error);
        throw error;
      }
    }

    warn(
      `检测到代理 ${label}，但当前 Node 运行时不支持 fetch 代理（未安装 undici）。`
      + "请改用 magpie 自带 Bun 运行时，或设置 NODE_OPTIONS=--use-env-proxy 后重启。",
    );
    if (allowDirectFallback()) return baseFetch(input, init);
    throw new CapyError(
      "upstream_unavailable",
      `当前运行时不支持 fetch 代理（${label}）：请安装 undici，或设置 MAGPIE_CAPY_PROXY_FALLBACK=direct 允许直连兜底`,
    );
  } as typeof fetch;
}
