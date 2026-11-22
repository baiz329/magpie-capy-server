import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AccountSession } from "../../domain/account.ts";
import { accountKey } from "../../domain/account.ts";
import { CapyError } from "../../domain/errors.ts";
import type { HeadlessCredential, DeviceRuntimePort } from "../../ports/device-runtime.ts";
import type { DeviceInfo } from "../../ports/capy-app.ts";
import type { ClockPort, LoggerPort, SecretStorePort } from "../../ports/platform.ts";
import type { CapyAppPort } from "../../ports/capy-app.ts";
import { dpapiProtect, dpapiUnprotect } from "../platform/dpapi.ts";
import { CONTRACT_VERSION, DEVICE_TUNNEL } from "./endpoints.ts";
import { machineCapabilityOf, refusalFor, shouldWarnFull } from "./machine-capability.ts";
import type { MachineCapability } from "./machine-capability.ts";
import { JamRootRegistry, confine, jamIdOf, resolveMachineRoot } from "./machine-path.ts";

const HEADLESS_NAME = "magpie-headless";
const READY_TIMEOUT_MS = 15_000;
const CONNECT_POLL_MS = 400;
const STATE_VERSION = 1;

/** 单文件读取/编辑上限：原来整文件 readFileSync 会 OOM。 */
const MAX_READ_BYTES = 8 * 1024 * 1024;
/** 单条隧道流的请求体上限（H-07）。 */
const MAX_STREAM_BYTES = 32 * 1024 * 1024;
const MAX_CONCURRENT_STREAMS = 16;
/** `open` 之后迟迟收不到完整请求体的清理时间。 */
const STREAM_IDLE_TIMEOUT_MS = 60_000;
const BASH_OUTPUT_LIMIT = 4 * 1024 * 1024;
const AUDIT_COMMAND_LIMIT = 200;

function deviceOs(): string {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function deviceArch(): string {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

/** 设备名优先用主机名（这台机器是 `baijiu`），没有就用系统用户名。 */
export function defaultDeviceName(): string {
  const override = String(process.env.MAGPIE_CAPY_DEVICE_NAME ?? "").trim();
  if (override) return override.slice(0, 80);
  let host = "";
  try { host = os.hostname(); } catch {}
  let user = "";
  try { user = os.userInfo().username; } catch {}
  if (!user) user = String(process.env.USERNAME ?? process.env.USER ?? "").trim();
  const raw = host || user || "capy-headless";
  return raw
    .replace(/[^A-Za-z0-9._@-]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80) || "capy-headless";
}

/** 工作区根：显式传入 > MAGPIE_CAPY_WORKTREE_BASE > ~/.capy/worktrees。 */
export function resolveWorktreeBase(explicit?: string): string {
  const raw = explicit?.trim() || process.env.MAGPIE_CAPY_WORKTREE_BASE?.trim() || "";
  if (!raw) return path.join(os.homedir(), ".capy", "worktrees");
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function stateDir(): string {
  const override = String(process.env.MAGPIE_CAPY_STATE_DIR ?? "").trim();
  if (override) return path.resolve(override);
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "magpie-capy");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "magpie-capy");
  }
  return path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "magpie-capy");
}

export class FileSecretStore implements SecretStorePort {
  private readonly baseDir: string;
  private readonly onWarn: ((message: string) => void) | undefined;
  private prepared = false;
  private warnedPlaintext = false;

  constructor(baseDir = stateDir(), options: { readonly onWarn?: (message: string) => void } = {}) {
    this.baseDir = baseDir;
    this.onWarn = options.onWarn;
  }

  async load(account: string): Promise<HeadlessCredential | null> {
    try {
      const doc = JSON.parse(fs.readFileSync(this.fileOf(account), "utf8")) as Record<string, unknown>;
      if (doc.version !== STATE_VERSION) return null;
      const orgId = String(doc.orgId ?? "");
      const deviceId = String(doc.deviceId ?? "");
      const name = String(doc.name ?? HEADLESS_NAME);
      const token = typeof doc.token === "string"
        ? doc.token
        : typeof doc.tokenCiphertext === "string"
          ? (await dpapiUnprotect(Buffer.from(doc.tokenCiphertext, "base64"))).toString("utf8")
          : "";
      if (!orgId || !deviceId || !token.startsWith("capyd_")) return null;
      return { orgId, deviceId, name, token };
    } catch {
      return null;
    }
  }

  async save(account: string, credential: HeadlessCredential): Promise<void> {
    this.prepare();
    const file = this.fileOf(account);
    // tmp 名带随机后缀：原来 `${pid}.tmp` 可预测，同机进程可以抢先建同名文件。
    const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const secret = process.platform === "win32"
      ? { tokenCiphertext: await dpapiProtect(credential.token) }
      : { token: credential.token };
    fs.writeFileSync(tmp, JSON.stringify({
      version: STATE_VERSION,
      orgId: credential.orgId,
      deviceId: credential.deviceId,
      name: credential.name,
      ...secret,
    }, null, 2), { mode: 0o600 });
    if (process.platform !== "win32") {
      try { fs.chmodSync(tmp, 0o600); } catch {}
    }
    fs.renameSync(tmp, file);
    if (process.platform !== "win32") {
      try { fs.chmodSync(file, 0o600); } catch {}
    }
    this.warnPlaintextOnce(file);
  }

