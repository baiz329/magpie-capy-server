# ADR-006 — 不引入数据库/队列；DPAPI 极小状态

## 状态

Accepted

## 背景

插件是请求作用域的 provider adapter；账号/API key 由 Magpie 的 auth record 管理。
唯一需要持久的是无头设备 token。早期实现没有 DB；引入 DB 只会增加部署/迁移/并发复杂度。

## 决策

- **没有数据库、没有队列、没有后台 worker。**
- 账号状态：Host 的 auth record。
- 设备 token：`%LOCALAPPDATA%\magpie-capy\headless-device.json`（DPAPI）。
- 其余缓存：进程内 TTL Map，经 `CachePort`；进程重启即失效。
- 所有持久化通过 `SecretStorePort`，便于未来替换。

## 后果

- 零迁移、零运维；插件可随时重装。
- 缓存不跨进程；冷启动需重新配对/拉目录（可接受）。
- 多进程不共享设备 runtime；Magpie 单实例运行。

## 备选

- SQLite：为一个小 token 引入 schema/迁移，不划算。
- Redis/队列：插件没有后台任务，纯过度设计。
