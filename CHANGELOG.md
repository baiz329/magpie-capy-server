# CHANGELOG

## v0.3.1 — 2026-11-22

安全与正确性修复版本（八位专家对 v0.3 的融合审计，88 项，核实 79 真 / 8 部分真 / 1 无法确认 / 0 误报）。不是新功能版本。完整修复清单见 `spec/adr/013-v031-security-and-correctness-fixes.md`。

### 行为变更

- **机器 bash 默认关闭**：`MAGPIE_CAPY_MACHINE_TOOLS` 默认 `files`（只允许工作区内文件读写），`bash` 须显式设 `MAGPIE_CAPY_MACHINE_TOOLS=full` 并重启才可用。原来默认能用的机器 bash 在 0.3.1 默认不可用。
- 代理失败默认 fail-closed：代理连接失败时请求直接失败，不再静默直连；需直连兜底时显式设 `MAGPIE_CAPY_PROXY_FALLBACK=direct`。`MAGPIE_CAPY_PROXY=off` 真正禁用代理，不再继续读 `HTTPS_PROXY`。
- 附件下载不再走用户代理，用独立直连 fetch；单请求 ≤32 个 / ≤128 MiB（插件策略，不是 Capy 的限制）。

### 安全修复

- 文件 RPC 路径收敛：全部五个文件 handler 拒绝 `..`、根外绝对路径、UNC/`\\?\`、指向根外的符号链接；工作区根按 jamId 归属。
- 日志与错误出口统一脱敏（`capy_`/`capyd_`/`capydc_`/`sess_`/`__session=`/JWT/cookie/URL userinfo 等），代理标识只打印 `scheme://host:port`；禁止裸 `console.warn`。
- DPAPI 凭据改走 stdin 传递，不再拼进 PowerShell 命令行；PowerShell 用绝对路径，同步改异步。
- 设备 token：目录 0700、文件 0600、tmp 随机名、启动清理残留；首次保存打印一次 warn（非 Windows 明文存放，同机同用户进程可读）。

### 正确性修复

- 429 重试等待与单次尝试超时分离（网关 failover 不再被总超时吞掉）；上游 `Retry-After` 透传为响应 `retry-after` 头（仅上游给过时才带）。
- SSE 终态：只有收到 `done` 或 `run{phase:"end"}` 才算完成，否则报 `upstream_unavailable`；`turn dropped` 清空累积。
- 工具调用解析收窄：`tool_choice:"none"` 时不注入工具说明；只接受顶层 `{"tool_calls":[...]}`，工具名必须在本次白名单内；带 tools 的流式改前缀嗅探。
- `minimalUnsupported` 按账号隔离（`Map<accountKey, boolean>`），仅 variant 相关 403 才降级；JWT/refresh 加 single-flight；Clerk 错误按状态码分类，refresh 加会话校验。
- `edit` 的 `$&`/`$1` 替换语义、附件超时映射、取消传播、用量估算等一批中低问题修复。

### 文档与测试

- 文档与实现重新对齐：未实现的功能（outline 轮询、附件 fileId 缓存、7 类结构化事件、CapabilityRegistry/ModelPolicy、`MAGPIE_CAPY_TOOL_SHIM=0`）明确标“未实现（v0.3.1 不做）”；capture 取证引用改为“内部取证，未随仓库分发”；README 补能力矩阵、环境变量表与已知限制。
- 测试覆盖补齐：entry/plugin、dpapi、browser-login、local-login、magpie-auth 补负向用例；真实 bash 的 machine 用例显式超时 30s；`scripts/smoke.mjs` 加断言（2xx、文本非空、models 数 >0）。
- CI 明确不做；发布验收为本地人工跑 `bun test` + `bun run typecheck` + `bun run build`（见 `spec/ARCHITECTURE.md`）。

### 历史说明

- v0.2.2 / v0.2.3 的发布说明与提交历史存在出入（提交历史曾重建；见审计对照表 M-19，缺 Releases 页实时证据，无法逐项确认）。本文件自 v0.3.1 起以实际提交为准。
