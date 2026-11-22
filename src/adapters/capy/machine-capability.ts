/**
 * 机器工具能力分级（S-02）。
 *
 * `MAGPIE_CAPY_MACHINE_TOOLS`：
 * - `off`   —— 仍然连接隧道（聊天需要 deviceId），但所有 machine handler 返回 `Unavailable`。
 * - `files` —— 默认档：只有文件类 handler，**永不执行外部进程**。
 * - `full`  —— 额外允许 `bash`（启动时 warn 一次）。
 *
 * `MAGPIE_CAPY_BASH` 只是解释器路径，授权只由本文件决定（避免两个开关语义重叠）。
 */

export type MachineCapability = "off" | "files" | "full";

export const DEFAULT_MACHINE_CAPABILITY: MachineCapability = "files";

export const MACHINE_TOOLS_ENV = "MAGPIE_CAPY_MACHINE_TOOLS";

/** 文件类 handler（五个文件 handler + worktree 管理）。 */
const FILE_HANDLERS: readonly string[] = [
  "worktree_ensure",
  "worktree_list",
  "read",
  "file_read",
  "write",
  "edit",
  "file_write",
];

/** 永远返回 `Unavailable`（未实现，不要给模型假成功）。 */
const UNIMPLEMENTED_HANDLERS: readonly string[] = ["bash_output", "volume_landed", "volume_probe"];

const FULL_ONLY_HANDLERS: readonly string[] = ["bash"];

export function machineCapabilityOf(
  env: Record<string, string | undefined>,
  onWarn?: (message: string) => void,
): MachineCapability {
  const raw = String(env[MACHINE_TOOLS_ENV] ?? "").trim().toLowerCase();
  if (!raw) return DEFAULT_MACHINE_CAPABILITY;
  if (raw === "off" || raw === "files" || raw === "full") return raw;
  onWarn?.(`${MACHINE_TOOLS_ENV}=${raw} 不是 off|files|full，按 ${DEFAULT_MACHINE_CAPABILITY} 处理`);
  return DEFAULT_MACHINE_CAPABILITY;
}

export function allowedHandlers(capability: MachineCapability): ReadonlySet<string> {
  if (capability === "off") return new Set<string>();
  if (capability === "files") return new Set<string>(FILE_HANDLERS);
  return new Set<string>([...FILE_HANDLERS, ...FULL_ONLY_HANDLERS]);
}

/**
 * 返回拒绝原因；`null` 表示允许执行。
 * `Unavailable` 与 `Refused` 的区别：前者是策略/未实现，后者是路径越界。
 */
export function refusalFor(handler: string, capability: MachineCapability): string | null {
  const name = String(handler ?? "").trim();
  if (!name) return unavailableMessage("unknown");
  if (UNIMPLEMENTED_HANDLERS.includes(name)) return unavailableMessage(name);
  if (capability === "off") {
    return `所有机器工具已禁用（${MACHINE_TOOLS_ENV}=off，重启后生效）`;
  }
  if (FULL_ONLY_HANDLERS.includes(name) && capability !== "full") {
    return `命令执行已禁用；需要时设 ${MACHINE_TOOLS_ENV}=full 并重启`;
  }
  if (!allowedHandlers(capability).has(name)) return unavailableMessage(name);
  return null;
}

function unavailableMessage(handler: string): string {
  return `无头设备未实现 ${handler}；浏览器/computer 等工具不会执行。`;
}

/** 启动时是否应该提醒"full 档会执行任意命令"。 */
export function shouldWarnFull(capability: MachineCapability): boolean {
  return capability === "full";
}
