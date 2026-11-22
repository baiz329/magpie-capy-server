import { CapyError } from "../../domain/errors.ts";
import type { LoginCredential } from "../../ports/login.ts";
import { clientIdOf } from "./browser-login.ts";

function looksLikeJson(text: string): boolean {
  return text.startsWith("[") || text.startsWith("{");
}

/** 去重：同名保留第一次出现的（第一框优先）。 */
function dedupe(pairs: Array<readonly [string, string]>): Array<readonly [string, string]> {
  const seen = new Set<string>();
  const out: Array<readonly [string, string]> = [];
  for (const pair of pairs) {
    if (seen.has(pair[0])) continue;
    seen.add(pair[0]);
    out.push(pair);
  }
  return out;
}

function serialize(pairs: readonly (readonly [string, string])[]): string {
  return pairs.map(([name, value]) => `${name}=${value}`).join("; ");
}

/** 非 JSON 的第二框：裸值补名字，header 串直接拆对。 */
function sessionPairsOf(text: string): Array<readonly [string, string]> {
  if (!text.includes("=")) {
    const isJwt = text.startsWith("eyJ") || text.split(".").length === 3;
    return [[isJwt ? "__session" : "sessionId", text]];
  }
  return [...pairsOf(text)];
}

function pairsOf(input: string): Map<string, string> {
  const text = input.trim();
  if (!text) throw new CapyError("invalid_request", "Cookie 输入不能为空");
  let value: unknown = text;
  if (text.startsWith("[") || text.startsWith("{")) {
    try { value = JSON.parse(text); } catch { throw new CapyError("invalid_request", "Cookie JSON 格式无效"); }
  }
  const pairs: Array<[string, string]> = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      if (typeof record.name === "string" && typeof record.value === "string") pairs.push([record.name, record.value]);
    }
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    // 单条 {name, value} 对象特判：不能把它拆成 name=/value= 两对（M-17）。
    if (typeof record.name === "string" && typeof record.value === "string") {
      return new Map([[record.name, record.value]]);
    }
    if (typeof record.cookie === "string") return pairsOf(record.cookie);
    if (Array.isArray(record.cookies)) {
      for (const item of record.cookies) {
        if (!item || typeof item !== "object") continue;
        const cookie = item as Record<string, unknown>;
        if (typeof cookie.name === "string" && typeof cookie.value === "string") pairs.push([cookie.name, cookie.value]);
      }
    }
    for (const [name, val] of Object.entries(record)) if (typeof val === "string") pairs.push([name, val]);
  } else {
    for (const part of text.replace(/^cookie\s*:\s*/iu, "").split(";")) {
      const at = part.indexOf("=");
      if (at > 0) pairs.push([part.slice(0, at).trim(), part.slice(at + 1).trim()]);
    }
  }
  return new Map(pairs.filter(([name, val]) => /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) && val));
}

function jwtPayload(token: string, label: string): Record<string, unknown> {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) throw new CapyError("sign_in_required", `Cookie 的 ${label} 不是有效 JWT`);
  try {
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("payload");
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new CapyError("sign_in_required", `Cookie 的 ${label} JWT payload 无法解析`, { cause: error });
  }
}

/**
 * 把两框粘贴的内容拼成一串 Cookie。
 * 第一框是发往 clerk.capy.ai 的完整 cookie 请求头；第二框通常是 __session 的裸值
 * （JWT）或 Clerk session id，需要补上名字才能拼进 Cookie 串。
 * 任一框是 Cookie-Editor JSON 导出时，两框合并去重（同名第一框优先）；
 * 第一框自包含也不再整框丢弃第二框——第二框独有的 cookie 得以保留（M-17）。
 * 只填了一框时原样返回。
 */
export function combineCookieInputs(clerkCookie: string, sessionCookie: string): string {
  const first = clerkCookie.trim();
  const second = sessionCookie.trim();
  if (!first) return second;
  if (!second) return first;
  if (looksLikeJson(first) || looksLikeJson(second)) {
    const firstPairs = looksLikeJson(first) ? [...pairsOf(first)] : sessionPairsOf(first);
    const secondPairs = looksLikeJson(second) ? [...pairsOf(second)] : sessionPairsOf(second);
    return serialize(dedupe([...firstPairs, ...secondPairs]));
  }
  if (!second.includes("=")) {
    const isJwt = second.startsWith("eyJ") || second.split(".").length === 3;
    return isJwt ? `${first}; __session=${second}` : `${first}; sessionId=${second}`;
  }
  return `${first}; ${second}`;
}

export function cookieCredentialOf(input: string): LoginCredential {
  const cookies = new Map(dedupe([...pairsOf(input)]));
  const clientEntry = [...cookies].find(([name]) => name === "__client");
  const clientJwt = clientEntry?.[1] ?? "";
  if (!clientJwt) throw new CapyError("sign_in_required", "Cookie 缺少 __client；请在第一框粘贴发往 clerk.capy.ai 的请求的完整 cookie 请求头（F12 → Network（网络）→ clerk.capy.ai 请求 → Request Headers（请求标头））");
  jwtPayload(clientJwt, "__client");
  // clientId 没有就留空，不再硬失败（M-07）。
  const clientId = clientIdOf(clientJwt).trim();
  const active = [...cookies].find(([name]) => name === "clerk_active_context")?.[1] ?? "";
  let sessionId = active.split(":", 1)[0]?.trim() ?? "";
  // 不透明 __session（根本不是 JWT）留作回退候选；能解析的 JWT 但没有 sid 时仍拒绝。
  let opaqueSession = "";
  for (const sessionJwt of [cookies.get("__session"), ...[...cookies].filter(([name]) => /^__session_[A-Za-z0-9_]+$/u.test(name)).map(([, value]) => value)]) {
    if (sessionId || !sessionJwt) continue;
    if (sessionJwt.split(".").length !== 3) {
      opaqueSession ||= sessionJwt;
      continue;
    }
    try {
      const session = jwtPayload(sessionJwt, "__session");
      sessionId = typeof session.sid === "string" ? session.sid.trim() : "";
    } catch { /* 允许继续尝试其他明确来源 */ }
  }
  if (!sessionId) sessionId = cookies.get("sessionId")?.trim() ?? "";
  // 回退：__session 是不透明 token 时直接用作 session id（Clerk 下游会校验）；
  // 实在没有其它会话来源才走这条路。
  if (!sessionId && opaqueSession) sessionId = opaqueSession;
  if (!sessionId) throw new CapyError("sign_in_required", "Cookie 缺少会话信息：请在第二框粘贴 __session 的值（或 Clerk session id），或在第一框的 Cookie 串末尾追加 ; sessionId=…");
  return { clientJwt, sessionId, userId: "", clientId, source: "cookie" };
}