  async clear(account: string): Promise<void> {
    try { fs.unlinkSync(this.fileOf(account)); } catch {}
  }

  /** 目录 0700 + 清掉上次崩溃留下的 `*.tmp`（H-05）。 */
  private prepare(): void {
    if (this.prepared) return;
    this.prepared = true;
    try { fs.mkdirSync(this.baseDir, { recursive: true, mode: 0o700 }); } catch {}
    if (process.platform !== "win32") {
      try { fs.chmodSync(this.baseDir, 0o700); } catch {}
    }
    this.cleanupTemps();
  }

  private cleanupTemps(): void {
    let names: string[];
    try {
      names = fs.readdirSync(this.baseDir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!name.endsWith(".tmp")) continue;
      try { fs.unlinkSync(path.join(this.baseDir, name)); } catch {}
    }
  }

  private warnPlaintextOnce(file: string): void {
    if (this.warnedPlaintext || process.platform === "win32") return;
    this.warnedPlaintext = true;
    this.onWarn?.(
      `设备 token 以明文保存在 ${file}（非 Windows 没有 DPAPI；目录 0700、文件 0600 已设置）`,
    );
  }

  private fileOf(account: string): string {
    const safe = account.replace(/[^A-Za-z0-9._-]+/gu, "_").slice(0, 120);
    return path.join(this.baseDir, `headless-${safe}.json`);
  }
}

interface TunnelFrame {
  readonly type?: string;
  readonly [key: string]: unknown;
}

interface StreamState {
  readonly streamId: number;
  readonly kind: string;
  readonly method: string;
  readonly path: string;
  readonly headers: Record<string, string>;
  /** 分块累计；只用一次 `Buffer.concat`（H-07：原来每帧 concat 一次是 O(n²)）。 */
  readonly chunks: Uint8Array[];
  bytes: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function headerValue(headers: Record<string, string>, name: string): string {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return String(value);
  }
  return "";
}

function encodeDataFrame(streamId: number, body: Buffer): Buffer {
  const frame = Buffer.alloc(4 + body.length);
  frame.writeUInt32BE(streamId >>> 0, 0);
  body.copy(frame, 4);
  return frame;
}

function decodeDataFrame(bytes: Uint8Array): { streamId: number; body: Uint8Array } | null {
  if (bytes.length < 4) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { streamId: view.getUint32(0), body: bytes.subarray(4) };
}

type MachineOutcome =
  | { readonly status: "succeeded"; readonly result: unknown }
  | { readonly status: "failed"; readonly error: { readonly code: string; readonly message: string } };

function ok(result: unknown): MachineOutcome {
  return { status: "succeeded", result };
}

function fail(code: string, message: string): MachineOutcome {
  return { status: "failed", error: { code, message } };
}

function fileFailure(error: unknown): MachineOutcome {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ENOENT") return fail("MachineServer.FileError", `not-found: ${message}`);
  if (code === "EISDIR") return fail("MachineServer.FileError", `is-directory: ${message}`);
  if (code === "EACCES" || code === "EPERM") return fail("MachineServer.FileError", `permission-denied: ${message}`);
  return fail("MachineServer.FileError", `other: ${message}`);
}

/** 审计日志：只记命令摘要 + 耗时 + 退出码，**不记 stdout/stderr**（S-02）。 */
export interface MachineAuditEntry {
  readonly handler: string;
  readonly command: string;
  readonly durationMs: number;
  readonly exitCode: number;
}

/**
 * machine handler 的运行上下文。
 * `base` 是工作区根（`~/.capy/worktrees`），`root` 是本 jam 的工作区（默认 = base）。
 * `worktree_ensure` 的越界检查永远对 `base`，其它 handler 对 `root`。
 */
export interface MachineContext {
  readonly base: string;
  readonly root: string;
  readonly capability?: MachineCapability;
  readonly shell?: string;
  readonly env?: Record<string, string | undefined>;
  readonly audit?: (entry: MachineAuditEntry) => void;
  readonly now?: () => number;
}

/**
 * 第三参历史上是 `string`（测试与旧调用点是这么传的），现在既接受字符串也接受
 * `MachineContext`：字符串按「base = root = 该目录、默认 files 档」归一化。
 */
function contextOf(value: string | MachineContext): MachineContext {
  if (typeof value === "string") {
    const base = path.resolve(value);
    return { base, root: base };
  }
  const base = path.resolve(value.base);
  const root = path.resolve(value.root || value.base);
  return { ...value, base, root };
}

function sha256OfText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** 流式 hash：大于 8 MB 的文件不再整个读进内存（H-07）。 */
function sha256OfFile(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read <= 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * bash 的环境变量白名单：只透传与定位可执行文件/区域设置有关的键，
 * 其余（含 `*_KEY` / `*_TOKEN` / 代理 / MAGPIE_CAPY_*）一律不传（S-02）。
 */
const BASH_ENV_ALLOW = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "USERNAME",
  "USERPROFILE",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SystemRoot",
  "SystemDrive",
  "WINDIR",
  "ComSpec",
  "PATHEXT",
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "PROCESSOR_ARCHITECTURE",
  "NUMBER_OF_PROCESSORS",
] as const;

