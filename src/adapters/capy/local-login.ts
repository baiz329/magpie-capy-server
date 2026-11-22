import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { CapyError } from "../../domain/errors.ts";
import type { LoginCredential } from "../../ports/login.ts";
import { coerceAesKey, decryptChromiumAesGcm, dpapiUnprotect } from "../platform/dpapi.ts";

const DPAPI_PREFIX = "DPAPI";

function capyDir(): string {
  const appData = String(process.env.APPDATA ?? "").trim();
  return path.join(appData || path.join(os.homedir(), "AppData", "Roaming"), "Capy");
}

function readJson(file: string, label: string): Record<string, unknown> {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new CapyError("sign_in_required", `未找到 Capy 的 ${label}，请先在 Capy 桌面端登录`);
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new CapyError("invalid_request", `Capy 的 ${label} 不是有效 JSON`);
  }
}

/** 可选文件：缺失/损坏都不算失败（M-06：device-credentials.json 降级为可选）。 */
function readOptionalJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function jwtPayload(token: string): Record<string, unknown> {
  const part = token.split(".")[1];
  if (!part) throw new CapyError("sign_in_required", "Capy 登录凭据不是有效 JWT");
  try {
    const value: unknown = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value as Record<string, unknown>;
  } catch {
    throw new CapyError("sign_in_required", "Capy 登录凭据的 JWT payload 无法解析");
  }
}

/** 只读 `%APPDATA%\\Capy` 的登录态；不启动 Capy，也不碰设备 token。 */
export async function readCapyInstall(dir = capyDir()): Promise<LoginCredential> {
  if (process.platform !== "win32") {
    throw new CapyError(
      "invalid_request",
      "本机导入只支持 Windows（Capy 本地凭据用 DPAPI 加密）；请用浏览器登录",
    );
  }

  const session = readJson(path.join(dir, "session-credential.json"), "session-credential.json");
  const localState = readJson(path.join(dir, "Local State"), "Local State");
  // device-credentials.json 只用来提供 org 提示，缺失不影响登录（M-06）。
  const device = readOptionalJson(path.join(dir, "device-credentials.json"));

  const sessionId = stringOf(session.sessionId);
  const userId = stringOf(session.userId);
  const ciphertext = stringOf(session.ciphertext);
  if (!sessionId || !userId || !ciphertext) {
    throw new CapyError("invalid_request", "Capy 的 session-credential.json 缺少字段");
  }

  // 多组织时**不猜**（交给 pickOrg 用 /app/me 的偏好）；只有唯一组织才提示（M-06）。
  let orgId = "";
  const orgs = device?.orgs;
  if (orgs && typeof orgs === "object" && !Array.isArray(orgs)) {
    const keys = Object.keys(orgs as Record<string, unknown>);
    if (keys.length === 1) orgId = keys[0] ?? "";
  }

  const osCrypt = localState.os_crypt;
  const encryptedKey = osCrypt && typeof osCrypt === "object" && !Array.isArray(osCrypt)
    ? stringOf((osCrypt as Record<string, unknown>).encrypted_key)
    : "";
  if (!encryptedKey) {
    throw new CapyError("invalid_request", "Capy 的 Local State 缺少 os_crypt.encrypted_key");
  }
  const raw = Buffer.from(encryptedKey, "base64");
  if (raw.subarray(0, DPAPI_PREFIX.length).toString("latin1") !== DPAPI_PREFIX) {
    throw new CapyError("invalid_request", "Capy 的本地密钥不是 DPAPI 格式");
  }

  let clientJwt = "";
  try {
    const key = coerceAesKey(await dpapiUnprotect(raw.subarray(DPAPI_PREFIX.length)));
    clientJwt = decryptChromiumAesGcm(ciphertext, key);
  } catch (error) {
    throw new CapyError(
      "sign_in_required",
      "无法解密 Capy 本地登录态，请确认当前 Windows 用户就是登录 Capy 的用户，或重新登录",
      { cause: error },
    );
  }

  const claims = jwtPayload(clientJwt);
  // clientId 没有就留空，不再硬失败（M-07：clientId 采集后不用，
  // 不值得为它拒绝一次本来有效的登录；LoginCredential.clientId 也是可选的）。
  const clientId = stringOf(claims.id);

  return {
    clientJwt,
    sessionId,
    userId,
    clientId,
    ...(orgId ? { orgId } : {}),
    source: "local",
  };
}
