# ADR-013 — v0.3.1 安全与正确性修复

## 状态

Accepted

## 背景

2026-11-22，八位专家对 v0.3（commit 81e20dd）的融合审计：2 严重 + 14 高 + 25 中 + 22 低 + 21 文档 + 8 测试门禁，共 88 项。逐条对 v0.3 源码核实后 79 项属实、8 项部分属实、1 项无法确认、0 误报。v0.3.1 按核实结果修复；修复方另有一份 0.31 修复尝试，其裁定单约 10 处主张与代码不符（见对照表文末清单），只当参考，不当事实。

## 决策

### 1. 路径与能力（ADR-012）

见 ADR-012：`MAGPIE_CAPY_MACHINE_TOOLS` 默认 `files`；`confine(root, raw)` 接入全部五个文件 handler；bash 仅 `full` 档可用。

### 2. SSRF 防护（H-01、M-12）

- 附件下载走 guarded fetch：`redirect: "manual"` 逐跳（≤3）重校验；`dns.lookup(all)`，任一解析结果落入禁段即拒（loopback/私网/链路本地/CGNAT 100.64/10/保留段/组播/`::ffff:` 映射/ULA）；端口限 80/443；拒绝带 userinfo 的 URL；附件下载**不走用户代理**，用独立直连 fetch；15s 超时；流式累计字节上限（32 个/128 MiB，插件策略）。
- 预签名 PUT 同样 guarded：必须 `https`，端口 443，60s 超时，`redirect: "manual"`。
- IP 固定连接（DNS 校验与实际连接之间防 rebinding）若工期允许也做，做不了就写进 README 已知限制。

### 3. 日志与错误脱敏（H-02、H-03、H-04、P3-04）

- 新增 `describeProxy`，只输出 `scheme://host:port`；所有日志走 `LoggerPort`，经 redact；禁止裸 `console.warn`。
- 代理失败默认 **fail-closed**（`MAGPIE_CAPY_PROXY_FALLBACK=direct` 才允许直连）；`MAGPIE_CAPY_PROXY=off` 真正禁用，不再继续读 `HTTPS_PROXY`。
- `toOpenAiError` 出口统一 `redact(message)`；usage/login 失败回调也走 redact；上游原文只进 `detail`（不外发）。
- redact 补 `sess_`、`__session=`、`(sessionId|sid)=`、URL userinfo、`sk-`/`ghp_`/`AIza`、`capydc_`、预签名 URL 参数；`redactFields` 递归 + 键名黑名单 + 超长值截断。

### 4. Token 存储（H-05）

目录 0700 + 文件 0600 + 显式 chmod；tmp 名加随机；启动清理残留 `*.tmp`；首次保存打印一次 warn，说明“本机同用户进程可读”。系统密钥环不做（零依赖约束），写入 README 已知限制。

### 5. DPAPI（H-06、P3-05）

stdin 传数据（脚本从 `[Console]::In` 读），命令行不再含任何数据。PATH 改绝对路径、`-ExecutionPolicy Bypass` 改掉、同步改异步三项能修的修，修不了的写进已知限制。

### 6. 流与超时（H-07、H-10、H-11、M-10、M-11）

- 单流 ≤32MB；并发流 ≤16；open 后 60s 未完成强制清理；`Buffer.concat` 改 chunks 数组累加。
- `read`/`file_read` 先 `stat`，>8MB 返回 `{kind: "too-large"}`；`file_write` 的 baseSha 用流式 hash。
- SSE 终态：normalizer 记录 `sawDone`；`finish()` 仅在 sawDone 时产出 final+done，否则产出 `error(upstream_unavailable, "上游流在完成前中断")`；turn dropped 清空累积；run end 计完成。
- 429 重试等待与总超时分离：单次尝试有自己的超时，重试等待不被总 timer 吞掉；上游 `Retry-After` 存进 `CapyError.retryAfterMs`，并透传为响应头。`requestJson` 的 `text()` 移进 catch，abort 映射为 `upstream_timeout`（504）。SSE 读取循环加空闲 deadline；PUT 超时错误同理映射。
- 取消传播：`encodeChatStream` 改 `pull()` 逐事件拉取，实现 `cancel()`；abort 监听在 `finally` 移除；`chat.stream()` 加 finally（失败/取消都 interruptJam）。

