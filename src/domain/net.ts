/**
 * 纯 IP / 主机名判定（domain 层，无 node:* 依赖）。
 *
 * 只做字面量判定：application 层用它做防呆，真正的 DNS 解析判定在
 * adapters/platform/guarded-fetch.ts。判定原则是 fail-closed：
 * 解析不出来就当作可疑。
 */

export type Ipv4Tuple = readonly [number, number, number, number];

export interface Ipv6Address {
  /** 8 个 16-bit 组。 */
  readonly groups: readonly number[];
  /** `::ffff:a.b.c.d` 形式（IPv4-mapped）。 */
  readonly isV4Mapped: boolean;
  /** 映射/内嵌的 IPv4 四段。 */
  readonly v4: Ipv4Tuple | null;
}

interface V4Range {
  readonly base: Ipv4Tuple;
  readonly bits: number;
}

/** 私网 / 回环 / 链路本地 / CGNAT / 保留 / 组播：一律拒。 */
export const BLOCKED_V4: readonly V4Range[] = [
  { base: [0, 0, 0, 0], bits: 8 },
  { base: [10, 0, 0, 0], bits: 8 },
  { base: [100, 64, 0, 0], bits: 10 },
  { base: [127, 0, 0, 0], bits: 8 },
  { base: [169, 254, 0, 0], bits: 16 },
  { base: [172, 16, 0, 0], bits: 12 },
  { base: [192, 0, 0, 0], bits: 24 },
  { base: [192, 0, 2, 0], bits: 24 },
  { base: [192, 88, 99, 0], bits: 24 },
  { base: [192, 168, 0, 0], bits: 16 },
  { base: [198, 18, 0, 0], bits: 15 },
  { base: [198, 51, 100, 0], bits: 24 },
  { base: [203, 0, 113, 0], bits: 24 },
  { base: [224, 0, 0, 0], bits: 4 },
  { base: [240, 0, 0, 0], bits: 4 },
  { base: [255, 255, 255, 255], bits: 32 },
];

function toNumber(octets: Ipv4Tuple): number {
  const [a, b, c, d] = octets;
  return ((a * 0x1000000) + (b * 0x10000) + (c * 0x100) + d) >>> 0;
}

/** 严格十进制四段（`010` 这种前导零按不可解析处理，避免八进制歧义）。 */
export function parseIpv4(text: string): Ipv4Tuple | null {
  const value = String(text ?? "").trim();
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/u.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    octets.push(n);
  }
  return [octets[0] as number, octets[1] as number, octets[2] as number, octets[3] as number];
}

function groupOf(text: string): number | null {
  return /^[0-9a-f]{1,4}$/u.test(text) ? Number.parseInt(text, 16) : null;
}

/**
 * 支持 `::` 压缩、`%zone` 后缀、`[::1]` 括号、以及尾部内嵌的 IPv4
 * （`::ffff:1.2.3.4` 与 `::ffff:7f00:1` 都会展开成 IPv4-mapped）。
 */
