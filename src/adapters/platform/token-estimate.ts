import type { ChatMessage } from "../../domain/chat.ts";

/**
 * 估算文本的 token 数。注意这是近似值，不是精确计数，也不是计费依据。
 * 启发式：CJK 字符约 1 token/字；其余字符约 1 token/4 字符。
 * 只用于上游不返回用量时，给 Magpie 一个参考值，避免网关永远显示 0。
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (isCjk(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 4);
}

function isCjk(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return (
    (code >= 0x2e80 && code <= 0x9fff) || // CJK 部首、汉字、假名
    (code >= 0xf900 && code <= 0xfaff) || // CJK 兼容汉字
    (code >= 0x20000 && code <= 0x2fa1f) || // CJK 扩展
    (code >= 0x3040 && code <= 0x30ff) || // 平假名、片假名
    (code >= 0xac00 && code <= 0xd7af) // 谚文
  );
}

/** 从 OpenAI 请求消息里抽文本并估算输入 token 数。图片/附件只按占位符计入。 */
export function estimateTokensOfMessages(messages: readonly ChatMessage[]): number {
  let text = "";
  for (const message of messages) text += messageText(message);
  return estimateTokens(text);
}

function messageText(message: ChatMessage): string {
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else {
    for (const part of content) {
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        text += part.text;
      } else if (part.type === "image_url" || part.type === "input_image" || part.type === "image") {
        const name = "name" in part && typeof part.name === "string" ? part.name : "image";
        text += `[图片: ${name}]`;
      } else {
        const name = "name" in part && typeof part.name === "string" ? part.name : "file";
        text += `[附件: ${name}]`;
      }
    }
  }
  for (const call of message.toolCalls ?? []) text += `${call.name}${call.arguments}`;
  return text;
}
