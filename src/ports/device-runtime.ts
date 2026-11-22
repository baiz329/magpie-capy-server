import type { AccountSession } from "../domain/account.ts";
import type { DeviceInfo } from "./capy-app.ts";

export interface DeviceRuntimePort {
  /**
   * 确保当前账号有一台在线的无头设备。
   * 实现负责：加载/配对 credential、连接 tunnel、等待 connected。
   */
  ensure(session: AccountSession, signal?: AbortSignal): Promise<DeviceInfo>;
  /**
   * 只读：只看"本进程是否已连上"，绝不配对、不建连、不发网络请求。
   * 未连接时返回 `{ id: "", name: <配置设备名>, connected: false }`。
   */
  peek(session: AccountSession): DeviceInfo;
  close(): void;
}

export interface HeadlessCredential {
  readonly orgId: string;
  readonly deviceId: string;
  readonly name: string;
  readonly token: string;
}
