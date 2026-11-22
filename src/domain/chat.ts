import { CapyError } from "./errors.ts";

export type ChatRole = "system" | "developer" | "user" | "assistant" | "tool";

export interface TextPart {
  readonly type: "text" | "input_text" | "output_text";
  readonly text: string;
}

export interface ImagePart {
  readonly type: "image_url" | "input_image" | "image";
  readonly url: string;
  readonly name?: string;
  readonly mediaType?: string;
}

export interface FilePart {
  readonly type: "file" | "input_file";
  readonly name?: string;
  readonly mediaType?: string;
  readonly data?: string;
  readonly url?: string;
}

export type ContentPart = TextPart | ImagePart | FilePart;

export interface ToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface ChatMessage {
  readonly role: ChatRole;
  readonly content: string | readonly ContentPart[];
  readonly name?: string;
  readonly toolCallId?: string;
  readonly toolCalls?: readonly ToolCall[];
}

export interface ToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description?: string;
    readonly parameters?: unknown;
  };
}

export interface ChatRequest {
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly stream: boolean;
  readonly reasoningEffort?: string;
  readonly tools?: readonly ToolDefinition[];
  readonly toolChoice?: unknown;
}

export interface ChatDeltaEvent {
  readonly type: "delta";
  readonly text: string;
}

export interface ChatFinalEvent {
  readonly type: "final";
  readonly text: string;
}

export interface ChatErrorEvent {
  readonly type: "error";
  readonly error: CapyError;
}

export interface ChatDoneEvent {
  readonly type: "done";
}

export type ChatEvent =
  | ChatDeltaEvent
  | ChatFinalEvent
  | ChatErrorEvent
  | ChatDoneEvent;

// 本地提示词字符上限（M-02）：超过就明确拒绝，不静默截断、不谎称服务端会处理。
// 上限只是防止无界历史把请求拖垮的护栏，不是 Capy 的上游契约；
// 每轮都是新建 jam、全量历史拼单条消息，O(n²) 成本与 jam 堆积仍在（见 README 已知限制）。
export const PROMPT_CHAR_LIMIT = 1_000_000;

function textOfContent(content: string | readonly ContentPart[]): string {
  if (typeof content === "string") return content;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
      parts.push(part.text);
    } else if (part.type === "image_url" || part.type === "input_image" || part.type === "image") {
      parts.push(`[图片: ${part.name ?? "image"}]`);
    } else {
      const name = "name" in part && typeof part.name === "string" ? part.name : "file";
      parts.push(`[附件: ${name}]`);
    }
  }
  return parts.join("\n");
}

interface Turn {
  role: "user" | "assistant" | "tool";
  text: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: readonly ToolCall[];
}

export interface BuildPromptOptions {
  /** 由 ToolBridge 生成的工具说明；为空则不加。 */
  readonly toolInstruction?: string;
  /**
   * 分隔符随机 nonce。需要打标签时必须提供；
   * 生产路径由 `application/chat.ts` 用 `ids.uuid()` 生成。
   */
  readonly nonce?: string;
}

/** 工具名白名单：不合规的名字不渲染成标签（防止伪造分隔符/注入换行）。 */
const SAFE_TOOL_NAME = /^[A-Za-z0-9_.:-]{1,64}$/u;

/**
 * OpenAI messages → Capy 单条 message。
 * 单条 user 且无 system/工具说明时原样发送；其余用带随机 nonce 的无闭合标签分隔。
 *
 * 超过 PROMPT_CHAR_LIMIT 时明确拒绝（invalid_request），不静默截断。
 */