const BASH_ENV_DENY = /(?:key|token|secret|password|passwd|credential|auth|cookie|capy|magpie|proxy|api)/iu;

function bashEnv(source: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASH_ENV_ALLOW) {
    const value = source[name];
    if (typeof value === "string" && value && !BASH_ENV_DENY.test(name)) env[name] = value;
  }
  return {
    ...env,
    PS1: "",
    NO_COLOR: "1",
    TERM: "dumb",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    PAGER: "cat",
    GIT_PAGER: "cat",
    GH_PAGER: "cat",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  };
}

function summarizeCommand(command: string): string {
  const text = command.replace(/\s+/gu, " ").trim();
  return text.length > AUDIT_COMMAND_LIMIT ? `${text.slice(0, AUDIT_COMMAND_LIMIT)}…` : text;
}

/** 超时时连子进程组一起杀：只 kill 直接子进程会留下 `npm run` 之类的孙子进程。 */
function killProcessGroup(child: ReturnType<typeof spawn>, detached: boolean): void {
  const pid = child.pid;
  if (detached && typeof pid === "number") {
    try {
      process.kill(-pid, "SIGKILL");
      return;
    } catch {
      // 进程组可能已经没了，退化成单进程 kill
    }
  }
  try { child.kill("SIGKILL"); } catch {}
  if (process.platform === "win32" && pid) {
    try {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }).unref();
    } catch {}
  }
}

async function runBash(params: Record<string, unknown>, ctx: MachineContext): Promise<MachineOutcome> {
  const command = String(params.command ?? "");
  if (!command.trim()) return fail("MachineServer.Bash", "bash command is empty");
  const timeoutSeconds = Math.max(1, Math.min(600, Number(params.timeoutSeconds) || 120));
  const runCwd = path.resolve(ctx.root || ctx.base);
  try { fs.mkdirSync(runCwd, { recursive: true, mode: 0o700 }); } catch { /* best effort */ }

  const shell = String(ctx.shell ?? process.env.MAGPIE_CAPY_BASH ?? "").trim() || "bash";
  const env = bashEnv(ctx.env ?? process.env);
  const startedAt = (ctx.now ?? Date.now)();
  const detached = process.platform !== "win32";

  return await new Promise<MachineOutcome>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child: ReturnType<typeof spawn>;
    try {
      // `-c` 而不是 `-lc`：不加载 profile（既慢又会把用户的 PATH/alias 带进来）。
      child = spawn(shell, ["-c", command], { cwd: runCwd, env, windowsHide: true, detached });
    } catch (error) {
      resolve(fail("MachineServer.Bash", `Failed to start bash: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    const append = (current: string, chunk: Buffer): string => {
      if (current.length >= BASH_OUTPUT_LIMIT) return current;
      return current + chunk.toString("utf8").slice(0, BASH_OUTPUT_LIMIT - current.length);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessGroup(child, detached);
    }, timeoutSeconds * 1000);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(fail("MachineServer.Bash", `Failed to start bash: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const exitCode = typeof code === "number" ? code : -1;
      const durationMs = (ctx.now ?? Date.now)() - startedAt;
      try {
        ctx.audit?.({
          handler: "bash",
          command: summarizeCommand(command),
          durationMs,
          exitCode,
        });
      } catch {
        // 审计失败不能影响命令结果
      }
      resolve(ok({
        kind: "bash",
        stdout,
        stderr,
        exitCode,
        durationMs,
        timedOut,
        // 非零退出码必须让模型看到失败（原来只有超时才算 error）。
        isError: timedOut || exitCode !== 0,
        ...(timedOut ? { landingNote: "Command timed out and was stopped." } : {}),
      }));
    });
  });
}

/** 只有 base 内的目录才能被当作工作区根（S-01：原来用 startsWith 字符串前缀判定）。 */
function confineOrRefuse(
  root: string,
  raw: unknown,
  options: { readonly mustExist?: boolean; readonly denySymlinkTarget?: boolean } = {},
): { ok: true; real: string } | MachineOutcome {
  const confined = confine(root, raw, {
    ...(options.mustExist ? { mustExist: true } : {}),
    ...(options.denySymlinkTarget ? { denySymlinkTarget: true } : {}),
  });
  if (confined.ok) return { ok: true, real: confined.real };
  const code = confined.reason === "not found" ? "MachineServer.FileError" : "MachineServer.Refused";
  return fail(code, confined.reason);
}

/**
 * 原子写文件（P3-16）：新建与已存在都走「写同目录临时文件 + rename」，
 * 不直接覆盖目标。rename 不跟随软链；写前再 lstat 一次，目标是软链就拒。
 */
