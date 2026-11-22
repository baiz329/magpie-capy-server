# ADR-008 — 粘贴 Cookie 登录

## 状态

Superseded by ADR-009（两框登录取代单框 Cookie 登录，见 ADR-009）

## 背景

无头服务器用户可能无法启动 Capy 桌面端或交互式浏览器。需要在保留本机导入与浏览器登录的前提下提供第三种认证入口。

## 决策

- 在 Magpie `auth.methods` 末尾追加 Cookie 登录：`type: "oauth"`，authorize 返回 `url: ""`、`method: "code"`，不启动浏览器。
- 接收 Cookie-Editor JSON 或原始 Cookie 请求头；要求精确的 `__client` Cookie 作为长期 client JWT。
- sessionId 从 `clerk_active_context` 首段优先取得，其次从 `__session` 或带后缀变体 JWT 的 `sid` 取得，最后允许同一输入显式追加 `sessionId=`。不伪造 sessionId，也不把 `__client` 的 `id` 当 sessionId。
- `LoginCredential.source` 联合类型增加 `"cookie"` 以描述新 AccountSession 来源；`LoginSourcePort` 未新增方法，解析仍在 entry 调 adapter 后调用 `LoginUseCase.complete()`。这是必要的凭据类型扩展，不改变冻结的端口操作接口。
- Cookie 只用于现有 Clerk FAPI 换票，不写日志、测试、文档或账号 metadata；错误文案必须脱敏且不回显输入。

## 后果

- 支持无头环境中的第三种登录方式，同时保留原有两种方式和统一 AccountSession/refresh 链路。
- Cookie 登录需要用户粘贴包含 `__client` 与 sessionId 来源的凭据；扩展导出可能漏掉 HttpOnly 的 `__client`，应检查浏览器 Network 中发往 `clerk.capy.ai` 的请求头或该域 Cookie。
- 真实账号端到端登录与模型/对话验收需在具备真实凭据的环境另行验证。
