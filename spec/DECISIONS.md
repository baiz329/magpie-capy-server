# DECISIONS — ADR 索引

| ADR | 决策 | 状态 |
|---|---|---|
| [001](./adr/001-stack.md) | TypeScript + Bun + 零运行时依赖 | Accepted |
| [002](./adr/002-hexagonal.md) | Hexagonal + 控制面/数据面分离 | Accepted |
| [003](./adr/003-headless-device.md) | 无头设备，不依赖 Capy 桌面端运行 | Accepted |
| [004](./adr/004-native-sse.md) | 原生 SSE + ChatEvent 归一 | Accepted |
| [005](./adr/005-capability-registry.md) | 能力注册表 + 模型策略 + 可替换 ToolBridge | Accepted |
| [006](./adr/006-no-database.md) | 不引入数据库/队列；DPAPI 极小状态 | Accepted |
| [007](./adr/007-provider-id.md) | provider id = `capy` | Accepted |
| [008](./adr/008-cookie-login.md) | 无头粘贴 Cookie 登录：`__client` + Cookie 中提取的 sessionId，复用统一换票链 | Accepted |
| [009](./adr/009-two-box-cookie-login.md) | 两框粘贴 Cookie 登录（prompts + auto）+ 非流式用量估算上报；README v0.2 修正与风险/限制说明 | Accepted |

## 用量上报：网关只认流里的 usage chunk（2026-11-20）

根因（已在 magpie 源码 `internal/gateway/chat.go`、`gateway.go` 核实）：
网关收到客户端请求后，一律以 `stream: true` + `stream_options: {include_usage: true}` 向插件要流，
再用 `chatDecoder` 把 SSE chunk 逐条译成事件；只有 chunk 自带 `usage` 且 prompt/completion 任一非 0 时，
才发 `KUsage` 事件进 `collector`，最后 `renderChat` / `chatEncoder.finish()` 用它填客户端的用量。
所以插件非流式 `encodeCompletion` 里填的 `usage` 永远走不到网关——网关根本不走非流式；
而流式 `encodeChatStream` 原先不发 usage chunk，用量就一直是 0。

修复：`encodeChatStream` 在 stop chunk 之后、`[DONE]` 之前单独发一个 usage chunk
（`choices: []` + `usage: {prompt_tokens, completion_tokens, total_tokens}`，OpenAI 约定），
completionTokens 用流内累积的正文按同一启发式估算；`encodeToolCallStream` 同理。
非流式 `encodeCompletion` 的用量字段保留（直接调插件时仍有效）。
用量仍是近似值，不是精确计数，也不能当作计费依据。
