export const CAPY_ORIGIN = "https://capy.ai";
export const CAPY_FAPI = "https://clerk.capy.ai";
export const CAPY_APP = "https://api.capy.ai/app";
export const CAPY_PUBLIC = "https://api.capy.ai/api/v1";
export const DEVICE_TUNNEL = "wss://device-tunnel-production.cloud.capy.ai/tunnel";
export const CONTRACT_VERSION = 2;
/** 桌面端 App API 的 Origin：Electron 自定义协议，不是 https://capy.ai。 */
export const CAPY_APP_ORIGIN = "capy://app";

import { desktopSecChUa, desktopUserAgent, FALLBACK_DESKTOP_VERSION } from "./client-version.ts";

/**
 * App API 请求头：与真实桌面端一致（2026-11-21 内部取证，未随仓库分发）。
 * 桌面端不发 referer；origin 是 capy://app；sec-fetch-site 是 cross-site。
 * 有意不发的：accept-encoding（fetch 运行时自动协商/解压）、
 * b3/traceparent（桌面端观测 SDK 的逐请求追踪 id，不是固定值）。
 */
/** x-capy-client-features 基线：所有 App 请求走同一处拼装（P3-12）。 */
export const CAPY_CLIENT_FEATURES_BASE = "message-edit,visual";

/** 免费广告模型在基线后追加 ads-models 能力位。 */
export function clientFeatures(ads: boolean): string {
  return ads ? `${CAPY_CLIENT_FEATURES_BASE},ads-models` : CAPY_CLIENT_FEATURES_BASE;
}

function appHeaders(jwt: string, extra: Record<string, string> = {}, userAgent: string = desktopUserAgent(FALLBACK_DESKTOP_VERSION)): Record<string, string> {
  return {
    authorization: `Bearer ${jwt}`,
    accept: "*/*",
    "accept-language": "en-US",
    "content-type": "application/json",
    origin: CAPY_APP_ORIGIN,
    priority: "u=1, i",
    "sec-ch-ua": desktopSecChUa(),
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": "\"Windows\"",
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "cross-site",
    "user-agent": userAgent,
    "x-capy-client-surface": "desktop",
    "x-capy-client-features": CAPY_CLIENT_FEATURES_BASE,
    "x-capy-client-timezone": timezone(),
    ...extra,
  };
}

export function clientHeaders(jwt: string, clientId: string, extra: Record<string, string> = {}, userAgent: string = desktopUserAgent(FALLBACK_DESKTOP_VERSION)): Record<string, string> {
  return appHeaders(jwt, {
    ...(clientId ? { "x-capy-client-id": clientId } : {}),
    ...extra,
  }, userAgent);
}

export function publicHeaders(apiKey: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${apiKey}`, accept: "application/json", ...extra };
}

function timezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; } catch { return "UTC"; }
}
