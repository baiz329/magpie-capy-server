# ADR-010 — 多账号轮换归网关所有，插件只负责干净的 429/401

## 状态

Accepted

## 背景

v0.2.3 之前，插件在单个 Capy 账号上跑：一个账号被限流（429）或登录失效（401），整条请求就失败。Antigravity Tools 的做法是在网关内做多账号轮换（429/401 时毫秒级切下一个账号重试，403 的账号标记跳过），我们想借鉴。但在动手之前必须先核实：Magpie 的 Provider 插件支不支持多账号、账号怎么选/切换——如果插件侧根本看不到多个账号，插件内轮换就是写不出来的功能。

核实方法：读本地 Magpie 源码（`internal/plugin/host.js`、`internal/gateway/routing.go`、`internal/gateway/fallback.go`、`internal/gateway/plugin_failover_test.go`、`internal/provider/plugins.go`），并对照 grokboot/magpie-capy 的 README 说明（“Magpie 可保存多个账号，但工具调用没有账号选择器”）。

## 核实结论

- **Magpie 支持一个 Provider 存多个账号**：第一个账号存在 provider id 下，其余存在 `id#<slot>`（`internal/plugin/host.js`）：
  > "A provider may be signed in to more than once: the first account is kept under the provider's id, as OpenCode keeps it, the others under id#\<slot\>. Everything a request does runs in its account's scope, so the plugin's getAuth, client.auth.set and loader see that account alone."
- **插件不能枚举或切换账号**：一次请求只运行在它所属账号的作用域里，插件的 `getAuth`、`client.auth.set`、`loader` 都只能看到当前这一个账号。Provider 侧与 grokboot README 说的工具侧完全一样——没有账号选择器，插件内轮换在架构上不可能。
- **网关已经对插件 Provider 做 failover**，与内置 Provider 一致（`internal/gateway/plugin_failover_test.go`，`TestPluginFailover`）：429（额度/限流）→ 切下一个账号，失败账号休息；401 → 切下一个账号；流在出任何内容之前出错 → 切下一个账号；所有账号都失败 → 路由组切下一个成员。只有一个账号且没有路由组时，无处可切。
- **网关的失败分类**（`internal/gateway/routing.go` 的 `failure()`）：429 → `failRate`/`failQuota`（failover）；401 → 失效 + failover（单次 401 且 token 可刷新时先当作可续期，只有刷新后的 token 也被拒才标记账号）；普通 403 → `failOther`（不 failover）；403 且正文命中受限词（WorkBuddy/ZCode 提示、Google/Claude 停用）→ `failRestricted`（failover + 休息 2 小时）。Capy 的 `region_unsupported` 403 不命中受限词 → 正确地不 failover（它是出口 IP 问题，不是账号问题）。
- **流式路径的 429 也会 failover**：网关 `namedStatusOf`（`internal/gateway/fallback.go`）读 SSE 错误帧里 error 对象自带的 `status` 字段；`streamStatus` 还会把 "rate_limit"/"rate limit"/"too many"/额度词映射成 429。本插件的错误块来自 `toOpenAiError`，其中就有 `"status": 429`，所以流式 429  before 任何内容时网关能正确切账号。
- **登录失效信号**：`X-Magpie-Sign-In` 响应头（`internal/provider/plugins.go`，`SignInHeader = "X-Magpie-Sign-In"`）——"expired" 标记账号失效，"kept" 不动，"renewed" 清除标记；没有该头时 401 标记账号、成功清除标记。本插件已在 401 时发 `x-magpie-sign-in: expired`（`src/protocol/openai.ts` 的 `encodeErrorResponse`）。
- **用量上报已让网关能掂量/跳过耗尽的账号**：`auth.usage` 上报用量；没有余额时按 `used=100` 算，账号自然下沉。

## 决策

- **不在插件内实现多账号轮换**：架构上做不到（见上），硬写只会是死代码。轮换归 Magpie 网关所有；用户想用多账号，在 Magpie 里给 `capy` Provider 再登录一个账号（存为 `capy#<slot>`），或把 `capy` 放进路由组做成员 failover。
- **插件的契约是“干净的 429/401”，让网关能切**：
  - 429/401 从 `createJam` 等上游调用原样透传，不重试成 200、不降级到默认模型、不吞成空完成。
  - 流式路径：429 发生在任何 delta 之前时，只发一个 error 事件（`rate_limited`，`status: 429`），前面不发 delta——网关只在“出错前无内容”时才 failover，混进一个 delta 就会断了这条路。
  - 401 附 `x-magpie-sign-in: expired`，让网关正确标记账号失效。
  - 用量继续上报（估算值），让网关能跳过耗尽的账号。
- **不做推测性的 403 标记**：`region_unsupported` 是出口 IP 问题，与账号无关，标记了会误伤好账号；账号封禁类 403 的文案未经核实，不猜。403 保持原样透传，由网关按 `failure()` 分类。
- **插件内只做有界 429 重试**（见 Task 3 的实现）：同一账号内对幂等操作最多重试 2 次、尊重 `Retry-After`，耗尽后仍返回 429 交给网关切账号。两者不冲突：插件内重试消化瞬时限流，网关 failover 处理账号级耗尽。

## 后果

- 多账号轮换不需要插件改代码，用户侧配置即可：Magpie 里多登一个 Capy 账号，或把 `capy` 加入路由组。
- 契约由回归测试锁定（`test/unit/chat.test.ts`：建线程 429 抛 `rate_limited`、401 抛 `sign_in_required` 且只发一次请求、流开始前 429 只出一个 error 事件且前面无 delta；`test/unit/openai.test.ts`：429 返回 429 且不带 sign-in 头、401 返回 401 且带 `x-magpie-sign-in: expired`）。
- 若将来 Magpie 给插件开了账号选择器（或 `getAuth` 能看到多账号），再回头实现插件内轮换；在此之前不要写。
- 风险提示不变：Capy 是逆向网站接口，多账号轮换不降低封号风险，只是让限流/失效时不断线。
