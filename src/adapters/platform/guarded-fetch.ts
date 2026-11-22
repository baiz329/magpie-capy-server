import { lookup as dnsLookup } from "node:dns/promises";

import { CapyError } from "../../domain/errors.ts";
import { isBlockedHostname, isBlockedIp, isIpLiteral } from "../../domain/net.ts";

/**
 * SSRF 硬化 fetcher（H-01）。
 *
 * 权威判定必须在这里，因为只有 adapter 才允许碰 `node:dns`。上层拿到的就是一个
 * 「已经安全」的 `fetch`，`application/attachments.ts` 不需要知道 DNS/重定向的存在。
 *
 * 规则（全部 fail-closed）：
 * 1. URL 不许带 userinfo；只允许 http(s)。
 * 2. 端口白名单；presign 模式要求 https。
 * 3. 主机字面量 / DNS 全部解析结果里**任一**私网 → 拒绝。
 * 4. 逐跳手动跟随重定向（默认 ≤3），每一跳都重新执行 1–3。
 * 5. 例外：`skipDnsCheck` 只豁免第 3 条里的 DNS 解析判定（签发方签名的 URL
 *    专用），其余检查照常；用户提供的 URL 绝不设此项。
 *
 * 已知限制：DNS 校验与实际建连之间仍可 rebinding（无 IP 固定连接）。
 */

export interface GuardedLookupResult {
  readonly address: string;
  readonly family: number;
}

export type GuardedLookup = (hostname: string) => Promise<readonly GuardedLookupResult[]>;

export interface GuardedFetchOptions {
  /** 可注入的 DNS 解析（测试用；默认 `node:dns/promises`）。 */
  readonly lookup?: GuardedLookup;
  readonly allowPorts?: readonly number[];
  readonly requireHttps?: boolean;
  readonly maxRedirects?: number;
  readonly timeoutMs?: number;
  /**
   * 豁免 DNS 解析判定（只跳过 DNS 查禁段；userinfo/协议/端口/字面量主机名照常拦）。
   * 只用于签发方（Capy）签名的目标 URL——这类 URL 不是用户可控输入，
   * 代理环境下 DNS 可能解析到禁段（如 198.18.169.x），不豁免会把功能堵死。
   * 用户提供的 URL 绝不设此项。
   */
  readonly skipDnsCheck?: boolean;
  /** 被拒时回调（用于日志，只带原因，不带完整 URL）。 */
  readonly onBlock?: (reason: string) => void;
}

const DEFAULT_PORTS: readonly number[] = [80, 443];
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_REDIRECTS = 3;
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function defaultLookup(hostname: string): Promise<readonly GuardedLookupResult[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function toUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return new URL(input.toString());
  if (typeof input === "string") return new URL(input);
  return new URL(input.url);
}

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!signal) return timeout;
  const ctor = AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal };
  if (typeof ctor.any === "function") return ctor.any([signal, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal.aborted || timeout.aborted) {
    abort();
    return controller.signal;
  }
  signal.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // 取消失败不影响重定向逻辑
  }
}

function dropCredentials(init: RequestInit): RequestInit {
  if (!init.headers) return init;
  const headers = new Headers(init.headers);
  headers.delete("authorization");
  headers.delete("cookie");
  headers.delete("proxy-authorization");
  return { ...init, headers };
}

/**
 * 生成一个「带 SSRF 防护」的 fetch。返回对象的签名与 `fetch` 一致，
 * 因此可以直接传给 `collectAttachments` / `CapyPublicClient`。
 */
export function createGuardedFetch(baseFetch: typeof fetch, options: GuardedFetchOptions = {}): typeof fetch {
  const allowPorts = options.allowPorts ?? DEFAULT_PORTS;
  const requireHttps = options.requireHttps === true;
  const maxRedirects = Math.max(0, Math.trunc(options.maxRedirects ?? DEFAULT_MAX_REDIRECTS));
  const timeoutMs = Math.max(1, Math.trunc(options.timeoutMs ?? DEFAULT_TIMEOUT_MS));
  const lookup: GuardedLookup = options.lookup ?? defaultLookup;

  const blocked = (reason: string): CapyError => {
    options.onBlock?.(reason);
    return new CapyError("invalid_request", `目标地址被拒绝：${reason}`, { detail: reason });
  };

  const assertAllowed = async (url: URL): Promise<void> => {
    if (url.username || url.password) throw blocked("URL 不允许携带 userinfo");
    if (url.protocol !== "http:" && url.protocol !== "https:") throw blocked(`不支持的协议 ${url.protocol}`);
    if (requireHttps && url.protocol !== "https:") throw blocked("只允许 https");
    const port = url.port ? Number(url.port) : (url.protocol === "https:" ? 443 : 80);
    if (!allowPorts.includes(port)) throw blocked(`端口 ${port} 不在白名单`);
    const host = url.hostname.replace(/^\[/u, "").replace(/\]$/u, "");
    if (!host) throw blocked("URL 缺少主机名");
    if (isBlockedHostname(host)) throw blocked(`主机 ${host} 指向本机/内网`);
    if (isIpLiteral(host)) return;
    // 签发方 URL 豁免 DNS 判定（见 skipDnsCheck 说明）；字面量主机名已在上面拦过。
    if (options.skipDnsCheck) return;
    const addrs = await lookup(host).catch(() => null);
    if (!addrs || addrs.length === 0) throw blocked(`DNS 无结果：${host}`);
    for (const addr of addrs) {
      if (isBlockedIp(addr.address)) throw blocked(`DNS 解析到内网地址（${addr.address}）`);
    }
  };

  const guarded = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    let current = toUrl(input);
    let remaining = maxRedirects;
    let currentInit: RequestInit = init;
    for (;;) {
      await assertAllowed(current);
      const response = await baseFetch(current.toString(), {
        ...currentInit,
        redirect: "manual",
        signal: combineSignals(init.signal ?? undefined, timeoutMs),
      });
      if (!REDIRECT_STATUS.has(response.status)) return response;
      if (remaining <= 0) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, current);
      await cancelBody(response);
      if (next.host !== current.host) currentInit = dropCredentials(currentInit);
      current = next;
      remaining -= 1;
    }
  };

  return guarded as typeof fetch;
}