export function writeFileSafely(file: string, content: string): void {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.capy-tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  fs.writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  try {
    try {
      if (fs.lstatSync(file).isSymbolicLink()) {
        throw Object.assign(new Error("refusing to write through symlink"), { code: "ELOOP" });
      }
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ENOENT") {
        // 目标不存在，正常新建。
      } else {
        throw error;
      }
    }
    fs.renameSync(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

function sizeOf(file: string): number | null {
  try {
    return fs.statSync(file).size;
  } catch {
    return null;
  }
}

/** 按码点截断一行（P3-03）：`String.slice` 会把代理对从中间切开。 */
function truncateLine(line: string, maxChars: number): string {
  const points = Array.from(line);
  return points.length > maxChars
    ? `${points.slice(0, maxChars).join("")}... (line truncated to ${maxChars} chars)`
    : line;
}

export async function machineResult(
  handler: string,
  params: Record<string, unknown>,
  context: string | MachineContext,
): Promise<MachineOutcome> {
  const ctx = contextOf(context);
  const capability = ctx.capability ?? "files";

  // 能力分级在最前面：off 不下发任何工具，files 永不执行外部进程（S-02）。
  const refusal = refusalFor(handler, capability);
  if (refusal) return fail("MachineServer.Unavailable", refusal);

  if (handler === "worktree_ensure") {
    const requested = String(params.root ?? "");
    let root = "";
    let created = false;
    if (requested) {
      // 例外：永远对 base 校验，而不是 ctx.root。
      const confined = confineOrRefuse(ctx.base, requested);
      if ("status" in confined) return confined;
      root = confined.real;
      created = !fs.existsSync(root);
      try {
        fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      } catch (error) {
        return fileFailure(error);
      }
    }
    return ok({ root, created, checkouts: [] });
  }
  if (handler === "worktree_list") {
    // 真实现：列 base 下一级目录（原来恒返回空数组 → 模型以为没有工作区）。
    const entries: { name: string; path: string }[] = [];
    try {
      for (const item of fs.readdirSync(ctx.base, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        entries.push({ name: item.name, path: path.join(ctx.base, item.name) });
      }
    } catch (error) {
      return fileFailure(error);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return ok({ kind: "worktree_list", entries });
  }
  if (handler === "bash") return await runBash(params, ctx);
  if (handler === "read") {
    const confined = confineOrRefuse(ctx.root, params.path);
    if ("status" in confined) return confined;
    try {
      const stat = fs.statSync(confined.real);
      if (stat.isDirectory()) return fail("MachineServer.FileError", `is-directory: ${confined.real}`);
      if (stat.size > MAX_READ_BYTES) {
        return ok({ kind: "too-large", sizeBytes: stat.size, bytes: stat.size, isError: true });
      }
      const text = fs.readFileSync(confined.real, "utf8");
      const offset = Math.max(1, Number(params.offset) || 1);
      const limit = Math.max(1, Math.min(10_000, Number(params.limit) || 2_000));
      const maxChars = Math.max(200, Math.min(100_000, Number(params.maxChars) || 20_000));
      const all = text.split(/\r?\n/u);
      const content = all
        .slice(offset - 1, offset - 1 + limit)
        .map((line) => truncateLine(line, maxChars))
        .join("\n");
      return ok({ kind: "read", path: confined.real, content, offset, totalLines: all.length, isError: false });
    } catch (error) {
      return fileFailure(error);
    }
  }
  if (handler === "write") {
    const confined = confineOrRefuse(ctx.root, params.path, { denySymlinkTarget: true });
    if ("status" in confined) return confined;
    try {
      const content = String(params.content ?? "");
      fs.mkdirSync(path.dirname(confined.real), { recursive: true, mode: 0o700 });
      writeFileSafely(confined.real, content);
      return ok({ kind: "write", path: confined.real, bytes: Buffer.byteLength(content), isError: false });
    } catch (error) {
      return fileFailure(error);
    }
  }
  if (handler === "edit") {
    const confined = confineOrRefuse(ctx.root, params.path, { mustExist: true, denySymlinkTarget: true });
    if ("status" in confined) return confined;
    try {
      const oldString = String(params.oldString ?? "");
      const newString = String(params.newString ?? "");
      if (!oldString || oldString === newString) {
        return fail("MachineServer.FileError", "oldString must be non-empty and differ from newString");
      }
      const size = sizeOf(confined.real) ?? 0;
      if (size > MAX_READ_BYTES) return fail("MachineServer.FileError", `file too large: ${size} bytes`);
      const text = fs.readFileSync(confined.real, "utf8");
      const count = text.split(oldString).length - 1;
      if (count === 0) return fail("MachineServer.FileError", `The text was not found in ${String(params.path)}`);
      if (count > 1 && params.replaceAll !== true) {
        return fail("MachineServer.FileError", `Found ${count} occurrences; provide more context or replaceAll`);
      }
      // 两分支统一 split/join：String.replace 会把 $&/$1 当替换模式解释（M-01）。
      // 到这里 count 只剩 0（已拒绝）或 1（单次）或 replaceAll，全量 join 是安全的。
      const next = text.split(oldString).join(newString);
      writeFileSafely(confined.real, next);
      return ok({ kind: "edit", path: confined.real, replacements: count, isError: false });
    } catch (error) {
      return fileFailure(error);
    }
  }
  if (handler === "file_read") {
    const confined = confineOrRefuse(ctx.root, params.path);
    if ("status" in confined) return confined;
    if (!fs.existsSync(confined.real)) return ok({ kind: "missing", isError: false });
    try {
      const stat = fs.statSync(confined.real);
      if (stat.size > MAX_READ_BYTES) {
        return ok({ kind: "too-large", sizeBytes: stat.size, bytes: stat.size, isError: true });
      }
      const text = fs.readFileSync(confined.real, "utf8");
      return ok({ kind: "read", path: confined.real, content: { text }, sha: sha256OfText(text), isError: false });
    } catch (error) {
      return fileFailure(error);
    }
  }
  if (handler === "file_write") {
    const confined = confineOrRefuse(ctx.root, params.path, { denySymlinkTarget: true });
    if ("status" in confined) return confined;
    try {
      const content = String(params.content ?? "");
      const size = sizeOf(confined.real) ?? 0;
      if (size > MAX_READ_BYTES) return fail("MachineServer.FileError", `file too large: ${size} bytes`);
      const currentSha = fs.existsSync(confined.real) ? sha256OfFile(confined.real) : null;
      const baseSha = typeof params.baseSha === "string" ? params.baseSha : null;
      if (baseSha !== null && currentSha !== baseSha) {
        return ok({ kind: "conflict", currentSha, isError: false });
      }
      fs.mkdirSync(path.dirname(confined.real), { recursive: true, mode: 0o700 });
      writeFileSafely(confined.real, content);
      return ok({ kind: "written", sha: sha256OfText(content), bytes: Buffer.byteLength(content), isError: false });
    } catch (error) {
      return fileFailure(error);
    }
  }
  return fail(
    "MachineServer.Unavailable",
    `无头设备未实现 ${handler || "unknown"}；浏览器/computer 等工具不会执行。`,
  );
}

class HeadlessDevice {
  private readonly credential: HeadlessCredential;
  private readonly WebSocketImpl: typeof WebSocket;
  private readonly worktreeBase: string;
  private readonly capability: MachineCapability;
  private readonly audit: ((entry: MachineAuditEntry) => void) | undefined;
  private ws: WebSocket | null = null;
  private ready = false;
  private connectPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private readonly streams = new Map<number, StreamState>();
  /** jamId → 工作区根；取代原来的进程级 `activeRoot`（H-13(2)）。 */
  private readonly roots = new JamRootRegistry();

  constructor(options: {
    readonly credential: HeadlessCredential;
    readonly WebSocketImpl?: typeof WebSocket;
    readonly worktreeBase?: string;
    readonly capability?: MachineCapability;
    readonly audit?: (entry: MachineAuditEntry) => void;
  }) {
    this.credential = options.credential;
    const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
    if (typeof Impl !== "function") {
      throw new CapyError("upstream_unavailable", "当前运行时没有 WebSocket（需要 Bun / Node 22+）");
    }
    this.WebSocketImpl = Impl;
    this.worktreeBase = resolveWorktreeBase(options.worktreeBase);
    this.capability = options.capability ?? "files";
    this.audit = options.audit;
  }

  get info(): DeviceInfo {
    return {
      id: this.credential.deviceId,
      name: this.credential.name,
      connected: this.ready,
    };
  }

  async ensure(timeoutMs = READY_TIMEOUT_MS): Promise<void> {
    if (this.ready && this.ws?.readyState === 1) return;
    if (this.connectPromise) return await this.connectPromise;
    this.connectPromise = this.connect(timeoutMs);
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  close(): void {
    this.ready = false;
    try { this.ws?.close(1000, "headless closed"); } catch {}
    this.ws = null;
  }

  private async connect(timeoutMs: number): Promise<void> {
    this.ready = false;
    // 先关掉旧 socket 再建新的，避免旧连接的回调干扰新连接（M-15）。
    const old = this.ws;
    if (old) {
      try { old.close(1000, "headless reconnect"); } catch {}
      this.ws = null;
    }
    let ws: WebSocket;
    try {
      ws = new this.WebSocketImpl(DEVICE_TUNNEL, {
        headers: { authorization: `Bearer ${this.credential.token}` },
      } as unknown as string[]);
    } catch (error) {
      throw tunnelError(error, "连接 Capy 设备隧道失败");
    }
    this.ws = ws;
    ws.binaryType = "arraybuffer";
    const ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    const timer = setTimeout(() => {
      // 旧 socket 的超时不能拒绝新连接的 ready（M-15 身份守卫）。
      if (this.ws !== ws) return;
      const failure = new Error(`连接 Capy 设备隧道超时（${Math.round(timeoutMs / 1000)}s）`);
      (failure as Error & { code?: string }).code = "device_connect_timeout";
      this.readyReject?.(failure);
      try { ws.close(4000, "ready timeout"); } catch {}
    }, Math.max(3000, timeoutMs));
    timer.unref?.();

    ws.addEventListener("open", () => {
      if (this.ws !== ws) return;
      this.send({
        type: "hello",
        contractVersion: CONTRACT_VERSION,
        deviceId: this.credential.deviceId,
        // 配对时用生效设备名，hello 也要用同一个名字，否则服务端看到的机器名不一致（P3-06）。
        hostname: this.credential.name || defaultDeviceName(),
        os: deviceOs(),
        workspaces: [],
        worktreeBase: this.worktreeBase,
        clientVersion: "magpie-headless 1.0",
      });
    });
    ws.addEventListener("message", (event) => {
      if (this.ws !== ws) return;
      this.onMessage(event);
    });
    ws.addEventListener("close", (event) => {
      // 旧 socket 的 close 不能置空新连接（M-15 身份守卫）。
      if (this.ws !== ws) return;
      this.ready = false;
      this.ws = null;
      clearTimeout(timer);
      if (!this.readyResolve) return;
      const reason = String(event.reason || "");
      const rejected = [4001, 4003, 4401, 4403].includes(Number(event.code))
        || /auth|token|unauthor|forbidden/iu.test(reason);
      const failure = new Error(`Capy 设备隧道已关闭（${event.code}${reason ? `：${reason}` : ""}）`);
      (failure as Error & { code?: string }).code = rejected ? "device_token_rejected" : "device_connect_failed";
      this.readyReject?.(failure);
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      const failure = new Error("Capy 设备隧道连接失败");
      (failure as Error & { code?: string }).code = "device_connect_failed";
      this.readyReject?.(failure);
    });

    try {
      await ready;
    } finally {
      clearTimeout(timer);
      this.readyResolve = null;
      this.readyReject = null;
    }
    this.ready = true;
  }

  private send(frame: Record<string, unknown>): boolean {
    if (!this.ws || this.ws.readyState !== 1) return false;
    try {
      this.ws.send(JSON.stringify(frame));
      return true;
    } catch {
      return false;
    }
  }

  private sendBinary(bytes: Buffer): void {
    if (!this.ws || this.ws.readyState !== 1) return;
    try { this.ws.send(bytes); } catch {}
  }

  private onMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      this.onControl(event.data);
      return;
    }
    const raw = event.data instanceof ArrayBuffer
      ? new Uint8Array(event.data)
      : ArrayBuffer.isView(event.data)
        ? new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength)
        : null;
    if (!raw) return;
    const frame = decodeDataFrame(raw);
    if (!frame) return;
    const stream = this.streams.get(frame.streamId);
    if (!stream) return;
    stream.chunks.push(frame.body);
    stream.bytes += frame.body.length;
    if (stream.bytes > MAX_STREAM_BYTES) {
      this.dropStream(
        stream,
        "MachineServer.Refused",
        `请求体超过 ${Math.round(MAX_STREAM_BYTES / (1024 * 1024))} MB 上限`,
      );
      return;
    }
    const length = Number(headerValue(stream.headers, "content-length") || 0);
    // 没有 content-length 时**不能**首帧就开跑：等 `close` 帧。
    if (length > 0 && stream.bytes >= length) this.runStream(stream);
  }

  private onControl(text: string): void {
    let frame: TunnelFrame;
    try { frame = JSON.parse(text) as TunnelFrame; } catch { return; }
    const type = String(frame.type ?? "");
    if (type === "ping") {
      this.send({ type: "pong" });
      return;
    }
    if (type === "session-config") {
      // 组织不一致就拒绝就绪（M-16）；帧里没带 orgId 时不校验。
      const frameOrgId = typeof frame.orgId === "string" ? frame.orgId.trim() : "";
      if (frameOrgId && frameOrgId !== this.credential.orgId) {
        const failure = new CapyError(
          "device_pair_failed",
          `Capy 隧道下发的组织（${frameOrgId}）与配对组织（${this.credential.orgId}）不一致`,
        );
        this.readyReject?.(failure);
        try { this.ws?.close(4003, "org mismatch"); } catch {}
        return;
      }
      this.send({ type: "workspaces-changed", workspaces: [] });
      this.send({ type: "ready" });
      this.readyResolve?.();
      return;
    }
    if (type === "open") {
      const streamId = Number(frame.streamId);
      if (!Number.isInteger(streamId)) return;
      if (this.streams.size >= MAX_CONCURRENT_STREAMS) {
        this.respond(streamId, 200, fail(
          "MachineServer.Refused",
          `并发流超过 ${MAX_CONCURRENT_STREAMS} 上限`,
        ));
        return;
      }
      const stream: StreamState = {
        streamId,
        kind: String(frame.kind ?? "invoke"),
        method: String(frame.method ?? "POST"),
        path: String(frame.path ?? ""),
        headers: (frame.headers && typeof frame.headers === "object"
          ? frame.headers as Record<string, string>
          : {}),
        chunks: [],
        bytes: 0,
        timer: null,
      };
      stream.timer = setTimeout(() => {
        // open 之后 60s 没拿到完整请求体 → 清掉并明确失败，避免泄漏一个占位的流。
        const current = this.streams.get(streamId);
        if (current === stream) {
          this.dropStream(stream, "MachineServer.Timeout", "60s 内没有收到完整请求体");
        }
      }, STREAM_IDLE_TIMEOUT_MS);
      stream.timer.unref?.();
      this.streams.set(streamId, stream);
      return;
    }
    if (type === "close") {
      const streamId = Number(frame.streamId);
      const stream = this.streams.get(streamId);
      if (stream) this.runStream(stream);
    }
  }

  private releaseStream(stream: StreamState): void {
    if (stream.timer) {
      clearTimeout(stream.timer);
      stream.timer = null;
    }
    this.streams.delete(stream.streamId);
  }

  private dropStream(stream: StreamState, code: string, message: string): void {
    this.releaseStream(stream);
    this.respond(stream.streamId, 200, fail(code, message));
  }

  private runStream(stream: StreamState): void {
    this.releaseStream(stream);
    void this.handleStream(stream).catch((error) => {
      this.respond(stream.streamId, 200, {
        status: "failed",
        error: { code: "MachineServer.Internal", message: errorText(error) },
      });
    });
  }

  private async handleStream(stream: StreamState): Promise<void> {
    // 一次性 concat，之后不再持有分块数组。
    const body = stream.chunks.length > 0
      ? Buffer.concat(stream.chunks, stream.bytes)
      : Buffer.alloc(0);
    let payload: unknown = null;
    try { payload = body.length > 0 ? JSON.parse(body.toString("utf8")) : null; } catch {}
    const record = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    let result: MachineOutcome;
    if (stream.path.startsWith("/v1/git/capture")) {
      // 占位：README 已标注未实现，这里返回空列表而不是假成功。
      result = ok({ repos: [] });
    } else if (stream.path.startsWith("/v1/invocations")) {
      const handler = String(record.handler ?? "");
      const params = record.params && typeof record.params === "object"
        ? record.params as Record<string, unknown>
        : {};
      // 每个请求按自己的 jamId 取工作区根；没有 jamId 才退回 base。
      const root = resolveMachineRoot(stream.headers, this.worktreeBase, this.roots);
      result = await machineResult(handler, params, {
        base: this.worktreeBase,
        root,
        capability: this.capability,
        ...(this.audit ? { audit: this.audit } : {}),
      });
      if (handler === "worktree_ensure" && result.status === "succeeded") {
        const created = (result.result as { root?: unknown } | null)?.root;
        const jamId = jamIdOf(stream.headers);
        if (jamId && typeof created === "string" && created) this.roots.set(jamId, created);
      }
    } else {
      result = fail("MachineServer.Unavailable", `未实现的路径 ${stream.path}`);
    }
    this.respond(stream.streamId, 200, result);
  }

  private respond(streamId: number, status: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload));
    this.send({
      type: "response",
      streamId,
      status,
      headers: {
        "content-type": "application/json",
        "content-length": String(body.length),
      },
    });
    this.sendBinary(encodeDataFrame(streamId, body));
    this.send({ type: "close", streamId });
  }
}

