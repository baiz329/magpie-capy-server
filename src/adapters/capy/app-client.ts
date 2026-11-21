import { randomUUID } from "node:crypto";
import os from "node:os";

import type { ClerkSession } from "../../domain/account.ts";
import { CapyError, mapUpstream } from "../../domain/errors.ts";
import type {
  AccountProfile,
  CapyAppPort,
  CreateJamInput,
  DeviceCodePoll,
  DeviceCodeStart,
  DeviceInfo,
  JamCreated,
  JamDetail,
  JamEvent,
  Organization,
} from "../../ports/capy-app.ts";
import { MAX_429_RETRIES, requestJson, type Retry429Options } from "../platform/http.ts";
import { ClerkClient } from "./clerk-client.ts";
import { createDesktopVersionProbe, desktopUserAgent, type DesktopVersionProbe } from "./client-version.ts";
import { CAPY_APP, clientHeaders } from "./endpoints.ts";

function deviceOs(): string {
  if (process.platform === "win32") return "win32";
  if (process.platform === "darwin") return "darwin";
  return "linux";
}

function deviceArch(): string {
  return process.arch === "arm64" ? "arm64" : "x86_64";
}

export class CapyAppClient implements CapyAppPort {
  private readonly fetchImpl: typeof fetch;
  private readonly clerk: ClerkClient;
  private readonly versionProbe: DesktopVersionProbe;

  constructor(fetchImpl: typeof fetch = fetch, clerk = new ClerkClient(fetchImpl), versionProbe?: DesktopVersionProbe) {
    this.fetchImpl = fetchImpl;
    this.clerk = clerk;
    // 不传则用同一 fetch 建一个默认探测器（缓存 24h，失败回退 0.9.2）。
    this.versionProbe = versionProbe ?? createDesktopVersionProbe({ fetchImpl });
  }

  async sessionJwt(clerk: ClerkSession, signal?: AbortSignal): Promise<string> {
    return this.clerk.sessionJwt(clerk, signal);
  }

  async me(jwt: string, signal?: AbortSignal): Promise<AccountProfile> {
    const body = await this.json(jwt, "/me", { method: "GET", ...(signal ? { signal } : {}) });
    const record = body as Record<string, unknown>;
    const preferences = record.preferences;
    return {
      id: String(record.id ?? ""),
      ...(typeof record.email === "string" ? { email: record.email } : {}),
      ...(typeof record.firstName === "string" ? { firstName: record.firstName } : {}),
      ...(typeof record.lastName === "string" ? { lastName: record.lastName } : {}),
      ...(preferences && typeof preferences === "object" && !Array.isArray(preferences)
        && typeof (preferences as Record<string, unknown>).preferredOrgId === "string"
        ? { preferredOrgId: String((preferences as Record<string, unknown>).preferredOrgId) }
        : {}),
    };
  }

