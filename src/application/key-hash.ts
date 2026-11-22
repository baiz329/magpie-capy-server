/**
 * 缓存键哈希（M-05）：缓存键绝不能直接带 API key 尾部片段，
 * 用 SHA-256 摘要代替。WebCrypto 不可用时退回 djb2（仍不暴露 key 内容，
 * 只是防碰撞能力弱于 SHA-256）。
 */
export async function keyHash(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
    return [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  let hash = 5381;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) + hash + (value.charCodeAt(i) ?? 0)) >>> 0;
  }
  return `djb2-${hash.toString(16)}`;
}