function tunnelError(error: unknown, prefix: string): Error {
  const message = `${prefix}：${error instanceof Error ? error.message : String(error)}`;
  const failure = new Error(message, { cause: error });
  (failure as Error & { code?: string }).code = /40[13]|unauthor|forbidden/iu.test(message)
    ? "device_token_rejected"
    : "device_connect_failed";
  return failure;
}

function tokenRejected(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "device_token_rejected";
}

export class HeadlessDeviceRuntime implements DeviceRuntimePort {
  private readonly app: CapyAppPort;
  private readonly store: SecretStorePort;
  private readonly clock: ClockPort;
  private readonly logger: LoggerPort | undefined;
  private readonly deviceName: string;
  /** 能力分级在构造时算一次（`MAGPIE_CAPY_MACHINE_TOOLS`），运行期不变。 */
  private readonly capability: MachineCapability;
  private readonly devices = new Map<string, HeadlessDevice>();
  private readonly inflight = new Map<string, Promise<DeviceInfo>>();

  constructor(options: {
    readonly app: CapyAppPort;
    readonly store: SecretStorePort;
    readonly clock: ClockPort;
    readonly logger?: LoggerPort;
    readonly deviceName?: string;
    readonly env?: Record<string, string | undefined>;
  }) {
    this.app = options.app;
    this.store = options.store;
    this.clock = options.clock;
    this.logger = options.logger;
    this.deviceName = options.deviceName?.trim() || defaultDeviceName();
    this.capability = machineCapabilityOf(options.env ?? process.env, (message) => {
      this.logger?.warn(message);
    });
    if (shouldWarnFull(this.capability)) {
      this.logger?.warn("MAGPIE_CAPY_MACHINE_TOOLS=full：设备会执行远端下发的任意 shell 命令");
    }
  }

