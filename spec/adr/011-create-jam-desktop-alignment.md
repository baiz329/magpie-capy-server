# ADR-011 — createJam 与真实桌面端对齐

## 状态

Accepted

## 背景

插件的 `createJam`（`POST /app/orgs/{orgId}/jams`）之前是按公开 OpenAPI 与早期
抓包推测拼的：只发 7 个字段，`files`/`promptVariant` 无值时省略，`clientKey`
复用 `requestId` 的 ULID，请求头 `origin: https://capy.ai` 并带 `referer`，
UA 里 Chrome 段写死 `140.0.0.0`。第 4 项改进的目标是把它与真实桌面客户端
发出的请求对齐，缩小指纹面。

核实方法：Lin 2026-11-21 在 Capy 桌面版（Electron）里用 DevTools 抓到的
真实建对话请求（内部取证，未随仓库分发）。对照时以原始抓包的
`postData` 文本为准（字段顺序），不要以脱敏 JSON 文件的字母排序为准。
同文件还附了一条网页端发消息请求，只作对照参考。

## 核实结论（桌面端，surface=desktop）

- **请求体是固定 16 个字段，按线上顺序发送**（内部取证的 postData 原文）：
  `jamId`、`requestId`、`title`、`message`、`model`、`mentions`、`files`、
  `clientKey`、`machineSize`、`device`、`branches`、`environmentVariables`、
  `slackChannelId`、`promptVariant`、`personal`、`memberIds`。
  无值字段显式为 `null`（`title`、`mentions`、`machineSize`、`branches`、
  `environmentVariables`、`slackChannelId`、`personal`、`memberIds`），
  `files` 与 `promptVariant` 无值时也显式为 `null`，不是省略。
  `model` 内顺序是 `modelId`、`reasoningMode`、`modes`，后两者无值时为 `null`。
- **`clientKey` 是独立 UUID**（格式如 `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`），
  与 `requestId` 的 ULID 不同值、不同格式。`requestId` 与 `jamId` 保持 ULID。
- **请求头**（桌面端）：`origin: capy://app`（Electron 自定义协议），
  不发 `referer`；`accept: */*`；`accept-language: en-US`；
  `sec-fetch-site: cross-site`、`sec-fetch-mode: cors`、`sec-fetch-dest: empty`；
  `sec-ch-ua: "Not:A-Brand";v="8", "Chromium";v="156"`、`sec-ch-ua-mobile: ?0`、
  `sec-ch-ua-platform: "Windows"`；`priority: u=1, i`。
  UA：`Capy/0.9.2 Chrome/156.0.8078.80 Electron/45.2.3`。
  `x-capy-client-surface: desktop`；`x-capy-client-timezone` 是真实时区；
  ADS 模型时 `x-capy-client-features` 带 `ads-models`。
- **网页端是另一套**（surface=web、纯 Chrome UA、origin https://capy.ai、
  sec-fetch-site same-site），不要拿网页端的数据改桌面端请求。
  网页端发消息的两个发现记在这里，不属于本次 createJam 对齐范围：
  发消息时 `model: null`（模型只在建对话时定），请求体带 `delivery: "interrupt"`。
  如需处理，另起提交。

## 决策

- **请求体按线上 16 字段与顺序发送**，无值字段显式 `null`；
  `files`/`promptVariant` 无值时发 `null`，有值时发原值；
  `model` 固定带 `reasoningMode`（无值时 `null`）与 `modes: null`。
  契约见 `spec/CONTRACTS.md` §3.5。
- **`clientKey` 在 adapter 里每次生成一个新 UUID**（`node:crypto` 的
  `randomUUID()`），不直接用入参。原因是调用方（`src/application/chat.ts`）
  目前传的是 `requestId` 的复用值，与真实客户端不符，而该文件正由 Lin
  改动（v0.2.2/v0.2.3 未提交），本次不碰。`IdPort` 已有 `uuid()`，
  后续应用层改用 `ids.uuid()` 生成 `clientKey` 后，这里可改回直接用入参。
  同一次 `createJam` 调用内 UUID 只生成一次，429 重试重发同一请求体，
  幂等键在重试间保持稳定。
- **端口 `CreateJamInput.clientKey` 的注释（“与 requestId 同值”）已过时**，
  但端口冻结，本次不动 `src/ports/**`；改注释与应用层生成方式需另写 ADR。
- **请求头按桌面端对齐**（见上）。有意不发的两类：
  `accept-encoding`（fetch 运行时自动协商/解压，手动写可能干扰解压）、
  `b3`/`traceparent`（桌面端观测 SDK 的逐请求追踪 id，不是固定值，
  伪造没有指纹价值）。
- **UA 里 Chrome 段更新为 `156.0.8078.80`**（2026-11-21 真实桌面端抓包核实），
  并在 `src/adapters/capy/client-version.ts` 注释写明验证日期。
  下载页不公布 Chrome/Electron 版本，所以这段仍是人工验证值，不自动保鲜；
  不要谎称它能自动刷新。`sec-ch-ua` 的 Chromium 主版本号与该常量同源。

## 后果

- `createJam` 的线上格式由回归测试锁定（`test/unit/app-client.test.ts`：
  16 字段与顺序、显式 null、UUID clientKey、请求头全集、ads 能力位）。
- `client-version.test.ts` 的 Chrome 期望值同步更新为 `156.0.8078.80`。
- 仍有意没动的差异：`b3`/`traceparent` 不发（见上）；
  `accept-encoding` 不手动写（运行时决定）；端口注释与应用层 `clientKey`
  生成方式待后续 ADR 处理；网页端发消息的 `delivery`/`model: null`
  不在本次范围。
- 封号风险提示不变：对齐缩小指纹面、提高与真实客户端的一致性，
  但不消除逆向接口的封号风险。
