import type {
  ChatMessage,
  ChatRequest,
  ContentPart,
  ToolCall,
  ToolDefinition,
} from "../domain/chat.ts";
import { CapyError, retryAfterSeconds, toOpenAiError } from "../domain/errors.ts";
import type { ChatEvent } from "../domain/chat.ts";

export function parseChatRequest(body: unknown): ChatRequest {
  if (!isRecord(body)) throw invalid("请求体必须是 JSON 对象");
  const messagesRaw = body.messages;
  if (!Array.isArray(messagesRaw) || messagesRaw.length === 0) throw invalid("messages 为空");
  // messages 数上限 200（P3-09）：超限直接拒，不静默截断。
  if (messagesRaw.length > 200) throw invalid("messages 最多 200 条");
  const messages = messagesRaw.map(parseMessage);

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) throw invalid("缺少 model");

  const reasoning = isRecord(body.reasoning) ? body.reasoning : {};
  const reasoningEffort = typeof body.reasoning_effort === "string"
    ? body.reasoning_effort
    : typeof reasoning.effort === "string"
      ? reasoning.effort
      : undefined;

  return {
    model,
    messages,
    // stream 宽松转换："true"/1/"1" 都认（P3-09）。
    stream: body.stream === true || body.stream === 1 || body.stream === "1" || body.stream === "true",
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(Array.isArray(body.tools) ? { tools: body.tools.map(parseTool) } : {}),
    ...(body.tool_choice === undefined ? {} : { toolChoice: body.tool_choice }),
  };
}

function parseMessage(value: unknown): ChatMessage {
  if (!isRecord(value)) throw invalid("messages 里有非对象项");
  const role = value.role;
  if (role !== "system" && role !== "developer" && role !== "user" && role !== "assistant" && role !== "tool") {
    throw invalid(`不支持的 role: ${String(role)}`);
  }
  const content = parseContent(value.content);
  const toolCalls = parseToolCalls(value.tool_calls);
  return {
    role,
    content,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.tool_call_id === "string" ? { toolCallId: value.tool_call_id } : {}),
    ...(toolCalls ? { toolCalls } : {}),
  };
}

function parseToolCalls(value: unknown): ToolCall[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: ToolCall[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const name = typeof fn.name === "string" ? fn.name.trim() : "";
    if (!id || !name) continue;
    const args = fn.arguments;
    const argsText = typeof args === "string"
      ? args
      : args === undefined
        ? "{}"
        : JSON.stringify(args);
    calls.push({ id, name, arguments: argsText });
  }
  return calls.length > 0 ? calls : undefined;
}

function parseContent(value: unknown): string | ContentPart[] {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value.map((part): ContentPart => {
    if (!isRecord(part)) throw invalid("content part 必须是对象");
    const type = part.type;
    if (type === "text" || type === "input_text" || type === "output_text") {
      return { type, text: typeof part.text === "string" ? part.text : "" };
    }
    if (type === "image_url" || type === "input_image" || type === "image") {
      const raw = part.image_url;
      const url = typeof raw === "string"
        ? raw
        : isRecord(raw) && typeof raw.url === "string"
          ? raw.url
          : typeof part.url === "string"
            ? part.url
            : "";
      if (!url) throw invalid("image_url 缺少 url");
      return {
        type,
        url,
        ...(typeof part.name === "string" ? { name: part.name } : {}),
        ...(typeof part.media_type === "string" ? { mediaType: part.media_type } : {}),
      };
    }
    if (type === "file" || type === "input_file") {
      const file = isRecord(part.file) ? part.file : part;
      const name = typeof file.filename === "string"
        ? file.filename
        : typeof file.name === "string"
          ? file.name
          : undefined;
      const data = typeof file.file_data === "string"
        ? file.file_data
        : typeof file.data === "string"
          ? file.data
          : undefined;
      const url = typeof file.url === "string" ? file.url : undefined;
      return {
        type,
        ...(name ? { name } : {}),
        ...(typeof file.media_type === "string" ? { mediaType: file.media_type } : {}),
        ...(data ? { data } : {}),
        ...(url ? { url } : {}),
      };
    }
    throw invalid(`不支持的 content type: ${String(type)}`);
  });
}

