import { STATIC_CATALOG } from "../adapters/capy/static-catalog.ts";
import { CapyAppClient } from "../adapters/capy/app-client.ts";
import { CapyLoginSources } from "../adapters/capy/browser-login.ts";
import { combineCookieInputs, cookieCredentialOf } from "../adapters/capy/cookie-login.ts";
import { HeadlessDeviceRuntime, FileSecretStore } from "../adapters/capy/device-tunnel.ts";
import { CAPY_PUBLIC } from "../adapters/capy/endpoints.ts";
import { CapyPublicClient } from "../adapters/capy/public-client.ts";
import { ConsoleLogger } from "../adapters/platform/console-logger.ts";
import { MemoryCache } from "../adapters/platform/memory-cache.ts";
import { createProxyFetch, resolveProxyUrl } from "../adapters/platform/proxy-fetch.ts";
import { SystemClock } from "../adapters/platform/system-clock.ts";
import { estimateTokens, estimateTokensOfMessages } from "../adapters/platform/token-estimate.ts";
import { SystemIds } from "../adapters/platform/ulid.ts";
import { authRecordOf, sessionOfAuth } from "../adapters/host/magpie-auth.ts";
import { redact } from "../observability/redact.ts";
import { collectAttachments } from "../application/attachments.ts";
import { DeviceUseCase } from "../application/device.ts";
import { CatalogUseCase } from "../application/catalog.ts";
import { ChatUseCase } from "../application/chat.ts";
import { LoginUseCase } from "../application/login.ts";
import { PromptToolBridge } from "../application/tools.ts";
import { UsageUseCase, withDeviceWindow } from "../application/usage.ts";
import type { AccountSession } from "../domain/account.ts";
import type { ChatEvent, ChatRequest } from "../domain/chat.ts";
import { CapyError } from "../domain/errors.ts";
import {
  describeModel,
  EXTRA_FREE_MODELS,
  freeFirst,
  isAdsModel,
  mergeCatalog,
  reasoningModeOf,
  resolveModelId,
} from "../domain/model.ts";
import type { ModelDescriptor } from "../domain/model.ts";
import type { LoginCredential } from "../ports/login.ts";
import {
  encodeChatStream,
  encodeCompletion,
  encodeErrorResponse,
  encodeModelList,
  encodeToolCallCompletion,
  encodeToolCallStream,
  parseChatRequest,
} from "../protocol/openai.ts";

const DEFAULT_PROVIDER_ID = "capy";
const SDK = "@ai-sdk/openai-compatible";
const MAX_CONCURRENCY = 2;
const REFRESH_LEAD_MS = 24 * 3600_000;

interface PluginOptions {
  readonly providerId?: string;
  readonly toolsEnabled?: boolean;
  readonly proxy?: string | false;
  readonly promptVariant?: "auto" | "minimal" | "default";
}

interface MagpieModel {
  readonly id: string;
  readonly providerID: string;
  readonly name: string;
  readonly description?: string;
  readonly free: boolean;
  readonly tool_call: boolean;
  readonly attachment: boolean;
  readonly api: { readonly id: string; readonly url: string; readonly npm: string };
  readonly status: "active";
  readonly headers: Record<string, string>;
  readonly options: Record<string, unknown>;
  readonly limit: Record<string, unknown>;
  readonly modalities: { readonly input: readonly string[]; readonly output: readonly string[] };
  readonly capabilities: {
    readonly temperature: boolean;
    readonly reasoning: boolean;
    readonly attachment: boolean;
    readonly toolcall: boolean;
    readonly input: Record<string, boolean>;
    readonly output: Record<string, boolean>;
    readonly interleaved: boolean;
  };
  readonly variants?: Record<string, Record<string, unknown>>;
}

