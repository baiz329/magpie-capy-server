import type { LogFields } from "../ports/platform.ts";

const PATTERNS: readonly [RegExp, string][] = [
  [/capyd_[A-Za-z0-9_-]{6,}/gu, "capyd_…"],
  [/capy_[A-Za-z0-9_-]{6,}/gu, "capy_…"],
  [/(authorization\s*[:=]\s*bearer\s+)[^\s"',}]+/giu, "$1[redacted]"],
  [/(cookie\s*[:=]\s*)[^"',}\n]+/giu, "$1[redacted]"],
  [/__client=[^;,\s"']+/gu, "__client=[redacted]"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, "[jwt]"],
];

export function redact(value: string): string {
  let text = String(value);
  for (const [pattern, replacement] of PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

export function redactFields(fields: LogFields | undefined): LogFields | undefined {
  if (!fields) return undefined;
  const out: Record<string, string | number | boolean | null | undefined> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = typeof value === "string" ? redact(value) : value;
  }
  return out;
}