export function buildPrompt(messages: readonly ChatMessage[], options: BuildPromptOptions = {}): string {
  if (messages.length === 0) throw promptError("messages 为空");

  const systems: string[] = [];
  const turns: Turn[] = [];
  for (const message of messages) {
    const text = textOfContent(message.content).trim();
    if (message.role === "system" || message.role === "developer") {
      if (text) systems.push(text);
      continue;
    }
    if (message.role === "user") {
      if (text) turns.push({ role: "user", text });
      continue;
    }
    if (message.role === "assistant") {
      // TOOL-CALLS 块保留 id/name/arguments 全量 JSON（M-13）；
      // 不合规的名字不进标签与后缀，也不进 JSON（防伪造分隔符/注入换行）。
      const calls = (message.toolCalls ?? []).filter((call) => SAFE_TOOL_NAME.test(call.name));
      const suffix = calls.length > 0 ? ` [调用工具: ${calls.map((call) => call.name).join(", ")}]` : "";
      if (text || suffix) {
        turns.push({
          role: "assistant",
          text: `${text}${suffix}`.trim(),
          ...(calls.length > 0 ? { toolCalls: calls } : {}),
        });
      }
      continue;
    }
    if (message.role === "tool") {
      turns.push({
        role: "tool",
        name: message.name ?? "tool",
        ...(message.toolCallId ? { toolCallId: message.toolCallId } : {}),
        text: text || "(无输出)",
      });
    }
  }

  if (turns.length === 0) throw promptError("messages 里没有 user/assistant 内容");

  const toolInstruction = options.toolInstruction ?? "";
  const trimmedInstruction = toolInstruction.trim();

  // 保持旧行为：单条 user、无 system、无工具说明 → 原样返回纯文本。
  if (turns.length === 1 && turns[0]?.role === "user" && systems.length === 0 && !trimmedInstruction) {
    if (turns[0].text.length > PROMPT_CHAR_LIMIT) {
      throw promptError(`提示词超过 ${PROMPT_CHAR_LIMIT} 字符上限，请缩短对话历史后重试`);
    }
    return turns[0].text;
  }

  const nonce = String(options.nonce ?? "").trim();
  if (!nonce) throw promptError("缺少 prompt nonce");
  const tag = (label: string) => `<<<CAPY:${nonce}:${label}>>>`;

  const blocks: string[] = [];
  if (systems.length > 0) {
    blocks.push(`${tag("SYSTEM")}\n${escapeForPrompt(systems.join("\n\n"))}`);
  }
  blocks.push(tag("CONVERSATION"));
  for (const turn of turns) {
    if (turn.role === "tool") {
      const name = SAFE_TOOL_NAME.test(turn.name ?? "") ? String(turn.name) : "tool";
      const callId = turn.toolCallId && SAFE_TOOL_NAME.test(turn.toolCallId)
        ? ` call_id=${turn.toolCallId}`
        : "";
      blocks.push(`${tag(`TOOL name=${name}${callId}`)}\n${escapeForPrompt(turn.text)}`);
      continue;
    }
    blocks.push(`${tag(turn.role === "assistant" ? "ASSISTANT" : "USER")}\n${escapeForPrompt(turn.text)}`);
    if (turn.role === "assistant" && turn.toolCalls && turn.toolCalls.length > 0) {
      blocks.push(`${tag("TOOL-CALLS")}\n${escapeForPrompt(JSON.stringify(
        turn.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      ))}`);
    }
  }
  blocks.push(tag("END-CONVERSATION"));
  const last = turns[turns.length - 1];
  blocks.push(last?.role === "assistant" ? "Continue the last assistant message." : "Reply to the last user message.");
  if (trimmedInstruction) blocks.push(escapeForPrompt(toolInstruction));

  const prompt = blocks.join("\n\n");
  if (prompt.length > PROMPT_CHAR_LIMIT) {
    throw promptError(`提示词超过 ${PROMPT_CHAR_LIMIT} 字符上限，请缩短对话历史后重试`);
  }
  return prompt;
}

/** 削掉可伪造的分隔符前缀；不猜 nonce，只做 O(n) 单遍替换。 */
export function escapeForPrompt(text: string): string {
  return text.replaceAll("<<<CAPY:", "<<<CAPY-ESCAPED:");
}

function promptError(message: string): CapyError {
  return new CapyError("invalid_request", message);
}
