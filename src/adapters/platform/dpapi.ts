import { spawn } from "node:child_process";
import crypto from "node:crypto";

const V10_PREFIX = "v10";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const AES_KEY_BYTES = 32;
const DPAPI_TIMEOUT_MS = 15_000;

/**
 * PowerShell 绝对路径（P3-05）：不走 PATH 查找，避免 PATH 劫持。
 * Windows PowerShell 固定在 System32 下。
 */
export function powershellExecutable(env: Record<string, string | undefined> = process.env): string {
  const systemRoot = String(env.SystemRoot ?? "").trim() || "C:\\Windows";
  return `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/**
 * 用 stdin 传数据（H-06）：原来把 base64 直接拼进 `-Command` 参数，
 * 同机任何进程都能从进程列表/WMI 读到命令行，等于明文泄漏。
 *
 * 脚本本身用 `-EncodedCommand` 传（argv 里只有脚本，不含任何数据）；
 * 数据单独走 stdin，脚本从 `[Console]::In` 读。
 * `-ExecutionPolicy Bypass` 改为 `RemoteSigned`（P3-05）；
 * 同步 `execFileSync` 改为异步 `execFile`（P3-05），不阻塞事件循环。
 */
function powershell(script: string, stdin: string): Promise<string> {
  // -EncodedCommand 里只有脚本（不含任何数据）；数据单独走 stdin。
  const encodedScript = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn(
      powershellExecutable(),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "RemoteSigned", "-EncodedCommand", encodedScript],
      { windowsHide: true },
    );
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch {}
      reject(new Error("DPAPI timed out"));
    }, DPAPI_TIMEOUT_MS);
    timer.unref?.();
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`powershell exited ${String(code)}: ${stderr.slice(0, 200)}`));
    });
    try {
      child.stdin?.end(stdin);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

export async function dpapiUnprotect(blob: Uint8Array): Promise<Buffer> {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 可用");
  const encoded = Buffer.from(blob).toString("base64");
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$raw=[Console]::In.ReadToEnd().Trim()
$b=[Convert]::FromBase64String($raw)
$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($p)`;
  return Buffer.from(await powershell(script, encoded), "base64");
}

export async function dpapiProtect(text: string): Promise<string> {
  if (process.platform !== "win32") throw new Error("DPAPI 只在 Windows 可用");
  const encoded = Buffer.from(text, "utf8").toString("base64");
  const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$raw=[Console]::In.ReadToEnd().Trim()
$b=[Convert]::FromBase64String($raw)
$p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[Convert]::ToBase64String($p)`;
  return powershell(script, encoded);
}

/** Chromium "v10" + 12-byte nonce + AES-256-GCM ciphertext + 16-byte tag。 */
export function decryptChromiumAesGcm(ciphertextBase64: string, key: Uint8Array): string {
  const raw = Buffer.from(ciphertextBase64, "base64");
  if (raw.length < V10_PREFIX.length + NONCE_BYTES + TAG_BYTES) {
    throw new Error("ciphertext 长度异常");
  }
  if (raw.subarray(0, V10_PREFIX.length).toString("latin1") !== V10_PREFIX) {
    throw new Error("ciphertext 不是 v10 格式");
  }
  const nonce = raw.subarray(V10_PREFIX.length, V10_PREFIX.length + NONCE_BYTES);
  const body = raw.subarray(V10_PREFIX.length + NONCE_BYTES, raw.length - TAG_BYTES);
  const tag = raw.subarray(raw.length - TAG_BYTES);
  const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(key), nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8").trim();
}

export function coerceAesKey(value: unknown): Buffer {
  let key: Buffer | null = null;
  if (Buffer.isBuffer(value)) key = value;
  else if (ArrayBuffer.isView(value)) key = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (value instanceof ArrayBuffer) key = Buffer.from(value);
  else if (typeof value === "string" && /^[0-9a-fA-F]{64}$/u.test(value.trim())) {
    key = Buffer.from(value.trim(), "hex");
  }
  if (!key || key.length !== AES_KEY_BYTES) throw new Error("AES key 必须是 32 字节");
  return key;
}
