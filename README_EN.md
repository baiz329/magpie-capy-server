# Magpie-Capy-Server

[中文](README.md)

A magpie provider plugin that connects [Capy](https://capy.ai) to [magpie](https://usemagpie.ai). Forked from [baijiu666/magpie-Capy](https://github.com/baijiu666/magpie-Capy), with Cookie login added for headless Linux servers: no desktop app, no graphical browser — paste two pieces of Cookie and sign in. 62 models in the upstream catalog + 2 in-app ADS models = 64 in total (snapshot, may change), 3 of them free; native SSE streaming / non-streaming chat, image / PDF attachments.

> ⚠️ **Warning: the author's Capy account has been banned.**
>
> The plugin already includes anti-detection alignment (requests sent exactly like the real desktop client, User-Agent version freshness, and more), and the author's account was still banned. Anti-detection measures only lower the chance of being flagged — they cannot guarantee you won't be banned.
>
> **Use a throwaway / secondary account only — never your main account.** This applies doubly to paid accounts.

Current version: **v0.3.2** (git tag `v0.3.2`; not published to npm).

Note: the same-named package `magpie-capy` on npm (grokboot) is unrelated to this project; this project is not published to npm.

## Navigation

- [What's new in v0.3.2](#whats-new-in-v032)
- [What's new in v0.3.1](#whats-new-in-v031)
- [What's new in v0.3](#whats-new-in-v03)
- [Features](#features)
- [Install](#install)
- [Sign in](#sign-in)
- [Free models & regions](#free-models--regions)
- [Risk warning](#risk-warning)
- [Known limitations](#known-limitations)
- [Environment variables](#environment-variables)
- [Development](#development)
- [Architecture](#architecture)
- [Layout](#layout)
- [Headless device & tools](#headless-device--tools)
- [Scope](#scope)
- [License](#license)

## What's new in v0.3.2

A safety-warning release, no functional changes:

- A prominent warning is now at the top of README / README_EN: the author's Capy account has been banned; the plugin already includes anti-detection alignment (desktop-client request alignment, UA freshness, and more) and was still banned; use a throwaway / secondary account only, never your main account.
- The Risk warning section now notes the author's account ban as well.

Full list in [CHANGELOG.md](./CHANGELOG.md).

## What's new in v0.3.1

A fix release, not a feature release: machine `bash` is off by default (`MAGPIE_CAPY_MACHINE_TOOLS` defaults to `files`; `bash` needs an explicit `full`); plus a batch of security and correctness fixes. Full list in [CHANGELOG.md](./CHANGELOG.md).

## What's new in v0.3

1. **Multi-account rotation belongs to the gateway**: the plugin can't rotate accounts internally — one request only ever sees its own account, never the others, and can't switch between them. The magpie gateway already switches to the next account on 429/401. The plugin's job is to pass 429/401 through cleanly so the gateway can act (the error body carries a `status` field, and 401 includes an `x-magpie-sign-in: expired` header). To use multiple accounts, sign in to another `capy` account in magpie. See [`spec/adr/010-gateway-owns-failover.md`](./spec/adr/010-gateway-owns-failover.md).
2. **User-Agent version freshness**: before the first request, the plugin fetches the Capy desktop version from Capy's download page (`https://capy.ai/download`) and builds it into the User-Agent (currently `Capy/0.9.2 Chrome/156.0.8078.80 Electron/45.2.3`). The result is cached for 24 hours — no repeat fetch while the cache is fresh — and concurrent requests share a single probe; if the fetch fails it falls back to 0.9.2. The Chrome / Electron segments are manually verified values captured from the real desktop client on 2026-11-21 — they don't auto-refresh.
3. **Bounded 429 retry + clear 401 handling**: on 429 (rate limited), the plugin waits per the upstream `Retry-After` header (capped at 30 seconds; 1s / 2s backoff when the header is absent) and retries at most 2 times. Retries apply only to idempotent operations (`createJam`, `getJam`, `getJamEvents`, `interruptJam`, the initial streaming GET); `mintApiKey`, `startDeviceCode`, and `approveDeviceCode` are never retried (each call creates a new resource, so retrying would orphan keys / device codes). A 401 is reported as an expired Capy sign-in (please sign in again) and is never retried.
4. **createJam aligned with the real desktop client**: new-conversation requests are now sent exactly like the real desktop client — 16 fields in the live order, empty fields explicitly `null` (never omitted); `model` carries `reasoningMode` (`null` when unset) and `modes: null`; `clientKey` is a fresh independent UUID on every call; headers use `origin: capy://app`, no `referer`, `accept: */*`, `accept-language: en-US`, plus the desktop `sec-fetch-*` and `sec-ch-ua` headers. This matters because Capy's server only allows the desktop client to create new conversations with the free models. See [`spec/adr/011-create-jam-desktop-alignment.md`](./spec/adr/011-create-jam-desktop-alignment.md).

## Features

| Feature | Description |
|---|---|
| Fully headless | Registers a device automatically via the Capy device tunnel; no Capy desktop app needed at runtime |
| Sign-in | Local client import / browser sign-in / Cookie paste sign-in (for headless servers) |
| Chat | OpenAI-compatible `/chat/completions`, native SSE, streaming / non-streaming |
| Models | Live catalog + static fallback, 62 in the upstream catalog + 2 in-app ADS models = 64 (snapshot, may change), 3 of them free |
| Attachments | Images / PDFs via the Capy files channel (250 MB per file) |
| Usage | Estimated token counts reported for streaming and non-streaming chat (approximate, see Known limitations) |
| Zero npm runtime dependencies; bash / PowerShell also needed | TypeScript + Bun, built into a single `dist/index.mjs` (machine-tool `bash` needs bash; DPAPI on Windows needs PowerShell) |

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
2. Choose this method in Magpie; the plugin reads three files under `%APPDATA%\Capy` (on Windows): `Local State`, `session-credential.json`, and `device-credentials.json`, and signs in automatically — nothing to copy.
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
| `particle/particle-1` | Free, no ads | — |
| `zai/glm-5.3-flash-ads` | Free with in-app ads | **Exit IP in US / CA / UK / AU / NZ / IE only** |
| `deepseek/deepseek-v4.1-flash-ads` | Free with in-app ads | **Exit IP in US / CA / UK / AU / NZ / IE only** |

The two ADS models are gated by Capy on **exit IP** — request headers can't bypass this:

- The plugin reads `MAGPIE_CAPY_PROXY`, `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY`, or the Windows system proxy.
- The startup log prints `proxy_enabled` (scheme://host:port only, no credentials) so you can confirm the proxy is active.
- If the exit IP is outside the supported regions, the plugin returns `region_unsupported` with Capy's original message; switch the proxy to a node in a supported region, or use `particle/particle-1` instead.
- ADS models also require the `ads-models` client capability bit; the plugin adds it automatically for these two models only.

## Risk warning

> 2026-11-23: the author's Capy account has been banned (see the warning at the top). Anti-detection measures do not guarantee you won't be banned.
>
> This plugin calls Capy's website chat API directly with your own Clerk session (a reverse-engineered implementation, not Capy's official API). Free and paid models all go through the same interface (the model is just a parameter); there is no separate official API chat channel. The API key the plugin mints automatically is only used to fetch the model list, receive streamed messages, upload attachments, and check usage — not to call models directly. Every call creates a real new conversation in your Capy account. Request formats are highly uniform and behavior differs from normal web usage, so Capy's servers can identify it. **There is a risk of being flagged as a non-official client and banned, especially on free quotas.**
>
> Capability matrix (these capabilities all live on the local device — holding the device token means holding them):
>
> | Capability | Default | Notes |
> |---|---|---|
> | `bash` command execution | Off (only on with `MAGPIE_CAPY_MACHINE_TOOLS=full`) | Runs commands sent by the Capy agent as the current OS user; only allowlisted environment variables, no shell profile; command summaries go to the audit log |
> | File read/write (`read` / `write` / `edit` / `file_read` / `file_write`) | On (`files` tier) | Confined to the worktree; out-of-bounds access is refused |
> | Worktrees (`worktree_ensure` / `worktree_list`) | On | Confined under the fixed base directory |
> | Device token (`capyd_`) | — | Encrypted with DPAPI on Windows; stored in plaintext in a 0600 file on macOS/Linux, readable by same-user processes on the machine |
>
> Intrusion chain: once a Clerk session leaks, an attacker can use it to auto-approve device pairing, obtain the `capyd_` device token, and then run commands and read/write worktree files as the local user — no other credential needs to be stolen along the way.
>
> Advice: don't call it at high frequency or in bulk; don't use it as a heavy-duty workhorse long-term; keep usage light. Decide for yourself whether to use it.

## Known limitations

- **Usage display**: Capy upstream doesn't return token usage. The plugin estimates and reports usage for both streaming and non-streaming chat (CJK ≈ 1 token/character, other text ≈ 1 token/4 characters; streaming sends a separate usage chunk before `[DONE]`). These are **approximations, not exact counts, and can't be used for billing**. Speed / latency depends on the model; the plugin doesn't measure speed.
- **Region restriction**: The two ADS free models (`zai/glm-5.3-flash-ads`, `deepseek/deepseek-v4.1-flash-ads`) require an exit IP in US / CA / UK / AU / NZ / IE (see the region table above).
- **Tools & browser**: No native OpenAI tools; only a `PromptToolBridge` prompt convention, which the Capy agent may ignore. Browser / computer use is not implemented.
- **Every round is a new session**: there is no usable upstream contract for appending messages to the same thread, so every request creates a new jam in Capy; the local prompt cap is 1,000,000 characters, and anything over it returns `invalid_request`.
- **No attachment fileId cache**: the same image is re-uploaded on every round across turns (reuse of the upstream 1-hour fileId is not implemented).
- **Same-name API keys accumulate**: every re-login / key rotation mints a new same-name (`magpie-plugin`) key in the account; old keys are never revoked automatically — clean them up manually in Capy settings.
- **Concurrency**: the concurrency cap is the host's `maxConcurrency=2`; the plugin does not rate-limit itself.
- **Attachment caps are a plugin policy**: at most 32 files / 128 MiB per request (upstream only caps single files at 250 MB, with no count cap).
- **Network environment**: don't use it on untrusted networks or with a custom root CA (no TLS pinning — a man-in-the-middle can decrypt traffic).

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MAGPIE_CAPY_MACHINE_TOOLS` | `files` | Headless device capability: `off` (chat only, all machine RPC returns `Unavailable`) / `files` (read/write inside the worktree) / `full` (additionally allows `bash`) |
| `MAGPIE_CAPY_BASH` | `bash` | `bash` interpreter path; pointing it at any executable is equivalent to command execution, only used under `full` (not an authorization switch) |
| `MAGPIE_CAPY_STATE_DIR` | See “Headless device” | Device token directory |
| `MAGPIE_CAPY_WORKTREE_BASE` | `~/.capy/worktrees` | Worktree root (base for machine file I/O and worktree_ensure) |
| `MAGPIE_CAPY_DEVICE_NAME` | `os.hostname()` | Device name (renames the existing device via `PATCH`) |
| `MAGPIE_CAPY_PROVIDER_ID` | `capy` | Provider id (test / multi-instance override only) |
| `MAGPIE_CAPY_PROMPT_VARIANT` | `auto` | System prompt variant: `auto` / `minimal` / `default` (`minimal` behaves like `auto`; there is no force-minimal mode — any 403 falls back to `default` per account, retrying once without the variant) |
| `MAGPIE_CAPY_PROXY` | Unset | Explicit proxy URL (takes priority over `HTTPS_PROXY` etc.; set to `off` to disable the proxy) |
| `MAGPIE_CAPY_PROXY_FALLBACK` | Unset | Set to `direct` to allow a direct connection after a proxy failure (fail-closed by default) |
| `MAGPIE_CAPY_BROWSER` | Unset | Browser executable path for browser sign-in |
| `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` | Unset | System-level proxies (below `MAGPIE_CAPY_PROXY`) |
| `NO_PROXY` / `no_proxy` | Unset | Hosts matching these rules bypass the proxy (comma-separated, supports `*` and `.example.com`) |

Note: `undici` is an optional dependency, only needed for proxy support under the Node runtime (not needed under Bun); without it, `MAGPIE_CAPY_PROXY_FALLBACK` decides what happens (by default it fails outright instead of silently connecting directly).

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
| `src/adapters/capy/` | Capy App/Public/Device/Files/local/browser |
| `src/adapters/host/` | Magpie auth records |
| `src/adapters/platform/` | proxy/DPAPI/HTTP/ULID/clock/logger/token estimation |
| `src/entry/` | Magpie plugin wiring |
| `src/observability/` | Log redaction |
| `src/protocol/` | SSE / OpenAI codecs |
| `spec/` | Behavior, architecture, protocol, decisions, audit |

## Headless device & tools

The device name defaults to `os.hostname()`; override with `MAGPIE_CAPY_DEVICE_NAME`. Existing devices are renamed automatically via `PATCH /app/orgs/{org}/devices/{id}` — no need to re-pair. If an old `magpie-headless` device is still in Capy settings, you can delete it manually on the device page; the plugin only uses the device with the current hostname.

Machine RPC status:

| Capability | handler | Status |
|---|---|---|
| Run commands | `bash` | Only in the `full` tier, off by default |
| Run commands | `bash_output` | Not implemented (returns `MachineServer.Unavailable`) |
| Read/write files | `read` / `write` / `edit` / `file_read` / `file_write` | Implemented, worktree-confined |
| Workspaces | `worktree_ensure` | Implemented |
| Workspaces | `worktree_list` | Allowed (under the fixed base; lists one level) |
| Volumes | `volume_landed` / `volume_probe` | Not implemented (returns `MachineServer.Unavailable`) |
| Git | `POST /v1/git/capture` | Placeholder (always returns `{repos: []}`) |

> [!WARNING]
> `bash` is off by default (only on with `MAGPIE_CAPY_MACHINE_TOOLS=full`); when on, it runs commands sent by the Capy agent under the **current OS user**, same as the Capy desktop app. Only install trusted plugins, only sign in to trusted accounts, and don't share this device token with anyone.

Browser / computer use is still not implemented.

## Scope

- The headless device implements bash (only in the `full` tier, off by default) / files / workspaces; browser / computer use is unavailable.
- The free ADS models (GLM-5.3-Flash / DeepSeek V4.1 Flash) only allow these exit IPs: US / CA / UK / AU / NZ / IE. The plugin reads `MAGPIE_CAPY_PROXY`, `HTTPS_PROXY`, and the Windows system proxy automatically, and prints `proxy_enabled` (scheme://host:port only, no credentials) in the log; an unsupported exit IP returns `region_unsupported`. This is a Capy server-side restriction the plugin can't bypass.
- No native OpenAI tools; only a `PromptToolBridge` prompt convention, which the Capy agent may ignore.
- No database/queue: the plugin is request-scoped + a local device token.
- Only one `capy` plugin per Magpie.

## License

MIT