function parseTool(value: unknown): ToolDefinition {
  if (!isRecord(value) || value.type !== "function" || !isRecord(value.function)) {
    throw invalid("tools 必须是 function 工具");
  }
  const fn = value.function;
  const name = typeof fn.name === "string" ? fn.name.trim() : "";
  if (!name) throw invalid("tool.function.name 为空");
  return {
    type: "function",
    function: {
      name,
      ...(typeof fn.description === "string" ? { description: fn.description } : {}),
      ...(fn.parameters === undefined ? {} : { parameters: fn.parameters }),
    },
  };
}

export interface ChunkMeta {
  readonly id: string;
  readonly model: string;
  readonly created: number;
}

function encodeChunk(meta: ChunkMeta, delta: Record<string, unknown>, finishReason: string | null = null): string {
  return `data: ${JSON.stringify({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
}

function encodeContentDelta(meta: ChunkMeta, text: string): string {
  return encodeChunk(meta, { content: text });
}

export interface ToolCallOut {
  readonly id: string;
  readonly name: string;
  readonly arguments: string;
}

export interface CompletionUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
}

function usageOf(usage?: CompletionUsage): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
  const promptTokens = Math.max(0, usage?.promptTokens ?? 0);
  const completionTokens = Math.max(0, usage?.completionTokens ?? 0);
  return { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
}

/**
 * 流式用量上报。网关只认流里单独的 usage chunk（choices 为空）：
 * 它收到后才记用量；不发这个 chunk，流式与非流式客户端都显示 0。
 * completionTokens 只能等流结束才知道，所以这里传估算函数，由编码器
 * 在流末尾用累积的正文调用；promptTokens 调用方在请求时已算好。
 */
export interface ChatStreamUsage {
  readonly promptTokens: number;
  readonly estimateCompletionTokens: (text: string) => number;
}

/** 流式用量块：OpenAI 约定，usage 单独一 chunk，choices 为空，放在 stop 之后、[DONE] 之前。 */
function encodeUsageChunk(meta: ChunkMeta, usage: CompletionUsage): string {
  return `data: ${JSON.stringify({
    id: meta.id,
    object: "chat.completion.chunk",
    created: meta.created,
    model: meta.model,
    choices: [],
    usage: usageOf(usage),
  })}\n\n`;
}

export function encodeToolCallCompletion(
  id: string,
  model: string,
  created: number,
  calls: readonly ToolCallOut[],
  usage?: CompletionUsage,
): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      },
      finish_reason: "tool_calls",
    }],
    usage: usageOf(usage),
  }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function encodeToolCallStream(meta: ChunkMeta, calls: readonly ToolCallOut[], usage?: CompletionUsage): Response {
  const body = [
    encodeChunk(meta, { role: "assistant", content: null }),
    encodeChunk(meta, {
      tool_calls: calls.map((call, index) => ({
        index,
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: call.arguments },
      })),
    }),
    encodeChunk(meta, {}, "tool_calls"),
    ...(usage ? [encodeUsageChunk(meta, usage)] : []),
    SSE_DONE,
  ].join("");
  return new Response(body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

export function encodeCompletion(id: string, model: string, created: number, text: string, usage?: CompletionUsage): Response {
  return new Response(JSON.stringify({
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text },
      finish_reason: "stop",
    }],
    usage: usageOf(usage),
  }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

export function encodeErrorResponse(error: unknown): Response {
  const body = toOpenAiError(error);
  const retryAfter = retryAfterSeconds(error);
  return new Response(JSON.stringify(body), {
    status: body.error.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(body.error.status === 401 ? { "x-magpie-sign-in": "expired" } : {}),
      // 只在上游给过 Retry-After 时才发（H-10/M-14）：没有建议值就不发假头。
      ...(body.error.status === 429 && retryAfter !== null ? { "retry-after": String(retryAfter) } : {}),
    },
  });
}

function encodeSseError(error: unknown): string {
  return `data: ${JSON.stringify(toOpenAiError(error))}\n\ndata: [DONE]\n\n`;
}

const SSE_DONE = "data: [DONE]\n\n";

export function encodeModelList(models: readonly { id: string; name: string }[], provider: string): Response {
  return new Response(JSON.stringify({
    object: "list",
    data: models.map((model) => ({
      id: model.id,
      object: "model",
      created: 0,
      owned_by: provider,
      name: model.name,
    })),
  }), { status: 200, headers: { "content-type": "application/json; charset=utf-8" } });
}

/**
 * 把 ChatEvent 流编码成 OpenAI SSE Response（M-11）。
 *
 * `pull()` 逐事件拉取 → 天然背压；`cancel()` 调 onCancel + `iterator.return()`，
 * `closed` 单标志保证：永不 close 后再 enqueue、永不出现两个 `[DONE]`。
 * 首个 role chunk 只在消费到第一个内容事件后才发，不在消费任何事件前无条件 push。
 */
export function encodeChatStream(
  events: AsyncIterable<ChatEvent>,
  meta: ChunkMeta,
  usage?: ChatStreamUsage,
  onCancel?: (reason: unknown) => void,
): Response {
  const encoder = new TextEncoder();
  const iterator = events[Symbol.asyncIterator]();
  let closed = false;
  let roleSent = false;
  let emitted = false;
  let text = "";

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (closed) return;
      const push = (chunk: string) => {
        if (closed) return;
        controller.enqueue(encoder.encode(chunk));
      };
      const sendRole = () => {
        if (roleSent) return;
        roleSent = true;
        push(encodeChunk(meta, { role: "assistant", content: "" }));
      };
      const finish = () => {
        if (closed) return;
        push(encodeChunk(meta, {}, "stop"));
        if (usage) {
          push(encodeUsageChunk(meta, {
            promptTokens: usage.promptTokens,
            completionTokens: usage.estimateCompletionTokens(text),
          }));
        }
        push(SSE_DONE);
        closed = true;
        controller.close();
      };
      const fail = (error: unknown) => {
        if (closed) return;
        push(encodeSseError(error));
        closed = true;
        controller.close();
      };

      for (;;) {
        if (closed) return;
        let step: IteratorResult<ChatEvent>;
        try {
          step = await iterator.next();
        } catch (error) {
          fail(error);
          return;
        }
        if (closed) return;
        if (step.done) {
          // 生成器正常结束但没有 done 事件：按"缺 done"收尾，不发假 stop。
          fail(new CapyError("upstream_unavailable", "上游流在完成前中断"));
          return;
        }
        const event = step.value;
        if (event.type === "delta") {
          sendRole();
          emitted = true;
          text += event.text;
          push(encodeContentDelta(meta, event.text));
          return; // 一次 pull 只吐一块
        }
        if (event.type === "final") {
          if (!emitted && event.text) {
            sendRole();
            emitted = true;
            text = event.text;
            push(encodeContentDelta(meta, event.text));
            return;
          }
          continue;
        }
        if (event.type === "error") {
          fail(event.error);
          return;
        }
        if (event.type === "done") {
          finish();
          return;
        }
      }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true; // 先立标记：之后任何 push 都丢弃
      try {
        onCancel?.(reason);
      } catch {
        // 取消回调不能影响清理
      }
      try {
        await iterator.return?.(undefined);
      } catch {
        // 上游已结束/不可关闭
      }
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(message: string): CapyError {
  return new CapyError("invalid_request", message);
}