function toMagpieModel(model: ModelDescriptor, providerId: string, toolsEnabled: boolean): MagpieModel {
  const variants = model.reasoningModes.length > 0
    ? Object.fromEntries(model.reasoningModes.map((mode) => [mode, {}]))
    : undefined;
  return {
    id: model.id,
    providerID: providerId,
    name: isAdsModel(model.id) ? `${model.name} · US/CA/UK/AU/NZ/IE` : model.name,
    ...(isAdsModel(model.id)
      ? { description: "Free with ads — only US / CA / UK / AU / NZ / IE egress IP" }
      : {}),
    free: model.free,
    tool_call: toolsEnabled,
    attachment: true,
    api: { id: model.id, url: CAPY_PUBLIC, npm: SDK },
    status: "active",
    headers: {},
    options: {},
    limit: {},
    modalities: { input: ["text", "image"], output: ["text"] },
    capabilities: {
      temperature: false,
      reasoning: model.reasoningModes.length > 0,
      attachment: true,
      toolcall: toolsEnabled,
      input: { text: true, image: true, audio: false, video: false, pdf: true },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    ...(variants ? { variants } : {}),
  };
}

function modelMap(
  models: readonly ModelDescriptor[],
  providerId: string,
  toolsEnabled: boolean,
): Record<string, MagpieModel> {
  return Object.fromEntries(
    freeFirst(models).map((model) => [model.id, toMagpieModel(model, providerId, toolsEnabled)]),
  );
}

function staticModels(providerId: string, toolsEnabled: boolean): Record<string, MagpieModel> {
  const models = freeFirst(mergeCatalog(STATIC_CATALOG, EXTRA_FREE_MODELS))
    .map((raw) => describeModel(raw, { toolsEnabled }));
  return modelMap(models, providerId, toolsEnabled);
}

async function readJsonBody(input: Request | string | URL, init: RequestInit): Promise<unknown> {
  if (typeof init.body === "string") return JSON.parse(init.body);
  if (init.body instanceof Uint8Array) return JSON.parse(new TextDecoder().decode(init.body));
  if (init.body) return JSON.parse(await new Response(init.body as BodyInit).text());
  if (input instanceof Request) return JSON.parse(await input.text());
  return {};
}

function loginErrorText(error: unknown): string {
  if (error instanceof CapyError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

export default async function CapyNextPlugin(
  _ctx: unknown = {},
  options: PluginOptions = {},
): Promise<Record<string, unknown>> {
  const providerId = String(options.providerId || process.env.MAGPIE_CAPY_PROVIDER_ID || DEFAULT_PROVIDER_ID).trim();
  const toolsEnabled = options.toolsEnabled !== false;
  const configuredVariant = String(
    options.promptVariant ?? process.env.MAGPIE_CAPY_PROMPT_VARIANT ?? "auto",
  ).trim().toLowerCase();
  let minimalUnsupported = configuredVariant === "default" || configuredVariant === "off";

  const proxyUrl = resolveProxyUrl({
    ...(options.proxy === undefined ? {} : { proxy: options.proxy }),
  });
  const fetchImpl = createProxyFetch(fetch, proxyUrl, {
    onWarn: (message) => console.warn(`[magpie-capy] ${message}`),
  });

  const clock = new SystemClock();
  const ids = new SystemIds();
  const logger = new ConsoleLogger("capy");
  if (proxyUrl) {
    let host = "configured";
    try { const parsed = new URL(proxyUrl); host = `${parsed.hostname}:${parsed.port || "default"}`; } catch {}
    logger.event("proxy_enabled", { proxy: host });
  }
  const cache = new MemoryCache(() => clock.now());
  const app = new CapyAppClient(fetchImpl);
  const publicApi = new CapyPublicClient(fetchImpl);
  const store = new FileSecretStore();
  const runtime = new HeadlessDeviceRuntime({ app, store, clock, logger });
  const device = new DeviceUseCase(runtime);
  const login = new LoginUseCase({ app, sources: new CapyLoginSources() });
  const catalog = new CatalogUseCase({
    publicPort: publicApi,
    fallback: STATIC_CATALOG,
    toolsEnabled,
    cache,
  });
  const usage = new UsageUseCase({ publicApi, cache });
  const tools = new PromptToolBridge();
  const chat = new ChatUseCase({ app, publicApi, device, ids, clock, tools, toolsEnabled });
  const initialModels = staticModels(providerId, toolsEnabled);

  async function modelsFor(session: AccountSession): Promise<Record<string, MagpieModel>> {
    try {
      const snapshot = await catalog.load(session.accessToken);
      return modelMap(snapshot.models, providerId, toolsEnabled);
    } catch (error) {
      if (error instanceof CapyError && error.kind === "sign_in_required") throw error;
      return initialModels;
    }
  }

  async function complete(credential: LoginCredential): Promise<Record<string, unknown>> {
    return authRecordOf(await login.complete(credential));
  }

  return {
    config: (cfg: Record<string, unknown>) => {
      const providers = (cfg.provider ??= {}) as Record<string, unknown>;
      providers[providerId] ??= {
        name: "Capy",
        npm: SDK,
        api: CAPY_PUBLIC,
        models: initialModels,
        searches: false,
      };
    },

    auth: {
      provider: providerId,
      maxConcurrency: MAX_CONCURRENCY,
      refreshLead: REFRESH_LEAD_MS,
      methods: [
        {
          type: "oauth",
          label: "从本机 Capy 客户端导入（只登录，不需要运行桌面端）",
          async authorize() {
            const probe = login.login("local").then((session) => authRecordOf(session));
            probe.catch(() => {});
            return {
              url: "https://capy.ai",
              opened: true,
              method: "auto",
              instructions: "正在读取本机 Capy 登录态（只读登录凭据，不需要启动 Capy 桌面端）…",
              async callback() {
                try {
                  return await probe;
                } catch (error) {
                  return { type: "failed", error: loginErrorText(error) };
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "浏览器登录（Google / GitHub / Passkey / 邮箱）",
          async authorize() {
            const controller = new AbortController();
            const probe = login.login("browser", controller.signal).then((session) => authRecordOf(session));
            probe.catch(() => {});
            return {
              url: "https://capy.ai/sign-in",
              opened: true,
              method: "auto",
              instructions:
                "已打开 Capy 官方登录页。用 Google、GitHub、Passkey 或邮箱登录；"
                + "登录成功后会自动读取登录态，不需要复制任何东西。",
              close: () => controller.abort(),
              async callback(
                _value: unknown,
                callbackOptions: { signal?: AbortSignal } = {},
              ) {
                const onAbort = () => controller.abort();
                callbackOptions.signal?.addEventListener("abort", onAbort, { once: true });
                try {
                  return await probe;
                } catch (error) {
                  return { type: "failed", error: loginErrorText(error) };
                } finally {
                  callbackOptions.signal?.removeEventListener("abort", onAbort);
                  controller.abort();
                }
              },
            };
          },
        },
        {
          type: "oauth",
          label: "粘贴 Cookie 登录（无头 / 服务器适用）",
          prompts: [
            {
              type: "text",
              key: "clerkCookie",
              message: "粘贴 clerk 请求的完整 Cookie 请求头（从 Network（网络）→ clerk.capy.ai 请求 → Request Headers（请求标头）复制，必须包含 __client）",
            },
            {
              type: "text",
              key: "sessionCookie",
              message: "粘贴 __session 的值（从 Application（应用）→ Cookies（Cookie）→ https://capy.ai → __session 复制完整值；若没有 __session，可粘贴 __session_VSH_xxx 的值，或直接填 Clerk session id）",
            },
          ],
          async authorize(inputs: Record<string, unknown> = {}) {
            const probe = (async () => {
              const combined = combineCookieInputs(
                typeof inputs.clerkCookie === "string" ? inputs.clerkCookie : "",
                typeof inputs.sessionCookie === "string" ? inputs.sessionCookie : "",
              );
              return authRecordOf(await login.complete(cookieCredentialOf(combined)));
            })();
            probe.catch(() => {});
            return {
              url: "",
              method: "auto",
              instructions: "正在用两段 Cookie 登录…",
              async callback() {
                try {
                  return await probe;
                } catch (error) {
                  return { type: "failed", error: redact(loginErrorText(error)) };
                }
              },
            };
          },
        },
      ],

      async refresh(auth: Record<string, unknown>) {
        let session: AccountSession;
        try {
          session = sessionOfAuth(auth);
        } catch {
          throw Object.assign(new Error("Capy 登录已失效，请重新登录"), { signIn: "expired" });
        }
        try {
          await publicApi.listModels(session.accessToken);
          return { access: session.accessToken, expires: Date.now() + 7 * 24 * 3600_000 };
        } catch (error) {
          if (!(error instanceof CapyError) || error.kind !== "sign_in_required") return undefined;
        }
        try {
          const renewed = await complete({
            clientJwt: session.clerk.clientJwt,
            sessionId: session.clerk.sessionId,
            userId: session.uid,
            orgId: session.orgId,
            clientId: session.clientId,
            source: "refresh",
          });
          return {
            access: typeof renewed.access === "string" ? renewed.access : "",
            expires: typeof renewed.expires === "number" ? renewed.expires : Date.now() + 7 * 24 * 3600_000,
          };
        } catch {
          throw Object.assign(new Error("Capy 登录已失效，请重新登录"), { signIn: "expired" });
        }
      },

      async loader(getAuth: () => Promise<Record<string, unknown> | null>) {
        return {
          baseURL: CAPY_PUBLIC,
          apiKey: "",
          headers: {},
          async fetch(input: Request | string | URL, init: RequestInit = {}): Promise<Response> {
            const auth = await getAuth();
            let session: AccountSession;
            try {
              session = sessionOfAuth(auth);
            } catch (error) {
              return encodeErrorResponse(error);
            }
            const request = input instanceof Request ? input : null;
            const url = typeof input === "string"
              ? input
              : input instanceof URL
                ? input.toString()
                : request?.url ?? "";
            const method = String(init.method ?? request?.method ?? "GET").toUpperCase();
            const route = url.split("?")[0] ?? "";
            const signal = init.signal ?? request?.signal ?? undefined;

            try {
              if (method === "GET" && /\/models$/u.test(route)) {
                const models = await modelsFor(session);
                return encodeModelList(
                  Object.values(models).map((model) => ({ id: model.id, name: model.name })),
                  providerId,
                );
              }
              if (!/\/chat\/completions$/u.test(route)) {
                return encodeErrorResponse(new CapyError("not_implemented", `该端点没有实现：${method} ${url}`));
              }

              let body: unknown;
              try {
                body = await readJsonBody(input, init);
              } catch {
                return encodeErrorResponse(new CapyError("invalid_request", "请求体不是合法 JSON"));
              }
              const requestBody: ChatRequest = parseChatRequest(body);
              // 上游不返回用量；非流式 completion 用估算值上报（近似，非精确计数）。
              const promptTokens = estimateTokensOfMessages(requestBody.messages);
              const snapshot = await catalog.load(session.accessToken, signal);
              const modelId = resolveModelId(requestBody.model, snapshot.models);
              const model = snapshot.models.find((item) => item.id === modelId);
              const reasoningMode = reasoningModeOf(requestBody, model);
              const prepared = await collectAttachments(requestBody.messages, {
                fetchImpl,
                ...(signal ? { signal } : {}),
              });
              const files = prepared.attachments.length > 0
                ? await publicApi.uploadFiles(session.accessToken, prepared.attachments, signal)
                : [];
              let activeThreadId = "";
              const onAbort = () => {
                if (activeThreadId) void chat.cancel(session, activeThreadId);
              };
              signal?.addEventListener("abort", onAbort, { once: true });
              const events = chat.stream(session, {
                ...requestBody,
                messages: prepared.messages,
              }, {
                ...(signal ? { signal } : {}),
                ...(reasoningMode ? { reasoningMode } : {}),
                ...(files.length > 0 ? { files } : {}),
                onThread: (thread) => { activeThreadId = thread.id; },
                onVariantFallback: () => { minimalUnsupported = true; },
                ...(minimalUnsupported ? {} : { promptVariant: "minimal" as const }),
              });
              const meta = {
                id: `chatcmpl-${ids.ulid()}`,
                model: modelId,
                created: Math.floor(clock.now() / 1000),
              };

              const wantsTools = toolsEnabled && (requestBody.tools?.length ?? 0) > 0;
              if (wantsTools) {
                const text = await textOf(events);
                const parsed = text ? tools.parse(text) : null;
                if (parsed) {
                  const calls = parsed.calls.map((call) => ({
                    id: `call_${ids.ulid()}`,
                    name: call.name,
                    arguments: call.arguments,
                  }));
                  return requestBody.stream
                    ? encodeToolCallStream(meta, calls, {
                      promptTokens,
                      completionTokens: estimateTokens(calls.map((call) => `${call.name}${call.arguments}`).join("")),
                    })
                    : encodeToolCallCompletion(meta.id, meta.model, meta.created, calls, {
                      promptTokens,
                      completionTokens: estimateTokens(calls.map((call) => `${call.name}${call.arguments}`).join("")),
                    });
                }
                return requestBody.stream
                  ? encodeChatStream(textEvents(text), meta, { promptTokens, estimateCompletionTokens: estimateTokens })
                  : encodeCompletion(meta.id, meta.model, meta.created, text, {
                    promptTokens,
                    completionTokens: estimateTokens(text),
                  });
              }

              if (requestBody.stream) return encodeChatStream(events, meta, { promptTokens, estimateCompletionTokens: estimateTokens });
              const text = await textOf(events);
              return encodeCompletion(meta.id, meta.model, meta.created, text, {
                promptTokens,
                completionTokens: estimateTokens(text),
              });
            } catch (error) {
              return encodeErrorResponse(error);
            }
          },
        };
      },

      async usage(getAuth: () => Promise<Record<string, unknown> | null>) {
        let session: AccountSession;
        try {
          session = sessionOfAuth(await getAuth());
        } catch {
          return { error: "未登录", windows: [] };
        }
        try {
          const snapshot = await usage.load(session.accessToken);
          let deviceWindow: { connected: boolean; name: string } = { connected: false, name: "" };
          try {
            const info = await device.ensure(session);
            deviceWindow = { connected: true, name: info.name };
          } catch {
            deviceWindow = { connected: false, name: "" };
          }
          return withDeviceWindow(snapshot, deviceWindow);
        } catch (error) {
          if (error instanceof CapyError && error.kind === "sign_in_required") {
            return { error: "Capy 登录已失效，请重新登录", windows: [], signIn: "expired" };
          }
          return { error: loginErrorText(error), windows: [] };
        }
      },
    },

    provider: {
      id: providerId,
      async models(_fallback: unknown, context: { auth?: Record<string, unknown> } = {}) {
        try {
          return await modelsFor(sessionOfAuth(context.auth));
        } catch {
          return initialModels;
        }
      },
    },
  };
}

async function* textEvents(text: string): AsyncIterable<ChatEvent> {
  if (text) yield { type: "delta", text };
  yield { type: "done" };
}

async function textOf(events: AsyncIterable<ChatEvent>): Promise<string> {
  let text = "";
  for await (const event of events) {
    if (event.type === "delta") text += event.text;
    else if (event.type === "final" && !text) text = event.text;
    else if (event.type === "error") throw event.error;
  }
  return text;
}