export function parseIpv6(text: string): Ipv6Address | null {
  let value = String(text ?? "").trim().toLowerCase();
  if (!value) return null;
  if (value.startsWith("[") && value.endsWith("]")) value = value.slice(1, -1);
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);
  if (!value.includes(":")) return null;

  let embeddedV4: Ipv4Tuple | null = null;
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    embeddedV4 = parseIpv4(tail);
    if (!embeddedV4) return null;
    const [a, b, c, d] = embeddedV4;
    const hi = ((a * 0x100) + b).toString(16);
    const lo = ((c * 0x100) + d).toString(16);
    value = `${value.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = value.split("::");
  if (halves.length > 2) return null;
  const headText = halves[0] ?? "";
  const tailText = halves.length === 2 ? (halves[1] ?? "") : "";
  const head = headText ? headText.split(":") : [];
  const tailGroups = halves.length === 2 && tailText ? tailText.split(":") : [];
  if (halves.length === 1 && tailGroups.length > 0) return null;

  const headNumbers: number[] = [];
  for (const part of head) {
    const n = groupOf(part);
    if (n === null) return null;
    headNumbers.push(n);
  }
  const tailNumbers: number[] = [];
  for (const part of tailGroups) {
    const n = groupOf(part);
    if (n === null) return null;
    tailNumbers.push(n);
  }

  let groups: number[];
  if (halves.length === 1) {
    if (headNumbers.length !== 8) return null;
    groups = headNumbers;
  } else {
    const missing = 8 - headNumbers.length - tailNumbers.length;
    if (missing < 1) return null;
    groups = [...headNumbers, ...new Array<number>(missing).fill(0), ...tailNumbers];
  }

  const g0 = groups[0] as number;
  const g1 = groups[1] as number;
  const g5 = groups[5] as number;
  const g6 = groups[6] as number;
  const g7 = groups[7] as number;
  const isV4Mapped = g0 === 0 && g1 === 0 && groups.slice(1, 5).every((g) => g === 0) && g5 === 0xffff;
  const v4: Ipv4Tuple | null = isV4Mapped
    ? [(g6 >> 8) & 0xff, g6 & 0xff, (g7 >> 8) & 0xff, g7 & 0xff]
    : embeddedV4;
  return { groups, isV4Mapped, v4 };
}

export function isBlockedIpv4(octets: readonly number[]): boolean {
  if (octets.length !== 4) return true;
  const value = toNumber([octets[0] as number, octets[1] as number, octets[2] as number, octets[3] as number]);
  for (const range of BLOCKED_V4) {
    const mask = range.bits >= 32 ? 0xffffffff : (0xffffffff << (32 - range.bits)) >>> 0;
    if (((value & mask) >>> 0) === ((toNumber(range.base) & mask) >>> 0)) return true;
  }
  return false;
}

export function isBlockedIpv6(address: Ipv6Address): boolean {
  const groups = address.groups;
  if (groups.length !== 8) return true;
  if (address.isV4Mapped && address.v4) return isBlockedIpv4(address.v4);
  // `::/96`（含 `::`、`::1`、`::7f00:1` 这类 IPv4-compatible 写法）一律拒：
  // 它们表示"本机/内嵌 IPv4"，绕过判定就能打到回环。
  if (groups.slice(0, 6).every((g) => g === 0)) return true;
  const g0 = groups[0] as number;
  const g1 = groups[1] as number;
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g0 & 0xffc0) === 0xfec0) return true; // fec0::/10 site-local
  if ((g0 & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // 2001:db8::/32 doc
  if (g0 === 0x0064 && g1 === 0xff9b) return true; // 64:ff9b::/96 NAT64
  if (g0 === 0x2002) return true; // 2002::/16 6to4
  if (g0 === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) return true; // 100::/64 discard
  return false;
}

/** IP 字面量（v4 或 v6）是否落在禁止段；解析失败按可疑处理。 */
export function isBlockedIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(ip);
  if (v6) return isBlockedIpv6(v6);
  return true;
}

export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || parseIpv6(host) !== null;
}

/**
 * 主机名字面量判定（application 层防呆）：`localhost` / `.local` / `.internal`
 * 与私网 IP 字面量直接拒；普通域名放行，交给 adapter 的 DNS 判定。
 */
export function isBlockedHostname(host: string): boolean {
  const value = String(host ?? "").trim().toLowerCase().replace(/^\[/u, "").replace(/\]$/u, "").replace(/\.$/u, "");
  if (!value) return true;
  if (
    value === "localhost"
    || value.endsWith(".localhost")
    || value.endsWith(".local")
    || value.endsWith(".internal")
    || value.endsWith(".home.arpa")
    || value === "metadata"
  ) {
    return true;
  }
  const v4 = parseIpv4(value);
  if (v4) return isBlockedIpv4(v4);
  const v6 = parseIpv6(value);
  if (v6) return isBlockedIpv6(v6);
  return false;
}
