# ADR-007 — provider id = `capy`

## 状态

Accepted

## 背景

旧插件已经删除，不再存在两个 Capy 插件并存的兼容问题。用户已有的模型 id、登录记录
都使用 `capy`，新插件直接沿用，避免迁移。

## 决策

- provider id 使用 `capy`。
- 模型 id 接受 `capy/<model-id>` 前缀并在解析时剥掉。
- `MAGPIE_CAPY_PROVIDER_ID` 只作为测试/并行调试的覆盖项，不是发布路径。

## 后果

- 旧账号、旧模型 id、旧 auth 记录可直接复用。
- 同一 Magpie 里只应安装一份 `capy` 插件；不要同时装旧插件。
