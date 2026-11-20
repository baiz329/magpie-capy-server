# ADR-009 — 两框粘贴 Cookie 登录 + 估算用量上报

## 状态

Accepted

## 背景

v0.1 的 Cookie 登录是单框 `method: "code"`：用户粘贴一条 Cookie 串，插件从中解析 `__client` 与 sessionId。但 `__client` 在 `clerk.capy.ai` 域、`__session` 在 `capy.ai` 域，一条请求的 Cookie 头凑不齐两者；用户要先去 Network 复制 clerk 请求头，再去 Application 找 `__session` 追加，步骤繁琐且容易贴错。v0.1 的 README 还把登录说明写错（“选择任意 capy.ai 请求”），并把未发布的 v0.1 写成“当前发布版本”。

另外 v0.1 的非流式 completion 把 `usage` 硬编码为全 0，Magpie 网关因此永远显示 0/0；Capy 上游不返回用量，插件需要自己估算才能让网关显示参考值。

## 决策

- Cookie 登录改用 Magpie `prompts`（两个 `type: "text"` 输入框）+ `method: "auto"`：
  - 第一框 `clerkCookie`：发往 `clerk.capy.ai` 的完整 cookie 请求头，必须包含 `__client`。
  - 第二框 `sessionCookie`：`__session` 的裸值（JWT），或 `__session_VSH_xxx` 的值，或直接填 Clerk session id。
  - `authorize(inputs)` 用 `combineCookieInputs` 把两框拼成一串再调用已有的 `cookieCredentialOf`；第二框是裸值时自动补 `__session=` 或 `sessionId=`；任一框是 Cookie-Editor JSON 导出时直接用它（自包含）。
  - 登录在 `authorize` 内以 probe 方式启动，`callback()` 等待结果；失败返回 `{ type: "failed", error: redact(...) }`，不回显输入。
- 本机导入与浏览器登录两个方法不动。
- 用量估算：新增 `src/adapters/platform/token-estimate.ts`，启发式为 CJK 约 1 token/字、其余约 1 token/4 字符，明确标注为近似值。非流式 `encodeCompletion` / `encodeToolCallCompletion` 接受可选 `usage` 参数并上报估算值（输入取请求消息文本，输出取回复文本）；流式 `encodeChatStream` 不附带用量，保持原样。
- README v0.2：标题居中并改为 `Magpie-Capy-Server`；中文描述在前、英文描述在后；删掉未发布的“当前发布版本 v0.1”说法，版本行只写 `0.2.0` 与 git tag，不宣称 GitHub Release 或 npm 发布；登录步骤按两框重写，写明每个值在开发者工具里的精确位置（中文标签加括号英文）；新增“风险提示”（逆向网站接口、账号留痕、封号风险）与“已知限制”（用量为估算值、流式无用量、地区与工具边界）。
- 版本号 `0.1.0` → `0.2.0`；`package.json` 描述恢复“zero runtime dependencies”。

## 后果

- 无头用户不用装任何浏览器扩展，两次复制粘贴即可登录；JSON 导出仍可作为可选捷径。
- 非流式对话在 Magpie 里显示估算用量；流式对话仍显示 0，需要在文档里写明。
- 逆向接口的封号风险与用量估算的近似性都写进 README，由用户自行权衡。
- 真实账号端到端登录与模型/对话验收仍需在具备真实凭据的环境另行验证。