  async ensure(session: AccountSession, signal?: AbortSignal): Promise<DeviceInfo> {
    const key = accountKey(session);
    const hit = this.inflight.get(key);
    if (hit) return await hit;
    const task = this.ensureOne(session, signal);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  /** 只读快照：不配对、不建连、不发网络请求（H-14(5)）。 */
  peek(session: AccountSession): DeviceInfo {
    const hit = this.devices.get(accountKey(session));
    if (hit) return hit.info;
    return { id: "", name: this.deviceName, connected: false };
  }

  close(): void {
    for (const device of this.devices.values()) device.close();
    this.devices.clear();
  }

  private async ensureOne(session: AccountSession, signal?: AbortSignal): Promise<DeviceInfo> {
    const key = accountKey(session);
    const existing = this.devices.get(key);
    if (existing) {
      try {
        await existing.ensure();
        return this.infoOf(existing);
      } catch {
        existing.close();
        this.devices.delete(key);
      }
    }

    const jwt = await this.app.sessionJwt(session.clerk, signal);
    let credential = await this.store.load(key);
    if (!credential || credential.orgId !== session.orgId) {
      const oldDeviceId = credential?.deviceId;
      credential = await this.pair(session, jwt, signal);
      this.noteReplacedDevice(oldDeviceId, credential.deviceId);
    } else if (credential.name !== this.deviceName) {
      try {
        await this.app.renameDevice(jwt, session.orgId, credential.deviceId, this.deviceName, signal);
        credential = { ...credential, name: this.deviceName };
        await this.store.save(key, credential);
      } catch (error) {
        this.logger?.warn("capy device rename failed", {
          deviceId: credential.deviceId,
          message: errorText(error),
        });
      }
    }

    let device: HeadlessDevice;
    try {
      device = await this.connect(credential, signal);
    } catch (error) {
      if (!tokenRejected(error)) throw error;
      const oldDeviceId = credential.deviceId;
      credential = await this.pair(session, jwt, signal);
      this.noteReplacedDevice(oldDeviceId, credential.deviceId);
      device = await this.connect(credential, signal);
    }
    const connected = await this.waitConnected(jwt, session.orgId, credential.deviceId, signal);
    if (!connected) {
      device.close();
      throw new CapyError("upstream_unavailable", "无头设备已连上隧道，但服务端没有标记 connected");
    }
    this.devices.set(key, device);
    return { id: credential.deviceId, name: credential.name, connected: true };
  }

  /** 重配对会留下旧设备（上游无删除接口）：打一条 warn，提示用户手动删除。 */
  private noteReplacedDevice(oldDeviceId: string | undefined, newDeviceId: string): void {
    if (!oldDeviceId || oldDeviceId === newDeviceId) return;
    this.logger?.warn("capy device replaced; delete the old device manually", { oldDeviceId, deviceId: newDeviceId });
  }

  private infoOf(device: HeadlessDevice): DeviceInfo {
    return device.info;
  }

  private async connect(credential: HeadlessCredential, signal?: AbortSignal): Promise<HeadlessDevice> {
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const device = new HeadlessDevice({
        credential,
        capability: this.capability,
        ...(this.logger ? { audit: (entry) => this.logger?.event("machine_audit", { ...entry }) } : {}),
      });
      try {
        await device.ensure();
        return device;
      } catch (error) {
        lastError = error;
        this.logger?.warn("capy device connect failed", {
          attempt,
          code: String((error as { code?: unknown } | null)?.code ?? ""),
          message: errorText(error),
        });
        device.close();
        if (tokenRejected(error) || attempt === 3) break;
        await this.clock.sleep(800 * attempt, signal);
      }
    }
    throw lastError instanceof Error
      ? lastError
      : new CapyError("upstream_unavailable", `无头设备连接失败：${String(lastError)}`);
  }

