import type { ChatMessage, ContentPart, FilePart } from "../../domain/chat.ts";

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

/** 每张图片按固定 token 估算（M-04 下限估计；分辨率档位做不了，按固定 85 并注明）。 */
export const IMAGE_TOKENS = 85;
/** PDF 粗估：每 100 KB 约 100 token（仅 mediaType 为 PDF 时计）。 */
const PDF_BYTES_PER_CHUNK = 100_000;
const PDF_TOKENS_PER_CHUNK = 100;

/** 从 OpenAI 请求消息里抽文本并估算输入 token 数；图片/PDF 按体积追加下限估计。 */
export function estimateTokensOfMessages(messages: readonly ChatMessage[]): number {
  let tokens = 0;
  for (const message of messages) {
    tokens += estimateTokens(messageText(message));
    for (const part of partsOf(message)) {
      if (isImagePart(part)) tokens += IMAGE_TOKENS;
      else if (isFilePart(part)) tokens += pdfTokens(part);
    }
  }
  return tokens;
}

function partsOf(message: ChatMessage): readonly ContentPart[] {
  return typeof message.content === "string" ? [] : message.content;
}

function isImagePart(part: ContentPart): boolean {
  return part.type === "image_url" || part.type === "input_image" || part.type === "image";
}

function isFilePart(part: ContentPart): part is FilePart {
  return part.type === "file" || part.type === "input_file";
}

/** 文本 + 工具调用；图片/附件单独按体积计价，不重复计入占位符文本。 */
function messageText(message: ChatMessage): string {
  const content = message.content;
  let text = "";
  if (typeof content === "string") {
    text = content;
  } else {
    for (const part of content) {
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        text += part.text;
      }
    }
  }
  for (const call of message.toolCalls ?? []) text += `${call.name}${call.arguments}`;
  return text;
}

/**
 * PDF 体积粗估：只有 mediaType 为 PDF 时才计；只用 base64 data 的长度
 * （* 3/4 还原字节数）估算。只有 URL 时不拿 URL 长度当字节数（M-04），
 * 体积未知按 0（下限估计）。
 */
function pdfTokens(part: FilePart): number {
  const mediaType = String(part.mediaType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/pdf") return 0;
  const data = typeof part.data === "string" ? part.data : "";
  if (!data) return 0;
  const payload = data.startsWith("data:")
    ? (data.split(",", 2)[1] ?? "")
    : data;
  const compact = payload.replace(/\s/gu, "");
  if (!compact) return 0;
  const bytes = Math.floor(compact.length * 3 / 4);
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / PDF_BYTES_PER_CHUNK) * PDF_TOKENS_PER_CHUNK;
}
