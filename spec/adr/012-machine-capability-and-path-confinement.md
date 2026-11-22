# ADR-012 — machine 能力分级与路径隔离

## 状态

Accepted

## 背景

v0.3 的 machine RPC 有两处 P0 问题（2026-11-22 八位专家融合审计，逐条对源码核实后属实）：

- S-01：文件 handler 的 `resolveIn` 对绝对路径只做 `path.normalize`，相对路径 `resolve` 后无任何 containment 校验，`read`/`write`/`edit`/`file_read`/`file_write` 都能读写 worktree 外的任意文件。同一文件的 `worktree_ensure` 反而做了 base 前缀检查，说明作者知道要约束，只漏了文件 handler。
- S-02：`runBash` 用 `["-lc", command]`，继承全部 `process.env`，无开关、无白名单、无确认、无审计。`capyd_` token 是唯一门槛。

插件跑在用户本机 magpie 进程里，bash 与文件读写直通宿主。能力必须分级，默认关闭最危险的一档。

## 决策

- 新增 `MAGPIE_CAPY_MACHINE_TOOLS=off|files|full`，**默认 `files`**。
  - `off`：所有 machine handler（含文件）返回 `MachineServer.Unavailable`，但设备仍会连接（聊天需要 deviceId）。
  - `files`：允许工作区内文件读写，bash 不可用。
  - `full`：启用 bash，启动时打一条显式 warn。
- 路径根固定为 `worktreeBase`（默认 `~/.capy/worktrees`，可用 `MAGPIE_CAPY_WORKTREE_BASE` 覆盖）。`worktree_ensure` 只能在其下建目录。
- 所有文件 handler 走统一的 `confine(root, raw)`：
  - 拒绝空路径与 NUL；Windows 下拒绝 UNC/`\\?\`/盘符相对路径，统一大小写比较；
  - `realpath`（已存在）或父目录 `realpath`（新文件）+ `path.relative` 判定，不用 `startsWith`；
  - 逐段 lstat + realpath，防符号链接逃逸；
  - 越界返回 `MachineServer.Refused`。
- 文件 handler 的根优先用请求头 `x-capy-jam-id`/`x-capy-thread-id` 映射到的已注册 root（JamRootRegistry，TTL 30 分钟、容量 64 LRU），无归属时退回固定 base。`worktree_ensure` 的越界校验永远对固定 base。
- bash（仅 `full` 档）：
  - `-c` 取代 `-lc`，不加载 profile；
  - env 改白名单（只透传 26 个安全键，另有 key/token/secret/password/proxy 等 deny 正则）；
  - POSIX `detached` + 进程组 kill，Windows `taskkill /T`；
  - 每次执行写审计日志（命令摘要限 200 字符、耗时、退出码，不记 stdout）；
  - 非零退出码记 `isError: true`。
- 占位 handler：`bash_output`、`volume_*` 返回 `MachineServer.Unavailable`；`worktree_list` 真实现（列 base 下一级目录）；`git capture` 保留 `{repos: []}`，但 README 标注为占位。

## 后果

- 默认档位下原来能用的机器 bash 默认不可用，恢复须显式设 `MAGPIE_CAPY_MACHINE_TOOLS=full` 并重启。README、CHANGELOG 与启动 warn 都要写清楚。
- 路径穿越被 confine 挡在 base 内；符号链接逃逸也被逐段 realpath 挡住。
- `pair()` 自动批准链条本身未动（无用户确认开关、无显式 scope），危害面被收窄（默认无 bash），但链未断。README 能力矩阵写明该链，配对改需确认留待以后版本。
- ADR-003 的“终端/写文件不可用”边界已不成立，标为 Superseded by ADR-012。