  private async pair(session: AccountSession, jwt: string, signal?: AbortSignal): Promise<HeadlessCredential> {
    const start = await this.app.startDeviceCode(jwt, {
      hostname: this.deviceName,
      os: deviceOs(),
      arch: deviceArch(),
    }, signal);
    try {
      await this.app.approveDeviceCode(jwt, session.orgId, start.userCode, this.deviceName, signal);
    } catch (error) {
      const hint = start.verificationUrl ? `；可在浏览器打开 ${start.verificationUrl} 手动批准` : "";
      throw new CapyError("device_pair_failed", `Capy 设备码自动批准失败：${errorText(error)}${hint}`);
    }
    for (let i = 0; i < 10; i += 1) {
      let poll;
      try {
        poll = await this.app.pollDeviceCode(jwt, start.deviceCode, signal);
      } catch (error) {
        if ((error as { status?: unknown } | null)?.status === 401) throw error;
        await this.clock.sleep(start.pollIntervalSeconds * 1000, signal);
        continue;
      }
      if (poll.status === "approved") {
        // 配对到了另一个组织就报错，不静默用对方的 orgId（M-16）。
        if (poll.enrolled.orgId && poll.enrolled.orgId !== session.orgId) {
          throw new CapyError(
            "device_pair_failed",
            `Capy 设备码配对到了另一个组织（${poll.enrolled.orgId}），与当前登录组织（${session.orgId}）不一致`,
          );
        }
        const credential: HeadlessCredential = {
          orgId: poll.enrolled.orgId || session.orgId,
          deviceId: poll.enrolled.deviceId,
          name: this.deviceName,
          token: poll.enrolled.token,
        };
        await this.store.save(accountKey(session), credential);
        return credential;
      }
      if (poll.status === "denied" || poll.status === "expired") {
        throw new CapyError("device_pair_failed", `Capy 设备码配对${poll.status === "denied" ? "被拒绝" : "已过期"}`);
      }
      await this.clock.sleep(start.pollIntervalSeconds * 1000, signal);
    }
    throw new CapyError("upstream_timeout", "等待 Capy 设备码批准超时");
  }

  private async waitConnected(
    jwt: string,
    orgId: string,
    deviceId: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const devices = await this.app.listDevices(jwt, orgId, signal).catch(() => []);
      const hit = devices.find((device) => device.id === deviceId);
      if (hit?.connected) return true;
      await this.clock.sleep(CONNECT_POLL_MS, signal);
    }
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
