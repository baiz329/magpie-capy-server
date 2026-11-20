# AGENTS.md — magpie-Capy

## 先读什么

1. `spec/SPEC.md` — 产品行为
2. `spec/ARCHITECTURE.md` — 分层/端口/数据流
3. `spec/CONTRACTS.md` — Capy / OpenAI 协议
4. `spec/AUDIT.md` — 哪些值是上游事实、哪些是插件策略
5. `spec/adr/` — 已决事项

## 不可协商的规则

- **依赖只向内**：`domain ← application ← ports ← adapters ← entry`。
- **entry 是唯一知道 Magpie 的地方**；adapters 是唯一知道 Capy 的地方。
- **domain/application 不 import** `bun`、`node:*`、`fetch`、`WebSocket`、`process.env`。
- **零运行时依赖**：只用 Bun/Node/Web 标准库。新增依赖先写 ADR。
- **端口冻结**：改 `src/ports/**` 必须先写 ADR。
- **无全局可变状态**：依赖在 `entry/plugin.ts` 显式创建。
- **不引入 DB/队列/微服务**；插件是请求作用域 + 极小密钥状态。
- **不打印 secret**：`capy_`、`capyd_`、`Bearer`、cookie 一律 redact。
- **不静默降级**：错误要么抛，要么返回明确的 SSE/error 事件。

## 工作方式

1. 先读相关 spec 与现有测试。
2. 先补失败测试，再改实现。
3. 一个提交只做一件事。
4. 完成后运行：

```bash
bun test
bun run typecheck
bun run build
```

真实 Capy 回归：`bun run smoke`（需要本机已登录 Capy 桌面端）。

## 代码风格

- TypeScript strict；小文件、小函数；一个文件一个主题。
- 纯函数放 domain/application；I/O 放 adapters。
- 错误用 `CapyError`，不要跨层 `throw new Error("...")`。
- 异步流用 `AsyncIterable<ChatEvent>`。
- 命名：`XPort`、`XUseCase`、`XClient`、`XAdapter`。
- 注释只写“为什么”，不写“是什么”。

## 定义完成

- `bun test`、`bun run typecheck`、`bun run build` 全绿。
- 新行为有 unit 测试；真实路径至少 smoke 一次。
- 没有 secret 进入日志/测试/文档。
- `SPEC` / `CONTRACTS` 与实现一致；不一致先改文档。

## 反模式

- 把插件自己的常量写成“Capy 的限制”（例如 160k 字符）。
- 吞错误 / 静默 fallback 到默认模型。
- 在 adapter 里写业务分支。
- 为了“未来可能用到”加抽象/依赖。
- 把 token 写进错误 message。
