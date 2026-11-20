import type { AccountSession } from "../domain/account.ts";
import { accountKey } from "../domain/account.ts";
import type { DeviceInfo } from "../ports/capy-app.ts";
import type { DeviceRuntimePort } from "../ports/device-runtime.ts";

/**
 * 每账号 single-flight：并发请求只 ensure 一次。
 * 失败后清掉 inflight，下一次请求可重试。
 */
export class DeviceUseCase {
  private readonly runtime: DeviceRuntimePort;
  private readonly inflight = new Map<string, Promise<DeviceInfo>>();

  constructor(runtime: DeviceRuntimePort) {
    this.runtime = runtime;
  }

  async ensure(session: AccountSession, signal?: AbortSignal): Promise<DeviceInfo> {
    const key = accountKey(session);
    const hit = this.inflight.get(key);
    if (hit) return await hit;
    const task = this.runtime.ensure(session, signal);
    this.inflight.set(key, task);
    try {
      return await task;
    } finally {
      this.inflight.delete(key);
    }
  }

  close(): void {
    this.inflight.clear();
    this.runtime.close();
  }
}
