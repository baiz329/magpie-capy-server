import fs from "node:fs";
import path from "node:path";

/**
 * 工作区路径约束（S-01）。
 *
 * `confine` 把「相对/绝对路径 + 符号链接 + Windows 设备路径」一次判定完，
 * 五个文件 handler 全部走它；`JamRootRegistry` 取代原来的进程级 `activeRoot`。
 */

export type ConfineResult =
  | { readonly ok: true; readonly abs: string; readonly real: string }
  | { readonly ok: false; readonly reason: string };

export interface ConfineOptions {
  readonly mustExist?: boolean;
  /** 写操作传 true：最后一段本身是软链就拒（不跟随写）。 */
  readonly denySymlinkTarget?: boolean;
  /**
   * 仅用于测试/跨平台单测：默认 `process.platform`。
   * 这样 win32 的 UNC / drive-relative 规则可以在任意平台上被覆盖测试。
   */
  readonly platform?: NodeJS.Platform;
}

type PathImpl = typeof path.posix;

function implOf(platform: NodeJS.Platform): PathImpl {
  return platform === "win32" ? path.win32 : path.posix;
}

function fold(value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? value.toLowerCase() : value;
}

function refuse(reason: string): ConfineResult {
  return { ok: false, reason };
}

/** `target` 是否在 `base` 之内（含 base 自身）。用 `path.relative` 而不是 `startsWith`。 */
export function isInside(base: string, target: string, platform: NodeJS.Platform = process.platform): boolean {
  const p = implOf(platform);
  const rel = p.relative(fold(base, platform), fold(target, platform));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${p.sep}`) && !p.isAbsolute(rel);
}

interface WalkResult {
  readonly ok: true;
  readonly real: string;
  readonly exists: boolean;
  readonly finalIsSymlink: boolean;
}

/**
 * 从 baseReal 开始逐段 lstat/realpath。
 *
 * 不能用 `existsSync`：它**跟随**符号链接，悬空链接会返回 false，
 * 于是被当成"新文件"、只校验父目录，最后 `writeFileSync` 顺着链接在根外创建文件。
 */
function walkWithinRoot(
  baseReal: string,
  abs: string,
  platform: NodeJS.Platform,
  p: PathImpl,
): WalkResult | { readonly ok: false; readonly reason: string } {
  const rest = p.relative(baseReal, abs);
  const segments = rest === "" ? [] : rest.split(p.sep).filter((segment) => segment !== "" && segment !== ".");
  let current = baseReal;
  let finalIsSymlink = false;
  let allExist = true;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] as string;
    const next = p.join(current, segment);
    if (!allExist) {
      // 父目录都不存在，后面的段只能是新路径，直接拼接。
      current = next;
      continue;
    }
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(next);
    } catch {
      allExist = false;
      current = next;
      continue;
    }
    if (stat.isSymbolicLink()) {
      let target: string;
      try {
        // realpath 会跟随整条链；悬空链接在这里抛错。
        target = fs.realpathSync(next);
      } catch {
        return { ok: false, reason: "dangling symlink" };
      }
      if (!isInside(baseReal, target, platform)) {
        return { ok: false, reason: "symlink escapes worktree root" };
      }
      current = target;
      finalIsSymlink = index === segments.length - 1;
      continue;
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      return { ok: false, reason: "not a directory" };
    }
    current = next;
    finalIsSymlink = false;
  }
  return { ok: true, real: current, exists: allExist, finalIsSymlink };
}

/**
 * 把 `raw` 解析成 `root` 内的一条真实路径。
 *
 * 判定顺序（任一不满足即 `Refused`）：
 * 空值 → NUL → Windows 专属（UNC/`\\?\`/`\\.\`/drive-relative）→ 越过 root →
 * 符号链接逃逸 → （新文件时）最近已存在祖先是否仍在 root 内。
 */
export function confine(root: string, raw: unknown, options: ConfineOptions = {}): ConfineResult {
  const platform = options.platform ?? process.platform;
  const p = implOf(platform);
  const value = String(raw ?? "").trim();
  if (!value) return refuse("path is required");
  if (value.includes("\0")) return refuse("path contains NUL");

  if (platform === "win32") {
    // 同时覆盖 \\server\share、\\?\C:\…、\\.\pipe\…
    if (/^[\\/]{2}/u.test(value)) return refuse("UNC/device path not allowed");
    // "C:foo" 是相对驱动器 cwd，语义不可控
    if (/^[A-Za-z]:(?![\\/])/u.test(value)) return refuse("drive-relative path not allowed");
  }

  const baseAbs = p.resolve(root);
  try {
    if (!fs.existsSync(baseAbs)) fs.mkdirSync(baseAbs, { recursive: true, mode: 0o700 });
  } catch {
    return refuse("worktree root is not writable");
  }
  let baseReal: string;
  try {
    baseReal = fs.realpathSync(baseAbs);
  } catch {
    return refuse("worktree root is not readable");
  }

  // path.resolve 遇到绝对路径会直接返回它，因此"根外绝对路径"由下一步的 relative 拒掉。
  const abs = p.resolve(baseReal, value);
  if (!isInside(baseReal, abs, platform)) return refuse("outside worktree root");

  const walked = walkWithinRoot(baseReal, abs, platform, p);
  if (!walked.ok) return refuse(walked.reason);
  if (walked.finalIsSymlink && options.denySymlinkTarget) {
    return refuse("refusing to write through symlink");
  }
  if (walked.exists) return { ok: true, abs, real: walked.real };
  if (options.mustExist) return refuse("not found");
  return { ok: true, abs, real: walked.real };
}

/** 只做符号链接逃逸校验（写路径用）：等价于 `confine(..., { denySymlinkTarget: true })`。 */
export function assertNoSymlinkEscape(
  root: string,
  raw: unknown,
  options: ConfineOptions = {},
): ConfineResult {
  return confine(root, raw, { ...options, denySymlinkTarget: true });
}

/** 上游用哪几个请求头标识"这次会话属于哪个 jam/thread"。 */
export const WORKTREE_ROOT_HEADERS = ["x-capy-jam-id", "x-capy-thread-id"] as const;

const ROOT_TTL_MS = 30 * 60_000;
const ROOT_CAPACITY = 64;

function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return "";
}

export function jamIdOf(headers: Record<string, string>): string {
  for (const name of WORKTREE_ROOT_HEADERS) {
    const value = headerValue(headers, name).trim();
    if (value) return value.slice(0, 200);
  }
  return "";
}

interface RootEntry {
  readonly root: string;
  readonly at: number;
}

export interface JamRootRegistryOptions {
  readonly ttlMs?: number;
  readonly capacity?: number;
  readonly now?: () => number;
}

/**
 * jamId → 工作区根。TTL 30 分钟 + 容量 64（LRU 淘汰），避免并发会话串目录
 * 又没有上限地堆内存。
 */
export class JamRootRegistry {
  private readonly entries = new Map<string, RootEntry>();
  private readonly ttlMs: number;
  private readonly capacity: number;
  private readonly now: () => number;

  constructor(options: JamRootRegistryOptions = {}) {
    this.ttlMs = Math.max(1000, options.ttlMs ?? ROOT_TTL_MS);
    this.capacity = Math.max(1, options.capacity ?? ROOT_CAPACITY);
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    return this.entries.size;
  }

  set(jamId: string, root: string): void {
    if (!jamId) return;
    this.entries.delete(jamId);
    this.entries.set(jamId, { root, at: this.now() });
    while (this.entries.size > this.capacity) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }

  get(jamId: string): string | undefined {
    if (!jamId) return undefined;
    const entry = this.entries.get(jamId);
    if (!entry) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.entries.delete(jamId);
      return undefined;
    }
    // 命中即刷新 LRU 顺序（不刷新 TTL 起点：TTL 从写入算起）。
    this.entries.delete(jamId);
    this.entries.set(jamId, entry);
    return entry.root;
  }

  clear(): void {
    this.entries.clear();
  }
}

/** 请求头里没有 jamId 时退回 base；有则用注册表里的根。 */
export function resolveMachineRoot(
  headers: Record<string, string>,
  base: string,
  registry: JamRootRegistry,
): string {
  const jamId = jamIdOf(headers);
  if (!jamId) return base;
  return registry.get(jamId) ?? base;
}