### 7. 工具桥与提示词（H-08、H-12、M-13）

- `tool_choice: "none"` 时完全不注入工具说明、不解析。
- 只接受顶层 `{"tool_calls": [...]}`（允许一层 code fence）；`name` 必须在本次 tools 白名单内；删除“扫全文平衡对象”兜底（或仅当全文唯一对象且含 name+arguments 时接受）；O(n) 扫描。
- 带 tools 且 stream=true 时改前缀嗅探：缓冲到首个非空白字符；不是 `{` 立即转流式透传；是 `{` 最多缓冲 64KB 尝试解析，超限或流结束仍不成立则按普通文本流式输出。
- `buildPrompt` 改随机 nonce 分隔符（`<<<CAPY:<uuid>:SYSTEM>>>` 形式，无闭合标签），分隔符由应用层用 `ids.uuid()` 生成；内容里若出现分隔符则替换；工具名走白名单；toolInstruction 也转义。

### 8. 状态隔离与会话（H-13、H-14、M-05、M-08）

- `minimalUnsupported` 改 `Map<accountKey, boolean>`；仅当 403 且 detail 含 `promptVariant`/`variant` 时才降级。
- 删除全局 `activeRoot`，改 jamId→root 注册（见 ADR-012）。
- JWT 缓存加 single-flight（按 key 去重），命中过期即 delete；MemoryCache 上限 128 条 + 过期清扫；缓存键改密钥哈希或账号 ID，不用 API key 尾 16 位。
- refresh 加 single-flight（按 accountKey），返回完整 `authRecordOf(session)`；记录 `keyId`（上游返回则有）；README 明确“每次重登录/换 key 会在账号里留下同名 key，需手动清理”。不上游删除接口（未知契约）。
- `usage()` 只用 `peek`（只读已连接状态），未连接显示“未连接（点击对话后自动连接）”。
- `ChatRunOptions` 增加 `modelId`；入口把 `resolveModelId` 结果传入，`createJam` 与 `isAdsModel` 都用它；多候选报 `model_not_found` 并附候选。
- UA 探测失败写 5 分钟负缓存；单次超时 1.5s；失败打印一次 warn。
- Clerk 错误按状态码分类（429/5xx 不映射 401）；refresh 增加一次 Clerk 会话有效性校验。
- `magpie-auth` 的 uid 回退改显式“取第一个非空字符串”，`source` 从 metadata 读回；accountId 用 `sha256(access).slice(0, 8)` 代替 `access.slice(-8)`。

### 9. 端口变更

- `DeviceRuntimePort` 增加 `peek(session)`（只读已连接状态，绝不配对/建连/发请求）。
- `ToolBridgePort.parse(text, allowedNames)`。
- `ChatRunOptions.modelId`。
- `collectAttachments(directFetch)`（附件下载用独立直连 fetch）。

### 10. 明确不做

- TLS pinning 本身（README 增加“不要在不可信网络/根证书环境使用”提示）。
- 系统密钥环（零依赖约束）。
- CI（本地产物已用命令验收）。
- 插件侧令牌桶（宿主已有 `maxConcurrency`；README 提示）。
- `force-minimal` 档位（文档写明 `"minimal"` 等同 `"auto"`）。
- 每轮新建 jam 的结构（上游无同 jam 追加消息的可用契约；加 1,000,000 字符本地 prompt 上限，README 写明“每轮都是新会话”）。
- M-19 历史记录（代码层面无修复）。

## 后果

- 默认档位变化（ADR-012）：机器 bash 默认不可用，恢复须显式 opt-in。
- `pair()` 自动批准链条本身未动，危害面被收窄；README 能力矩阵写明该链。
- 429 透传恢复：网关 failover（ADR-010）不再被总超时吞掉；`retry-after` 响应头只在上游给过时才发出。
- 测试文件 17→27，新增的安全负向用例必须能在旧行为下失败、新行为下通过。
- dist 重新构建并提交；版本号 0.3.0 → 0.3.1。
