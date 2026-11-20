# ADR-002 — Hexagonal + 控制面/数据面分离

## 状态

Accepted

## 背景

早期实现把登录、设备、线程、SSE、错误处理混在一个 chat 模块里；改一处影响全链路，Agent 无法并行。
插件同时承担“控制面”（登录/设备/目录/额度）与“数据面”（chat 流）。

## 决策

- 依赖只向内：`domain ← application ← ports ← adapters ← entry`。
- `domain`/`application` 不知道 HTTP/WS/Magpie/Capy。
- `entry` 是唯一知道 Magpie 的模块；`adapters/capy` 是唯一知道 Capy 的模块。
- 控制面与数据面共享 `AccountSession` 不可变值，不共享可变状态。
- 所有 I/O 通过 port；测试用 fake port。

## 后果

- 文件更多、接口更显式；换来可替换、可测试、可并行。
- 改协议只动 adapter；改行为只动 application/domain。
- 禁止“顺手跨层”修改。

## 备选

- 按功能分文件夹（无依赖规则）：短期快，长期重新变乱。
- 框架式 DI：额外依赖/隐式生命周期，不适合插件。
