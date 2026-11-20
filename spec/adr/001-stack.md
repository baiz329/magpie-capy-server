# ADR-001 — TypeScript + Bun + 零运行时依赖

## 状态

Accepted

## 背景

插件运行在 Magpie 自带的 Bun 运行时；早期实现是 JS + 大量隐式结构。要支持多个 Agent 并行开发，
需要类型、稳定接口、可离线构建，且安装路径插件不能依赖复杂 node_modules。

## 决策

- 源码：TypeScript strict（`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`）。
- 运行时：Bun 1.4+；Web 标准（fetch/streams/AbortSignal/WebSocket）。
- 构建：`bun build` 单文件 `dist/index.mjs`。
- 测试：`bun test` + Node 兼容的纯函数测试。
- **零运行时依赖**；开发依赖只允许 TypeScript/@types。
- 不引入 Web 框架、ORM、Effect、DI 容器。

## 后果

- 类型检查需要 dev 依赖；构建产物零依赖、可离线安装。
- 适配器必须手写轻量协议；换来可控与可审计。
- Bun 之外的运行时不做一等支持（Magpie 用 Bun）。

## 备选

- 纯 JS：类型缺失，Agent 并行易冲突。
- Effect：能力强但学习/依赖成本高，违背“最小优雅”。
- Go/Python：无法作为 Magpie 路径插件直接加载。
