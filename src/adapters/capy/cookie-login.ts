import { CapyError } from "../../domain/errors.ts";
import type { LoginCredential } from "../../ports/login.ts";
import { clientIdOf } from "./browser-login.ts";

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
 * 任一框是 Cookie-Editor JSON 导出时，它是自包含的（同时含 __client 与 __session），
 * 直接用它，忽略另一框。只填了一框时原样返回。
 */
export function combineCookieInputs(clerkCookie: string, sessionCookie: string): string {
  const first = clerkCookie.trim();
  const second = sessionCookie.trim();
  if (!first) return second;
  if (!second) return first;
  if (first.startsWith("[") || first.startsWith("{")) return first;
  if (second.startsWith("[") || second.startsWith("{")) return second;
  if (!second.includes("=")) {
    const isJwt = second.startsWith("eyJ") || second.split(".").length === 3;
    return isJwt ? `${first}; __session=${second}` : `${first}; sessionId=${second}`;
  }
  return `${first}; ${second}`;
}

export function cookieCredentialOf(input: string): LoginCredential {
  const cookies = pairsOf(input);
  const clientEntry = [...cookies].find(([name]) => name === "__client");
  const clientJwt = clientEntry?.[1] ?? "";
  if (!clientJwt) throw new CapyError("sign_in_required", "Cookie 缺少 __client；请在第一框粘贴发往 clerk.capy.ai 的请求的完整 cookie 请求头（F12 → Network（网络）→ clerk.capy.ai 请求 → Request Headers（请求标头））");
  jwtPayload(clientJwt, "__client");
  const clientId = clientIdOf(clientJwt).trim();
  if (!clientId) throw new CapyError("sign_in_required", "__client 缺少 Clerk client id");
  const active = [...cookies].find(([name]) => name === "clerk_active_context")?.[1] ?? "";
  let sessionId = active.split(":", 1)[0]?.trim() ?? "";
  for (const sessionJwt of [cookies.get("__session"), ...[...cookies].filter(([name]) => /^__session_[A-Za-z0-9_]+$/u.test(name)).map(([, value]) => value)]) {
    if (sessionId || !sessionJwt) continue;
    try {
      const session = jwtPayload(sessionJwt, "__session");
      sessionId = typeof session.sid === "string" ? session.sid.trim() : "";
    } catch { /* 允许继续尝试其他明确来源 */ }
  }
  if (!sessionId) sessionId = cookies.get("sessionId")?.trim() ?? "";
  if (!sessionId) throw new CapyError("sign_in_required", "Cookie 缺少会话信息：请在第二框粘贴 __session 的值（或 Clerk session id），或在第一框的 Cookie 串末尾追加 ; sessionId=…");
  return { clientJwt, sessionId, userId: "", clientId, source: "cookie" };
}