  async organizations(jwt: string, signal?: AbortSignal): Promise<readonly Organization[]> {
    const body = await this.json(jwt, "/organizations", { method: "GET", ...(signal ? { signal } : {}) });
    const list = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)
        ? (body as { items: unknown[] }).items
        : [];
    return list.flatMap((item): Organization[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      if (!id) return [];
      return [{ id, ...(typeof record.name === "string" ? { name: record.name } : {}) }];
    });
  }

  async mintApiKey(
    jwt: string,
    orgId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<{ plaintext: string; keyId?: string }> {
    const body = await this.json(jwt, `/orgs/${encodeURIComponent(orgId)}/api-keys`, {
      method: "POST",
      body: JSON.stringify({ name }),
      ...(signal ? { signal } : {}),
    });
    const record = body as Record<string, unknown>;
    const key = record.key;
    const plaintext = typeof record.plaintext === "string" ? record.plaintext.trim() : "";
    if (!plaintext.startsWith("capy_")) {
      throw new CapyError("upstream_error", "Capy 没有返回 API Key 明文");
    }
    return {
      plaintext,
      ...(key && typeof key === "object" && !Array.isArray(key)
        && typeof (key as Record<string, unknown>).id === "string"
        ? { keyId: String((key as Record<string, unknown>).id) }
        : {}),
    };
  }

  async listDevices(jwt: string, orgId: string, signal?: AbortSignal): Promise<readonly DeviceInfo[]> {
    const body = await this.json(jwt, `/orgs/${encodeURIComponent(orgId)}/devices`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    });
    const list = Array.isArray(body)
      ? body
      : body && typeof body === "object" && Array.isArray((body as { items?: unknown }).items)
        ? (body as { items: unknown[] }).items
        : [];
    return list.flatMap((item): DeviceInfo[] => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const id = typeof record.id === "string" ? record.id : "";
      if (!id) return [];
      return [{
        id,
        name: typeof record.name === "string" ? record.name : "",
        connected: record.connected === true,
      }];
    });
  }

  async renameDevice(
    jwt: string,
    orgId: string,
    deviceId: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(
      jwt,
      `/orgs/${encodeURIComponent(orgId)}/devices/${encodeURIComponent(deviceId)}`,
      { method: "PATCH", body: JSON.stringify({ name }), ...(signal ? { signal } : {}) },
    );
  }

  async startDeviceCode(
    jwt: string,
    input: { hostname: string; os: string; arch: string },
    signal?: AbortSignal,
  ): Promise<DeviceCodeStart> {
    const body = await this.json(jwt, "/devices/code", {
      method: "POST",
      body: JSON.stringify({
        hostname: input.hostname || os.hostname(),
        os: input.os || deviceOs(),
        arch: input.arch || deviceArch(),
      }),
      ...(signal ? { signal } : {}),
    });
    const record = body as Record<string, unknown>;
    const userCode = String(record.userCode ?? "").trim();
    const deviceCode = String(record.deviceCode ?? "").trim();
    if (!userCode || !deviceCode) {
      throw new CapyError("upstream_error", "Capy 设备码接口没有返回 userCode/deviceCode");
    }
    return {
      userCode,
      deviceCode,
      verificationUrl: typeof record.verificationUrl === "string" ? record.verificationUrl : "",
      expiresInSeconds: Number(record.expiresInSeconds) || 300,
      pollIntervalSeconds: Math.max(1, Number(record.pollIntervalSeconds) || 5),
    };
  }

  async approveDeviceCode(
    jwt: string,
    orgId: string,
    userCode: string,
    name: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.json(jwt, `/orgs/${encodeURIComponent(orgId)}/devices/code/approve`, {
      method: "POST",
      body: JSON.stringify({ userCode, name }),
      ...(signal ? { signal } : {}),
    });
  }

  async pollDeviceCode(jwt: string, deviceCode: string, signal?: AbortSignal): Promise<DeviceCodePoll> {
    const body = await this.json(jwt, "/devices/code/poll", {
      method: "POST",
      body: JSON.stringify({ deviceCode }),
      ...(signal ? { signal } : {}),
    });
    const record = body as Record<string, unknown>;
    const status = String(record.status ?? "");
    if (status === "pending" || status === "slow_down") return { status };
    if (status === "denied" || status === "expired") return { status };
    if (status === "approved") {
      const enrolled = record.enrolled;
      if (!enrolled || typeof enrolled !== "object" || Array.isArray(enrolled)) {
        throw new CapyError("upstream_error", "Capy 设备码批准了，但没有 enrolled");
      }
      const e = enrolled as Record<string, unknown>;
      const device = e.device;
      const deviceId = device && typeof device === "object" && !Array.isArray(device)
        ? String((device as Record<string, unknown>).id ?? "")
        : "";
      const token = String(e.token ?? "").trim();
      if (!deviceId || !token.startsWith("capyd_")) {
        throw new CapyError("upstream_error", "Capy 设备码批准了，但没有 deviceId/token");
      }
      return {
        status,
        enrolled: {
          orgId: String(e.orgId ?? ""),
          deviceId,
          name: device && typeof device === "object" && !Array.isArray(device)
            ? String((device as Record<string, unknown>).name ?? "")
            : "",
          token,
        },
      };
    }
    return { status: "pending" };
  }

  async createJam(
    jwt: string,
    orgId: string,
    input: CreateJamInput,
    signal?: AbortSignal,
  ): Promise<JamCreated> {
    // 真实桌面端建对话请求的线上格式（2026-11-21 抓包，
    // spec/capture/desktop-create-jam-2026-11-21.json；app.har entry 0）。
    // 16 个字段按线上顺序发送，无值字段显式为 null（不省略）。
    // clientKey 是独立 UUID（与 ULID 的 requestId 不同）；requestId 保持 ULID。
    // 入参的 clientKey 不直接上网：调用方目前传的是 requestId 的复用值，
    // 与真实客户端不符，这里按真实协议每次生成一个新 UUID。
    // （后续应用层改用 ids.uuid() 生成 clientKey 后，这里可改回直接用入参。）
    const body = await this.json(jwt, `/orgs/${encodeURIComponent(orgId)}/jams`, {
      method: "POST",
      body: JSON.stringify({
        jamId: input.jamId,
        requestId: input.requestId,
        title: null,
        message: input.message,
        model: {
          modelId: input.modelId,
          reasoningMode: input.reasoningMode ?? null,
          modes: null,
        },
        mentions: null,
        files: input.files && input.files.length > 0 ? input.files : null,
        clientKey: randomUUID(),
        machineSize: null,
        device: {
          deviceId: input.deviceId,
          workspace: { kind: "worktree" },
        },
        branches: null,
        environmentVariables: null,
        slackChannelId: null,
        promptVariant: input.promptVariant ?? null,
        personal: null,
        memberIds: null,
      }),
      ...(signal ? { signal } : {}),
    }, input.ads ? { "x-capy-client-features": "message-edit,visual,ads-models" } : {}, { maxRetries: MAX_429_RETRIES });
    const record = body as Record<string, unknown>;
    const id = String(record.id ?? "").trim();
    if (!id) throw new CapyError("upstream_error", "Capy 创建线程没有返回 id");
    const machine = record.primaryMachine;
    const kind = machine && typeof machine === "object" && !Array.isArray(machine)
      ? String((machine as Record<string, unknown>).kind ?? "")
      : "";
    return {
      id,
      primaryMachine: {
        kind: kind === "cloud" ? "cloud" : "device",
        ...(machine && typeof machine === "object" && !Array.isArray(machine)
          && typeof (machine as Record<string, unknown>).name === "string"
          ? { name: String((machine as Record<string, unknown>).name) }
          : {}),
      },
      ...(record.ask === null || record.ask && typeof record.ask === "object" ? { ask: record.ask as NonNullable<JamCreated["ask"]> } : {}),
      ...(record.modelDefault && typeof record.modelDefault === "object"
        ? { modelDefault: record.modelDefault as NonNullable<JamCreated["modelDefault"]> }
        : {}),
    };
  }

  async getJam(jwt: string, orgId: string, jamId: string, signal?: AbortSignal): Promise<JamDetail> {
    const body = await this.json(jwt, `/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(jamId)}`, {
      method: "GET",
      ...(signal ? { signal } : {}),
    }, {}, { maxRetries: MAX_429_RETRIES });
    const record = body as Record<string, unknown>;
    return {
      id: String(record.id ?? jamId),
      status: String(record.status ?? ""),
      ...(record.ask === null || record.ask && typeof record.ask === "object" ? { ask: record.ask as NonNullable<JamDetail["ask"]> } : {}),
    };
  }

  async getJamEvents(
    jwt: string,
    orgId: string,
    jamId: string,
    signal?: AbortSignal,
  ): Promise<readonly JamEvent[]> {
    const body = await this.json(
      jwt,
      `/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(jamId)}/events?limit=50`,
      { method: "GET", ...(signal ? { signal } : {}) },
      {},
      { maxRetries: MAX_429_RETRIES },
    );
    const record = body as { items?: unknown };
    const items = Array.isArray(record.items) ? record.items : [];
    return items.flatMap((item): JamEvent[] => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const value = item as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id : "";
      const kind = typeof value.kind === "string" ? value.kind : "";
      if (!id || !kind) return [];
      const payload = value.payload && typeof value.payload === "object" && !Array.isArray(value.payload)
        ? value.payload as Record<string, unknown>
        : {};
      return [{
        id,
        kind,
        ...(typeof value.state === "string" ? { state: value.state } : {}),
        payload: {
          ...(typeof payload.code === "string" ? { code: payload.code } : {}),
          ...(typeof payload.message === "string" ? { message: payload.message } : {}),
          ...(typeof payload.retryable === "boolean" ? { retryable: payload.retryable } : {}),
        },
      }];
    });
  }

  async interruptJam(jwt: string, orgId: string, jamId: string, signal?: AbortSignal): Promise<void> {
    await this.json(jwt, `/orgs/${encodeURIComponent(orgId)}/jams/${encodeURIComponent(jamId)}/interrupt`, {
      method: "POST",
      body: "{}",
      ...(signal ? { signal } : {}),
    }, {}, { maxRetries: MAX_429_RETRIES });
  }

  private async json(
    jwt: string,
    route: string,
    init: RequestInit & { signal?: AbortSignal },
    extraHeaders: Record<string, string> = {},
    // 只对幂等操作传：429 有界重试（最多 2 次，尊重 Retry-After）。
    // mintApiKey / startDeviceCode / approveDeviceCode 不传（每次调用都
    // 产生新资源，重试会遗留孤儿 key/设备码）。
    retry?: Retry429Options,
  ): Promise<unknown> {
    // 每次请求前取一次当前桌面版本（命中缓存时立即返回，不产生请求）。
    const version = await this.versionProbe.currentVersion();
    const { response, body, text } = await requestJson(
      this.fetchImpl,
      `${CAPY_APP}${route}`,
      {
        ...init,
        headers: clientHeaders(jwt, "", extraHeaders, desktopUserAgent(version)),
      },
      30_000,
      retry,
    );
    if (!response.ok) throw mapUpstream(response.status, body, text.slice(0, 300));
    return body;
  }
}

