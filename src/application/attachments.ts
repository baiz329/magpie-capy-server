import type { ChatMessage, ContentPart, ImagePart, FilePart } from "../domain/chat.ts";
import { CapyError } from "../domain/errors.ts";
import { isBlockedHostname } from "../domain/net.ts";
import type { UploadCandidate } from "../ports/capy-public.ts";

/**
 * 附件策略上限（H-01）。
 *
 * `maxFiles` / `maxTotalBytes` 是**插件策略**，不是 Capy 的上游契约：`collectAttachments`
 * 会遍历全部历史 messages，多轮图片对话会累积附件，所以上限必须留出余量
 * （32 个 / 128 MiB）。
 * `maxFileBytes` 是上游契约（单文件 250 MB），但仍受总预算约束。
 */
export interface AttachmentLimits {
  readonly maxFiles: number;
  readonly maxTotalBytes: number;
  readonly maxFileBytes: number;
}

export const ATTACHMENT_LIMITS: AttachmentLimits = {
  maxFiles: 32,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFileBytes: 262_144_000,
};

export interface CollectAttachmentsOptions {
  /** 常规 fetch（Capy API 流量，可走代理）。 */
  readonly fetchImpl: typeof fetch;
  /**
   * 附件下载专用 fetch（H-01）：生产环境由 `createGuardedFetch` 生成，
   * 直连、不经用户代理，逐跳重校验 DNS/端口/协议。
   */
  readonly directFetch?: typeof fetch;
  readonly signal?: AbortSignal;
  readonly limits?: Partial<AttachmentLimits>;
}

