import type { LogFields } from "../ports/platform.ts";

/**
 * 纯字符串脱敏（H-04 / P3-04）。
 *
 * 每条规则只处理"值"，不改写字段名本身，因此日志仍能看出是哪一类凭据被脱敏。
 * 顺序有意义：先打掉整段凭据（client/cookie），再处理独立前缀（sess_/sk-/ghp_）。
 */
const PATTERNS: readonly [RegExp, string][] = [
  [/capydc_[A-Za-z0-9_-]{6,}/gu, "capydc_…"],
  [/capyd_[A-Za-z0-9_-]{6,}/gu, "capyd_…"],
  [/capy_[A-Za-z0-9_-]{6,}/gu, "capy_…"],
  [/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, "$1[redacted]"],
  // 裸 `Bearer <token>`（上游 message 回显里常见，不带 `authorization` 前缀）
  [/\b(bearer\s+)[A-Za-z0-9._~+\/=-]{8,}/giu, "$1[redacted]"],
  // `Authorization: Basic xxx` / Digest / Negotiate / NTLM
  [/(authorization\s*[:=]\s*)(?:basic|digest|negotiate|ntlm)\s+[^\s"',}]+/giu, "$1[redacted]"],
  // JSON 键值对形态：`{"sid":"ABC"}` → `{"sid":"[redacted]"}`
  [
    /("(?:sid|sessionId|session_id|session|token|id_token|access_token|refresh_token|api_key|apikey|secret|password)"\s*:\s*)"[^"]*"/giu,
    '$1"[redacted]"',
  ],
  [/(cookie\s*[:=]\s*)[^"',}\n]+/giu, "$1[redacted]"],
  [/__client=[^;,\s"']+/gu, "__client=[redacted]"],
  [/__session(?:_[A-Za-z0-9]+)?=[^;,\s"']+/gu, "__session=[redacted]"],
  [/\bsess_[A-Za-z0-9_-]{6,}/giu, "sess_…"],
  [/\bsk-[A-Za-z0-9_-]{8,}/gu, "sk-…"],
  [/\bghp_[A-Za-z0-9]{10,}/gu, "ghp_…"],
  [/\bAIza[A-Za-z0-9_-]{10,}/gu, "AIza…"],
  [/\bgh[pousr]_[A-Za-z0-9]{10,}/gu, "gh*_…"],
  // URL userinfo：`scheme://user:pass@host` → `scheme://[redacted]@host`
  [/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]*@/giu, "$1[redacted]@"],
  [
    /(^|[?&;,{\[\s"])((?:sid|sessionId|session_id|session|session_token|access_token|refresh_token|id_token|token|api_key|apikey|secret|password)\s*[:=]\s*)[^&;,\s"'}#]+/giu,
    "$1$2[redacted]",
  ],
  // 预签名 URL 参数：签名本身就是凭据，日志里只留参数名（P3-04）。
  [
    /([?&](?:X-Amz-Signature|X-Amz-Credential|X-Amz-Security-Token|Signature|AWSAccessKeyId)=)[^&\s"']+/giu,
    "$1[redacted]",
  ],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "[jwt]"],
];

const SECRET_KEY = /(?:^|[-_.])(?:password|passphrase|secret|token|credential|credentials|authorization|cookie|session|api-?key|private-?key|signature|bearer|jwt|client-?secret)(?:$|[-_.])/u;

const MAX_LENGTH = 512;

/** 长值截断，避免一条日志被打成几 MB。 */
export function truncate(value: string): string {
  const text = String(value ?? "");
  return text.length > MAX_LENGTH ? `${text.slice(0, MAX_LENGTH)}…[len=${text.length}]` : text;
}

/**
 * 键名是否像凭据：`clerkCookie`、`__session`、`api_key`、`accessToken` 都算。
 * 只用于"整字段置换成 [redacted]"，宁可多脱敏也不要把 secret 写进日志。
 */
export function isSecretKey(key: string): boolean {
  const normalized = String(key ?? "")
    .replace(/([a-z0-9])([A-Z])/gu, "$1-$2")
    .toLowerCase();
  if (!normalized) return false;
  return SECRET_KEY.test(normalized);
}

/** 把一段文本里的凭据形式替换掉。 */
export function redact(value: string): string {
  let text = String(value);
  if (!text) return text;
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

const MAX_DEPTH = 4;

/** 递归脱敏：凭据键整字段置换，其它叶子走 `redact` + 截断。 */
function redactValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return truncate(redact(value));
  if (typeof value === "bigint") return truncate(redact(value.toString()));
  if (value instanceof Error) return truncate(redact(value.message));
  if (depth >= MAX_DEPTH) return "[depth-limit]";
  if (Array.isArray(value)) return value.map((item) => redactValue(item, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretKey(key) ? "[redacted]" : redactValue(item, depth + 1);
    }
    return out;
  }
  return truncate(redact(String(value)));
}

/**
 * 递归脱敏：允许任意嵌套值（`LogFields` 只描述叶子，日志调用方常传对象/数组）。
 * 返回结构保持原样（嵌套对象/数组不压成字符串），调用方再序列化。
 */
export function redactFields(
  fields: LogFields | Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!fields) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = isSecretKey(key) ? "[redacted]" : redactValue(value, 0);
  }
  return out;
}
