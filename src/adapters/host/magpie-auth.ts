import { createHash } from "node:crypto";

import type { AccountSession, LoginSource } from "../../domain/account.ts";
import { CapyError } from "../../domain/errors.ts";

const LOGIN_SOURCES: readonly LoginSource[] = ["local", "browser", "cookie", "refresh"];

/** 显式"取第一个非空字符串"，取代原来永不生效的 `??` 链（M-08）。 */
function firstNonEmpty(...values: readonly unknown[]): string {
  for (const value of values) {
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** source 从 metadata 读回；不是已知来源时回退 refresh（M-08）。 */
function sourceOf(metadata: Record<string, unknown>): LoginSource {
  const raw = typeof metadata.source === "string" ? metadata.source.trim().toLowerCase() : "";
  return (LOGIN_SOURCES as readonly string[]).includes(raw) ? raw as LoginSource : "refresh";
}

/** access token 不适合当账号名时的稳定短标识（不泄漏 token 尾部）。 */
function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 8);
}

interface StoredRefresh {
  readonly clientJwt: string;
  readonly sessionId: string;
  readonly orgId?: string;
  readonly userId?: string;
  readonly clientId?: string;
}

function parseRefresh(value: unknown): StoredRefresh | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const clientJwt = typeof record.clientJwt === "string" ? record.clientJwt : "";
    const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
    if (!clientJwt || !sessionId) return null;
    return {
      clientJwt,
      sessionId,
      ...(typeof record.orgId === "string" && record.orgId ? { orgId: record.orgId } : {}),
      ...(typeof record.userId === "string" && record.userId ? { userId: record.userId } : {}),
      ...(typeof record.clientId === "string" && record.clientId ? { clientId: record.clientId } : {}),
    };
  }
  const text = String(value ?? "").trim();
  if (!text.startsWith("{")) return null;
  try { return parseRefresh(JSON.parse(text)); } catch { return null; }
}

export function sessionOfAuth(auth: unknown): AccountSession {
  const record = auth && typeof auth === "object" && !Array.isArray(auth)
    ? auth as Record<string, unknown>
    : {};
  const access = typeof record.access === "string" ? record.access.trim() : "";
  if (!access) throw new CapyError("sign_in_required", "Capy 未登录，请重新登录");
  const refresh = parseRefresh(record.refresh);
  if (!refresh) throw new CapyError("sign_in_required", "Capy 登录态不完整，请重新登录");
  const metadata = record.metadata && typeof record.metadata === "object" && !Array.isArray(record.metadata)
    ? record.metadata as Record<string, unknown>
    : {};
  const orgId = firstNonEmpty(refresh.orgId, metadata.orgId);
  if (!orgId) throw new CapyError("sign_in_required", "Capy 登录态缺少组织，请重新登录");
  // uid 回退链恢复 record.uid 到末位（M-08：原来 `??` 链里 "" 截断了它）。
  const uid = firstNonEmpty(refresh.userId, metadata.userId, record.uid);
  const accountId = firstNonEmpty(record.accountId) || uid || shortHash(access);
  const apiKeyId = typeof metadata.keyId === "string" ? metadata.keyId : "";
  return {
    accountId,
    uid,
    orgId,
    clientId: firstNonEmpty(refresh.clientId, metadata.clientId),
    accessToken: access,
    clerk: { clientJwt: refresh.clientJwt, sessionId: refresh.sessionId },
    source: sourceOf(metadata),
    ...(typeof metadata.name === "string" && metadata.name ? { displayName: metadata.name } : {}),
    ...(apiKeyId ? { apiKeyId } : {}),
  };
}

export interface AuthRecordOptions {
  /** 覆盖默认的 expires（refresh 只更新过期时间，保留其它字段）。 */
  readonly expires?: number;
}

export function authRecordOf(
  session: AccountSession,
  options: AuthRecordOptions = {},
): Record<string, unknown> {
  return {
    type: "success",
    access: session.accessToken,
    refresh: JSON.stringify({
      v: 1,
      clientJwt: session.clerk.clientJwt,
      sessionId: session.clerk.sessionId,
      orgId: session.orgId,
      userId: session.uid,
      clientId: session.clientId,
    }),
    expires: options.expires ?? Date.now() + 7 * 24 * 3600_000,
    accountId: session.accountId,
    uid: session.uid,
    metadata: {
      name: session.displayName ?? session.accountId,
      userId: session.uid,
      orgId: session.orgId,
      clientId: session.clientId,
      source: session.source,
      ...(session.apiKeyId ? { keyId: session.apiKeyId } : {}),
    },
  };
}
