# Magpie-Capy-Server

[中文](README.md)

A magpie provider plugin that connects [Capy](https://capy.ai) to [magpie](https://usemagpie.ai). Forked from [baijiu666/magpie-Capy](https://github.com/baijiu666/magpie-Capy), with Cookie login added for headless Linux servers: no desktop app, no graphical browser — paste two pieces of Cookie and sign in. 64 models in total, 3 of them free; native SSE streaming / non-streaming chat, image / PDF attachments.

Current version: **v0.3** (git tag `v0.3`; not published to npm).

## Navigation

- [What's new in v0.3](#whats-new-in-v03)
- [Features](#features)
- [Install](#install)
- [Sign in](#sign-in)
- [Free models & regions](#free-models--regions)
- [Risk warning](#risk-warning)
- [Known limitations](#known-limitations)
- [Development](#development)
- [Architecture](#architecture)
- [Layout](#layout)
- [Headless device & tools](#headless-device--tools)
- [Scope](#scope)
- [License](#license)

## What's new in v0.3

1. **Multi-account rotation belongs to the gateway**: the plugin can't rotate accounts internally — one request only ever sees its own account, never the others, and can't switch between them. The magpie gateway already switches to the next account on 429/401. The plugin's job is to pass 429/401 through cleanly so the gateway can act (the error body carries a `status` field, and 401 includes an `x-magpie-sign-in: expired` header). To use multiple accounts, sign in to another `capy` account in magpie. See [`spec/adr/010-gateway-owns-failover.md`](./spec/adr/010-gateway-owns-failover.md).
2. **User-Agent version freshness**: before every request, the plugin fetches the latest Capy desktop version from Capy's download page (`https://capy.ai/download`) and builds it into the User-Agent (currently `Capy/0.9.2 Chrome/156.0.8078.80 Electron/45.2.3`). The result is cached for 24 hours and concurrent requests share a single probe; if the fetch fails it falls back to 0.9.2. The Chrome / Electron segments are manually verified values captured from the real desktop client on 2026-11-21 — they don't auto-refresh.
3. **Bounded 429 retry + clear 401 handling**: on 429 (rate limited), the plugin waits per the upstream `Retry-After` header (capped at 30 seconds; 1s / 2s backoff when the header is absent) and retries at most 2 times. Retries apply only to idempotent operations (`createJam`, `getJam`, `getJamEvents`, `interruptJam`, the initial streaming GET); `mintApiKey`, `startDeviceCode`, and `approveDeviceCode` are never retried (each call creates a new resource, so retrying would orphan keys / device codes). A 401 is reported as an expired Capy sign-in (please sign in again) and is never retried.
4. **createJam aligned with the real desktop client**: new-conversation requests are now sent exactly like the real desktop client — 16 fields in the live order, empty fields explicitly `null` (never omitted); `model` carries `reasoningMode` (`null` when unset) and `modes: null`; `clientKey` is a fresh independent UUID on every call; headers use `origin: capy://app`, no `referer`, `accept: */*`, `accept-language: en-US`, plus the desktop `sec-fetch-*` and `sec-ch-ua` headers. This matters because Capy's server only allows the desktop client to create new conversations with the free models. See [`spec/adr/011-create-jam-desktop-alignment.md`](./spec/adr/011-create-jam-desktop-alignment.md).

## Features

| Feature | Description |
|---|---|
| Fully headless | Registers a device automatically via the Capy device tunnel; no Capy desktop app needed at runtime |
| Sign-in | Local client import / browser sign-in / Cookie paste sign-in (for headless servers) |
| Chat | OpenAI-compatible `/chat/completions`, native SSE, streaming / non-streaming |
| Models | Live catalog + static fallback, 64 models in total, 3 of them free |
| Attachments | Images / PDFs via the Capy files channel (250 MB per file) |
| Usage | Estimated token counts reported for streaming and non-streaming chat (approximate, see Known limitations) |
| Zero runtime dependencies | TypeScript + Bun, built into a single `dist/index.mjs` |

## Install

Add the GitHub repo `baiz329/magpie-capy-server` in Magpie's plugin settings, or from the command line:

```bash
magpie plugin add github:baiz329/magpie-capy-server
```

For local development, build first and add this repo's path. Provider id is `capy`.

Build locally:

```bash
bun install
bun run build
```

## Sign in

Three ways: local Capy client import, browser sign-in, and Cookie paste sign-in (two boxes, for headless environments).

### Local Capy client import

1. Install the Capy desktop app on this machine and sign in once (it only needs to have been signed in; the app doesn't need to be running).
2. Choose this method in Magpie; the plugin reads the Capy login credentials saved on this machine (on Windows, `Local State` under `%APPDATA%\Capy`) and signs in automatically — nothing to copy.
3. If this machine has never signed in to the Capy desktop app, the plugin reports that you need to sign in to the Capy desktop app first — sign in there once, then come back.

> This only works on a machine with the Capy desktop app installed (Windows for now). Headless Linux servers have no desktop app — **use Cookie paste sign-in below**.

### Browser sign-in

1. Choose this method in Magpie; the plugin opens Capy's official sign-in page `https://capy.ai/sign-in` (using the local Chrome / Edge / Brave / Chromium).
2. Sign in to Capy on that page with Google, GitHub, Passkey, or email.
3. Once signed in, the plugin reads the login state automatically — **nothing to copy**; just wait for it to finish. Closing the browser midway cancels the sign-in.

> This needs a graphical browser. Headless Linux servers have no graphical browser — **use Cookie paste sign-in below**.

### Cookie paste sign-in (two boxes)

For headless Linux servers: no desktop app, no graphical browser — paste two pieces of Cookie and sign in.

<details>
<summary><strong>Box 1: clerk request header (must contain <code>__client</code>)</strong></summary>

1. Sign in to `capy.ai` in your browser, press F12 to open DevTools, click the **Network** tab, and refresh the page.
2. In the request list, find a request to `clerk.capy.ai` — usually named `client?…` or `environment?…` (the Initiator column shows `clerk.browser.js`) — and click it.
3. In the right panel, click **Headers**, scroll down to **Request Headers**, find the `cookie:` line, and copy its full value. Confirm it contains `__client`.
4. Paste it into the **first box** in Magpie's sign-in.

`__client` is an HttpOnly cookie that only exists on the `clerk.capy.ai` domain. Requests to the main `capy.ai` domain (like `me`, `devices`, `billing`) don't have it — **you must click a request to `clerk.capy.ai`**.

</details>

<details>
<summary><strong>Box 2: the <code>__session</code> value</strong></summary>

1. Still in DevTools, click the **Application** tab, expand **Cookies** on the left → `https://capy.ai`.
2. Find `__session` in the list, click it, and copy the full **Value** (a very long string starting with `eyJ`).
3. Paste it into the **second box** in Magpie's sign-in.
4. If there is no plain `__session`, copy the `__session_VSH_xxx` value instead; or fill in the Clerk session id directly.

</details>

> **Notes**
>
> - After pasting to sign in, don't sign out in that original browser — it invalidates the copied Cookie.
> - Cookies are sensitive login credentials: don't paste them into chats, source code, command-line arguments, or logs.
> - Optional shortcut: if you have the Cookie-Editor extension, you can paste its whole JSON export into the first box (one export contains both `__client` and `__session`). This is only a shortcut — **the two-box method above works without any extension**.
> - After signing in, check the model list in Magpie and try one streaming and one non-streaming chat with `particle/particle-1` to confirm sign-in and models work.

## Free models & regions

| Model | Free as | Region |
|---|---|---|
| `particle/particle-1` | Free, no ads | No region restriction |
| `zai/glm-5.3-flash-ads` | Free with in-app ads | **Exit IP in US / CA / UK / AU / NZ / IE only** |
| `deepseek/deepseek-v4.1-flash-ads` | Free with in-app ads | **Exit IP in US / CA / UK / AU / NZ / IE only** |

The two ADS models are gated by Capy on **exit IP** — request headers can't bypass this:

- The plugin reads `MAGPIE_CAPY_PROXY`, `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, or the Windows system proxy.
- The startup log prints `proxy_enabled` (host:port only, no credentials) so you can confirm the proxy is active.
- If the exit IP is outside the supported regions, the plugin returns `region_unsupported` with Capy's original message; switch the proxy to a node in a supported region, or use `particle/particle-1` instead.
- ADS models also require the `ads-models` client capability bit; the plugin adds it automatically for these two models only.

## Risk warning

> This plugin calls Capy's website chat API directly with your own Clerk session (a reverse-engineered implementation, not Capy's official API). Free and paid models all go through the same interface (the model is just a parameter); there is no separate official API chat channel. The API key the plugin mints automatically is only used to fetch the model list, receive streamed messages, upload attachments, and check usage — not to call models directly. Every call creates a real new conversation in your Capy account. Request formats are highly uniform and behavior differs from normal web usage, so Capy's servers can identify it. **There is a risk of being flagged as a non-official client and banned, especially on free quotas.**
>
> Advice: don't call it at high frequency or in bulk; don't use it as a heavy-duty workhorse long-term; keep usage light. Decide for yourself whether to use it.

## Known limitations

- **Usage display**: Capy upstream doesn't return token usage. The plugin estimates and reports usage for both streaming and non-streaming chat (CJK ≈ 1 token/character, other text ≈ 1 token/4 characters; streaming sends a separate usage chunk before `[DONE]`). These are **approximations, not exact counts, and can't be used for billing**. Speed / latency depends on the model; the plugin doesn't measure speed.
- **Region restriction**: The two ADS free models (`zai/glm-5.3-flash-ads`, `deepseek/deepseek-v4.1-flash-ads`) require an exit IP in US / CA / UK / AU / NZ / IE (see the region table above).
- **Tools & browser**: No native OpenAI tools; only a `PromptToolBridge` prompt convention, which the Capy agent may ignore. Browser / computer use is not implemented.

## Development

```bash
bun test
bun run typecheck
bun run build
bun run smoke     # Real Capy: local sign-in → models → particle-1 "pong"
```

`smoke` needs a local Capy desktop sign-in. Real-server sign-in, model, and chat acceptance for Cookie sign-in is done by the user; passing automated tests doesn't mean the real environment is verified. Don't paste Cookies into chats, source code, or logs.

## Architecture

```
entry (Magpie hooks)
  → application (use cases / stream / tool bridge)
    → ports (CapyApp, CapyPublic, DeviceRuntime, SecretStore, …)
      → adapters (Capy App/Public/Device tunnel/DPAPI/Host)
domain: pure types/errors/events, no I/O
```

See [`spec/ARCHITECTURE.md`](./spec/ARCHITECTURE.md) and [`spec/CONTRACTS.md`](./spec/CONTRACTS.md).

## Layout

| Path | Contents |
|---|---|
| `src/domain/` | Pure types, errors, events |
| `src/application/` | Sign-in, catalog, chat, device, quota, attachments, tool bridge |
| `src/ports/` | Frozen interfaces |
| `src/adapters/capy/` | Capy App/Public/Device/SSE/Files/local/browser |
| `src/adapters/host/` | Magpie auth records |
| `src/adapters/platform/` | proxy/DPAPI/HTTP/ULID/clock/logger/token estimation |
| `src/entry/` | Magpie plugin wiring |
| `src/protocol/` | SSE / OpenAI codecs |
| `spec/` | Behavior, architecture, protocol, decisions, audit |

## Headless device & tools

The device name defaults to `os.hostname()`; override with `MAGPIE_CAPY_DEVICE_NAME`. Existing devices are renamed automatically via `PATCH /app/orgs/{org}/devices/{id}` — no need to re-pair. If an old `magpie-headless` device is still in Capy settings, you can delete it manually on the device page; the plugin only uses the device with the current hostname.

Machine RPC is implemented:

| Capability | handler |
|---|---|
| Run commands | `bash` / `bash_output` |
| Read/write files | `read` / `write` / `edit` / `file_read` / `file_write` |
| Workspaces | `worktree_ensure` / `worktree_list` |
| Volumes | `volume_landed` / `volume_probe` |
| Git | `POST /v1/git/capture` |

> [!WARNING]
> `bash` runs commands sent by the Capy agent under the **current Windows user**, same as the Capy desktop app. Only install trusted plugins, only sign in to trusted accounts, and don't share this device token with anyone.

Browser / computer use is still not implemented.

## Scope

- The headless device implements bash / files / workspaces; browser / computer use is unavailable.
- The free ADS models (GLM-5.3-Flash / DeepSeek V4.1 Flash) only allow these exit IPs: US / CA / UK / AU / NZ / IE. The plugin reads `MAGPIE_CAPY_PROXY`, `HTTPS_PROXY`, and the Windows system proxy automatically, and prints `proxy_enabled` in the log; an unsupported exit IP returns `region_unsupported`. This is a Capy server-side restriction the plugin can't bypass.
- No native OpenAI tools; only a `PromptToolBridge` prompt convention, which the Capy agent may ignore.
- No database/queue: the plugin is request-scoped + a local device token.
- Only one `capy` plugin per Magpie.

## License

MIT
