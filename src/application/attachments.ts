import type { ChatMessage, ContentPart, ImagePart, FilePart } from "../domain/chat.ts";
import { CapyError } from "../domain/errors.ts";
import type { UploadCandidate } from "../ports/capy-public.ts";

/** 公开 OpenAPI：单文件 250 MB；没有数量/总大小上限。 */
const MAX_ATTACHMENT_BYTES = 262_144_000;

const DATA_URL = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/u;
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;
const PRIVATE_HOST = /^(?:localhost|0\.0\.0\.0|127\.|10\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|169\.254\.|::1$|\[::1\]$|\[::\]$|fe80:|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:|.*\.local$)/iu;

function mediaTypeOf(value: unknown, fallback = "application/octet-stream"): string {
  const text = String(value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(text) ? text : fallback;
}

function safeName(name: unknown, mediaType: string, index: number): string {
  const base = String(name ?? "").split(/[\\/]/u).pop()?.replace(/[\u0000-\u001f<>:"|?*]/gu, "").trim();
  if (base) return base.slice(0, 200);
  const ext = mediaType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "bin";
  return `attachment-${index + 1}.${ext}`;
}

function assertSize(bytes: Uint8Array, name: string): void {
  if (bytes.length > MAX_ATTACHMENT_BYTES) {
    throw new CapyError("invalid_request", `附件 ${name} 超过 250 MB（单文件上限）`);
  }
}

function decodeDataUrl(value: string, fallbackType: string): { mediaType: string; bytes: Uint8Array } | null {
  const match = DATA_URL.exec(value);
  if (!match) return null;
  const mediaType = mediaTypeOf(match[1], fallbackType);
  const bytes = match[2]
    ? Buffer.from(match[3] ?? "", "base64")
    : Buffer.from(decodeURIComponent(match[3] ?? ""), "utf8");
  return { mediaType, bytes };
}

function assertPublicUrl(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch {
    throw new CapyError("invalid_request", "附件 URL 不是合法地址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CapyError("invalid_request", "附件只支持 http/https URL 或 data URL");
  }
  if (PRIVATE_HOST.test(url.hostname)) {
    throw new CapyError("invalid_request", "附件 URL 指向本机/内网地址，已拒绝（SSRF）");
  }
  return url;
}

async function readRemote(
  fetchImpl: typeof fetch,
  raw: string,
  name: string,
  signal?: AbortSignal,
): Promise<{ name: string; mediaType: string; bytes: Uint8Array }> {
  const url = assertPublicUrl(raw);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "image/*,application/pdf,*/*;q=0.8" },
      redirect: "follow",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    throw new CapyError("upstream_unavailable", `下载远程附件失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new CapyError("invalid_request", `下载远程附件失败（HTTP ${response.status}）`);
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > MAX_ATTACHMENT_BYTES) throw new CapyError("invalid_request", "远程附件超过 250 MB");
  const bytes = new Uint8Array(await response.arrayBuffer());
  assertSize(bytes, name);
  return {
    name: safeName(name || url.pathname.split("/").pop(), mediaTypeOf(response.headers.get("content-type")), 0),
    mediaType: mediaTypeOf(response.headers.get("content-type")),
    bytes,
  };
}

async function resolvePart(
  fetchImpl: typeof fetch,
  part: ImagePart | FilePart,
  index: number,
  signal?: AbortSignal,
): Promise<UploadCandidate> {
  const fallbackType = part.type === "image_url" || part.type === "input_image" || part.type === "image"
    ? "image/png"
    : (part.mediaType ?? "application/octet-stream");
  const isImagePart = part.type === "image_url" || part.type === "input_image" || part.type === "image";
  const source = isImagePart
    ? part.url
    : ("data" in part && typeof part.data === "string" ? part.data : part.url ?? "");
  const name = safeName(part.name, fallbackType, index);
  if (!source) throw new CapyError("invalid_request", "附件缺少内容（data URL / http(s) URL / base64）");

  if (source.startsWith("data:")) {
    const decoded = decodeDataUrl(source, fallbackType);
    if (!decoded) throw new CapyError("invalid_request", "附件 data URL 无法解析");
    assertSize(decoded.bytes, name);
    return { name, mediaType: decoded.mediaType, bytes: decoded.bytes };
  }
  if (/^https?:\/\//iu.test(source)) {
    return readRemote(fetchImpl, source, name, signal);
  }
  const text = source.trim();
  if (BARE_BASE64.test(text) && text.length % 4 === 0) {
    const bytes = Buffer.from(text, "base64");
    assertSize(bytes, name);
    return { name, mediaType: fallbackType, bytes };
  }
  throw new CapyError("invalid_request", "附件内容不是 data URL / http(s) URL / base64");
}

/**
 * OpenAI content parts → 文本 messages + 待上传附件。
 * Capy 文件通道接受图片/PDF；附件 part 换成可读标记，正文交给 buildPrompt。
 */
export async function collectAttachments(
  messages: readonly ChatMessage[],
  options: { readonly fetchImpl: typeof fetch; readonly signal?: AbortSignal },
): Promise<{ messages: ChatMessage[]; attachments: UploadCandidate[] }> {
  const cleaned: ChatMessage[] = [];
  const attachments: UploadCandidate[] = [];
  for (const message of messages) {
    if (typeof message.content === "string") {
      cleaned.push(message);
      continue;
    }
    const parts: ContentPart[] = [];
    for (const part of message.content) {
      if (part.type === "text" || part.type === "input_text" || part.type === "output_text") {
        parts.push(part);
        continue;
      }
      if (part.type === "image_url" || part.type === "input_image" || part.type === "image"
        || part.type === "file" || part.type === "input_file") {
        const attachment = await resolvePart(
          options.fetchImpl,
          part as ImagePart | FilePart,
          attachments.length,
          options.signal,
        );
        attachments.push(attachment);
        const image = /^image\//u.test(attachment.mediaType);
        parts.push({
          type: "text",
          text: `${image ? "[图片" : "[附件"}: ${attachment.name}]`,
        });
        continue;
      }
    }
    cleaned.push({ ...message, content: parts });
  }
  return { messages: cleaned, attachments };
}