const DATA_URL = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/u;
const BARE_BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function mediaTypeOf(value: unknown, fallback = "application/octet-stream"): string {
  const text = String(value ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/u.test(text) ? text : fallback;
}

function safeName(name: unknown, mediaType: string, index: number): string {
  const base = String(name ?? "").split(/[\\/]/u).pop()?.replace(/[\u0000-\u001f<>:"|?*]/gu, "").trim();
  // 按码点截断（P3-03）：`String.slice` 会把代理对从中间切开。
  if (base) return Array.from(base).slice(0, 200).join("");
  const ext = mediaType.split("/")[1]?.replace(/[^a-z0-9]/giu, "") || "bin";
  return `attachment-${index + 1}.${ext}`;
}

function limitsOf(partial: Partial<AttachmentLimits> | undefined): AttachmentLimits {
  if (!partial) return ATTACHMENT_LIMITS;
  return {
    maxFiles: partial.maxFiles ?? ATTACHMENT_LIMITS.maxFiles,
    maxTotalBytes: partial.maxTotalBytes ?? ATTACHMENT_LIMITS.maxTotalBytes,
    maxFileBytes: partial.maxFileBytes ?? ATTACHMENT_LIMITS.maxFileBytes,
  };
}

function assertSize(bytes: Uint8Array, name: string, limits: AttachmentLimits): void {
  if (bytes.length > limits.maxFileBytes) {
    throw new CapyError("invalid_request", `附件 ${name} 超过单文件上限（250 MB）`);
  }
}

function decodeDataUrl(
  value: string,
  fallbackType: string,
  limits: AttachmentLimits,
): { mediaType: string; bytes: Uint8Array } | null {
  const match = DATA_URL.exec(value);
  if (!match) return null;
  const mediaType = mediaTypeOf(match[1], fallbackType);
  const raw = match[3] ?? "";
  let bytes: Uint8Array;
  if (match[2]) {
    // base64 载荷严格校验：非法字符不再被 Buffer.from 静默丢弃（P3-01）。
    if (!/^[A-Za-z0-9+/]*={0,2}$/u.test(raw) || raw.length % 4 !== 0) {
      throw new CapyError("invalid_request", "附件 data URL 的 base64 载荷无效");
    }
    bytes = Buffer.from(raw, "base64");
  } else {
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      throw new CapyError("invalid_request", "附件 data URL 的百分号转义无效");
    }
    bytes = Buffer.from(decoded, "utf8");
  }
  if (bytes.length === 0) {
    throw new CapyError("invalid_request", "附件 data URL 为空（0 字节）");
  }
  assertSize(bytes, "data URL", limits);
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
  if (url.username || url.password) {
    throw new CapyError("invalid_request", "附件 URL 不允许携带用户名/密码");
  }
  if (isBlockedHostname(url.hostname)) {
    throw new CapyError("invalid_request", "附件 URL 指向本机/内网地址，已拒绝（SSRF）");
  }
  return url;
}

/** 逐块累计，不信任 content-length（H-01）。 */
async function readCapped(
  response: Response,
  name: string,
  limits: AttachmentLimits,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      total += value.length;
      if (total > limits.maxFileBytes) {
        await reader.cancel().catch(() => undefined);
        throw new CapyError("invalid_request", `附件 ${name} 超过单文件上限（250 MB）`);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof CapyError) throw error;
    // 超时走 504，不再按 503 报（M-10）。
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new CapyError("upstream_timeout", "下载远程附件超时", { cause: error });
    }
    if (signal?.aborted) {
      throw new CapyError("upstream_unavailable", "下载远程附件已取消", { cause: error });
    }
    throw new CapyError("upstream_unavailable", `下载远程附件失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

async function readRemote(
  fetchImpl: typeof fetch,
  raw: string,
  name: string,
  signal: AbortSignal | undefined,
  limits: AttachmentLimits,
): Promise<{ name: string; mediaType: string; bytes: Uint8Array }> {
  const url = assertPublicUrl(raw);
  let response: Response;
  try {
    response = await fetchImpl(url.toString(), {
      method: "GET",
      headers: { accept: "image/*,application/pdf,*/*;q=0.8" },
      // redirect 交给注入的 fetch（生产是 guarded fetch，逐跳校验）；
      // 这里不再传 "follow"，避免裸 fetch 路径被误用。
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new CapyError("upstream_timeout", "下载远程附件超时", { cause: error });
    }
    throw new CapyError("upstream_unavailable", `下载远程附件失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (!response.ok) throw new CapyError("invalid_request", `下载远程附件失败（HTTP ${response.status}）`);
  const declared = Number(response.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limits.maxFileBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new CapyError("invalid_request", "远程附件超过单文件上限（250 MB）");
  }
  const bytes = await readCapped(response, name, limits, signal);
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
  signal: AbortSignal | undefined,
  limits: AttachmentLimits,
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
    const decoded = decodeDataUrl(source, fallbackType, limits);
    if (!decoded) throw new CapyError("invalid_request", "附件 data URL 无法解析");
    return { name, mediaType: decoded.mediaType, bytes: decoded.bytes };
  }
  if (/^https?:\/\//iu.test(source)) {
    return readRemote(fetchImpl, source, name, signal, limits);
  }
  const text = source.trim();
  if (BARE_BASE64.test(text) && text.length % 4 === 0) {
    const bytes = Buffer.from(text, "base64");
    assertSize(bytes, name, limits);
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
  options: CollectAttachmentsOptions,
): Promise<{ messages: ChatMessage[]; attachments: UploadCandidate[] }> {
  const limits = limitsOf(options.limits);
  // 远程附件下载用独立直连 fetch（H-01），不走可能带用户代理的 fetchImpl。
  const directFetch = options.directFetch ?? options.fetchImpl;
  const cleaned: ChatMessage[] = [];
  const attachments: UploadCandidate[] = [];
  let totalBytes = 0;
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
        if (attachments.length >= limits.maxFiles) {
          throw new CapyError("invalid_request", `附件数量超过上限（最多 ${limits.maxFiles} 个）`);
        }
        const attachment = await resolvePart(
          directFetch,
          part as ImagePart | FilePart,
          attachments.length,
          options.signal,
          limits,
        );
        totalBytes += attachment.bytes.length;
        if (totalBytes > limits.maxTotalBytes) {
          throw new CapyError("invalid_request", "附件总大小超过上限（128 MiB）");
        }
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
