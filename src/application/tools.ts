import type { ToolDefinition } from "../domain/chat.ts";
import type { ToolBridgePort, ToolParseResult } from "../ports/tool-bridge.ts";

const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu;

function functionOf(tool: ToolDefinition): { name: string; description: string; parameters: unknown } | null {
  const name = String(tool.function.name ?? "").trim();
  if (!name) return null;
  return {
    name,
    description: String(tool.function.description ?? "").trim(),
    parameters: tool.function.parameters ?? { type: "object", properties: {} },
  };
}

function forcedName(toolChoice: unknown): string {
  if (!toolChoice || typeof toolChoice !== "object") return "";
  const value = toolChoice as { function?: { name?: unknown }; name?: unknown };
  return typeof value.function?.name === "string"
    ? value.function.name
    : typeof value.name === "string"
      ? value.name
      : "";
}

export class PromptToolBridge implements ToolBridgePort {
  instruction(tools: readonly ToolDefinition[], toolChoice: unknown): string {
    // tool_choice:"none" 时完全不注入工具说明，入口也不解析（H-12）。
    if (toolChoice === "none") return "";
    const defs = tools.map(functionOf).filter((item): item is NonNullable<typeof item> => Boolean(item));
    if (defs.length === 0) return "";
    const forced = forcedName(toolChoice);
    const required = forced || toolChoice === "required";
    const lines = [
      "# Tools",
      "You can call these tools when the user's request needs them:",
      JSON.stringify(defs, null, 2),
      "",
      "To call a tool, reply with exactly one JSON object and nothing else:",
      "{\"tool_calls\":[{\"name\":\"<tool_name>\",\"arguments\":{}}]}",
      "Do not wrap the JSON in a code fence. Do not add text before or after it.",
      "If no tool is needed, answer normally in text.",
    ];
    if (forced) lines.push(`You must call the tool "${forced}" now.`);
    else if (required) lines.push("You must call at least one tool now.");
    return lines.join("\n");
  }

  parse(text: string, allowedNames: readonly string[]): ToolParseResult | null {
    return parseToolCalls(text, allowedNames);
  }
}

function normalizeArguments(value: unknown): string {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text) return "{}";
    try {
      return JSON.stringify(JSON.parse(text) ?? {});
    } catch {
      return text;
    }
  }
  if (value === undefined || value === null) return "{}";
  try {
    return JSON.stringify(value);
  } catch {
    return "{}";
  }
}

function callsFromArray(raw: readonly unknown[], allowed: ReadonlySet<string>): ToolParseResult["calls"] | null {
  const calls: { name: string; arguments: string }[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as { function?: unknown; name?: unknown; arguments?: unknown };
    const fn = record.function && typeof record.function === "object" && !Array.isArray(record.function)
      ? record.function as { name?: unknown; arguments?: unknown }
      : record;
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!name) continue;
    // 名字不在本次白名单 → 整次解析失败（不部分接受）。
    if (!allowed.has(name)) return null;
    calls.push({ name, arguments: normalizeArguments(fn.arguments) });
  }
  return calls.length > 0 ? calls : null;
}

/** `{"tool_calls":[...]}` 信封。 */
function envelopeCalls(value: unknown, allowed: ReadonlySet<string>): ToolParseResult["calls"] | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.tool_calls)) return null;
  return callsFromArray(record.tool_calls, allowed);
}

/**
 * 严格工具调用解析（H-12/M-13）。只接受两条路径：
 *  - D1：整段（可被一层 code fence 包住）就是 `{"tool_calls":[...]}` 信封；
 *  - D2：全文恰好一个顶层对象，且它是 `{"tool_calls":[...]}` 信封。
 * 其它一律 null；`calls` 键、单体 `{name, arguments}`、散文里的单体都不接受。
 * 白名单为空时直接 null。单次 O(n) 扫描。
 */
export function parseToolCalls(text: string, allowedNames: readonly string[]): ToolParseResult | null {
  const allowed = new Set(allowedNames.map((name) => String(name).trim()).filter(Boolean));
  if (allowed.size === 0) return null;
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;

  // D1：整段 JSON（允许一层 code fence）。
  const direct = tryJson(stripOneFence(trimmed));
  if (direct !== undefined) {
    const calls = envelopeCalls(direct, allowed);
    return calls ? { calls } : null;
  }

  // D2：全文恰好一个顶层对象，且必须是 tool_calls 信封。
  const objects = topLevelObjects(trimmed);
  if (objects.length !== 1) return null;
  const parsed = tryJson(objects[0] ?? "");
  if (parsed === undefined) return null;
  const calls = envelopeCalls(parsed, allowed);
  return calls ? { calls } : null;
}

function stripOneFence(text: string): string {
  return FENCE.exec(text)?.[1]?.trim() ?? text;
}

/** `undefined` 表示"不是合法 JSON"；其它值是合法解析结果。 */
function tryJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    return undefined;
  }
}

/**
 * 单次线性扫描，返回全文的**顶层** balanced object 片段。
 * 发现第 2 个就提前返回（D2 要求恰好一个）。
 */
function topLevelObjects(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") {
      if (depth === 0) start = i;
      depth += 1;
      continue;
    }
    if (ch === "}") {
      if (depth === 0) continue;
      depth -= 1;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
        if (out.length > 1) return out;
      }
    }
  }
  return out;
}
