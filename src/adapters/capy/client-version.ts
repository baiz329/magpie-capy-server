/**
 * Capy 桌面端版本探测：UA 里的 Capy/x.y.z 只从这里来。
 *
 * 来源：Capy 官网下载页 https://capy.ai/download（实测 2026-11-21：
 * 页面含 "Version 0.9.2"，macOS/Windows/Linux 三处一致）。
 * 曾试过的 electron-updater 源（releases.capy.ai / updates.capy.ai /
 * capy.ai/api/updates / download.capy.ai 的 latest.yml）全部 404，
 * 所以下载页是唯一可靠来源。
 *
 * 诚实边界：下载页只公布 Capy 自身版本号，不公布内嵌的 Chrome /
 * Electron 版本，所以 UA 里 Chrome/Electron 段只能人工验证，不会自动
 * 刷新。下面两个常量是 2026-11-21 从真实桌面端抓包核实的
 * （2026-11-21 内部取证，未随仓库分发），
 * 只有 Capy/ 段会随探测刷新。
 */

/** Capy 桌面端下载页（版本唯一可靠来源）。 */
export const CAPY_DOWNLOAD_URL = "https://capy.ai/download";
/** 探测失败时的回退版本（2026-11-21 在下载页实测）。 */
export const FALLBACK_DESKTOP_VERSION = "0.9.2";
/** 内嵌 Chrome 版本：人工验证值（2026-11-21 真实桌面端抓包），不自动刷新。 */
export const DESKTOP_CHROME_VERSION = "156.0.8078.80";
/** 内嵌 Electron 版本：人工验证值（2026-11-21 真实桌面端抓包），不自动刷新。 */
export const DESKTOP_ELECTRON_VERSION = "45.2.3";
/** 探测结果缓存时长（24h）：桌面版本不会频繁变，没必要每次请求都查。 */
export const DEFAULT_VERSION_TTL_MS = 24 * 60 * 60 * 1000;
/** 单次探测超时（H-14(4)）：1.5s 足够，别让版本探测拖住一次聊天请求。 */
export const DEFAULT_VERSION_TIMEOUT_MS = 1_500;
/** 探测失败后的负缓存时长：5 分钟内不再发请求（H-14(4)）。 */
export const VERSION_FAILURE_TTL_MS = 5 * 60 * 1000;

const VERSION_RE = /Version\s+(\d+\.\d+\.\d+)/;

/** 从下载页 HTML 提取桌面版本号；没有则返回 null。 */
export function parseDesktopVersion(html: string): string | null {
  const match = VERSION_RE.exec(html);
  const version = match?.[1];
  return version ? version : null;
}

/** 按给定 Capy 版本拼桌面 UA；Chrome/Electron 段是人工验证常量，不自动刷新。 */
export function desktopUserAgent(version: string): string {
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Capy/${version} Chrome/${DESKTOP_CHROME_VERSION} Electron/${DESKTOP_ELECTRON_VERSION} Safari/537.36`;
}

/**
 * 桌面端 sec-ch-ua：Chromium 主版本号与内嵌 Chrome 一致
 * （2026-11-21 真实桌面端抓包：`"Not:A-Brand";v="8", "Chromium";v="156"`）。
 */
export function desktopSecChUa(): string {
  const major = DESKTOP_CHROME_VERSION.split(".")[0] ?? "";
  return `"Not:A-Brand";v="8", "Chromium";v="${major}"`;
}

export interface DesktopVersionProbe {
  /** 当前桌面版本号：缓存命中直接返回；否则探测一次，失败回退。 */
  currentVersion(): Promise<string>;
}

export interface DesktopVersionProbeOptions {
  readonly fetchImpl?: typeof fetch;
  readonly downloadUrl?: string;
  readonly ttlMs?: number;
  readonly timeoutMs?: number;
  /** 注入时钟（测试用），默认 Date.now。 */
  readonly now?: () => number;
  /** 失败时只提示一次（可选注入，不裸打 console）。 */
  readonly onWarn?: (message: string) => void;
}

/**
 * 桌面版本探测器（adapter 内部接口，不进 ports/，不改端口契约）。
 * 内存缓存 + TTL；并发调用共享同一次探测；任何失败都回退到
 * 已缓存版本或 FALLBACK_DESKTOP_VERSION，永不抛错。
 */
export function createDesktopVersionProbe(options: DesktopVersionProbeOptions = {}): DesktopVersionProbe {
  const fetchImpl = options.fetchImpl ?? fetch;
  const downloadUrl = options.downloadUrl ?? CAPY_DOWNLOAD_URL;
  const ttlMs = options.ttlMs ?? DEFAULT_VERSION_TTL_MS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let cached: { version: string; atMs: number } | null = null;
  let inFlight: Promise<string> | null = null;
  /** 失败负缓存：期间不再发请求，直接用旧版本/回退值。 */
  let negativeUntil = 0;
  let warned = false;

  function fallbackVersion(): string {
    return cached?.version ?? FALLBACK_DESKTOP_VERSION;
  }

  function noteFailure(reason: string): void {
    negativeUntil = now() + VERSION_FAILURE_TTL_MS;
    if (warned) return;
    warned = true;
    try {
      options.onWarn?.(`Capy 桌面版本探测失败，回退 ${fallbackVersion()}：${reason}`);
    } catch {
      // 日志失败不能影响探测
    }
  }

  async function probe(): Promise<string> {
    const controller = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    // 超时兜底用 race，不只依赖 AbortSignal：有的 fetch 实现会忽略 signal，
    // 只靠 controller.abort() 仍可能一直挂住。
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new DOMException("Timed out", "TimeoutError"));
      }, Math.max(1, timeoutMs));
    });
    try {
      const response = await Promise.race([
        fetchImpl(downloadUrl, { signal: controller.signal }),
        timeout,
      ]);
      if (!response.ok) {
        noteFailure(`HTTP ${response.status}`);
        return fallbackVersion();
      }
      const html = await response.text();
      const version = parseDesktopVersion(html);
      if (!version) {
        noteFailure("下载页没有版本号");
        return fallbackVersion();
      }
      cached = { version, atMs: now() };
      negativeUntil = 0;
      return version;
    } catch (error) {
      noteFailure(error instanceof Error ? error.message : String(error));
      return fallbackVersion();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    async currentVersion(): Promise<string> {
      if (cached && now() - cached.atMs < ttlMs) return cached.version;
      if (now() < negativeUntil) return fallbackVersion();
      if (inFlight) return inFlight;
      inFlight = probe();
      try {
        return await inFlight;
      } finally {
        inFlight = null;
      }
    },
  };
}
