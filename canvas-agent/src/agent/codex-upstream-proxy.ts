import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { logger } from "../utils/logger.js";
import { codexUpstreamBaseUrl, readCodexDefaults } from "./codex-config.js";

/**
 * 上游工具形态兼容层（Codex → 第三方 OpenAI 兼容网关）。
 *
 * Codex 0.146 会在 `/v1/responses` 请求里下发两类官方专有工具，第三方网关（如 agnes-ai）
 * 的反序列化器只接受 `function` / `web_search_preview` / `code_interpreter` / `mcp`：
 *
 *   - `{ "type": "web_search" }` —— 官方托管搜索。上游拒绝，报
 *     `tools[N].type: unknown variant 'web_search'`（400）。改写为上游接受的
 *     `web_search_preview` 即可（已实测 200）。
 *   - `{ "type": "namespace", "name": "multi_agent_v1", "tools": [...] }` —— 工具命名空间分组。
 *     上游报 `tools[N].type: unknown variant 'namespace'`（400）。**没有任何 Codex 配置项能在
 *     app-server 模式下移除它**（`-c` 被线程级 config 覆盖，`features.multi_agent=false` 只在
 *     `codex exec` 生效）。因此在这里把 namespace 内的每个 function 提升为顶层 function、
 *     名字加 `命名空间__` 前缀，保持模型可见的工具集合不变。
 *
 * 实现方式：本机起一个只监听回环的 HTTP 服务，把 Codex 的请求原样转发到 config.toml 里
 * 声明的真实上游，仅在转发前改写 `tools`。SSE 流式响应用管道透传，不做缓冲。
 *
 * 只对非官方 provider 启用；官方 `openai` provider 保持原样，不削减其原生能力。
 */

/** 上游能接受的非 function 工具类型（实测）。 */
const UPSTREAM_NATIVE_TOOL_TYPES = new Set(["function", "web_search_preview", "code_interpreter", "mcp"]);
/** 官方 Codex 专有、第三方网关一律不认、需要就地改写或拍平的类型。 */
const WEB_SEARCH_TYPES = new Set(["web_search", "web_search_preview", "web_search_preview_2025_03_11"]);

type ToolRecord = Record<string, unknown>;

/**
 * 按上游能力改写 tools 数组。
 *
 * - `namespace` → 其内部 function 全部提升为顶层 function，名字加前缀避免冲突
 * - `web_search` → `web_search_preview`（已经是 preview 的保持原样）
 * - 其余未知类型 → 丢弃（丢弃好过让整轮 400 失败）
 */
export function normalizeUpstreamTools(rawTools: unknown): { tools: ToolRecord[]; flattened: number; rewritten: number; dropped: number } {
    if (!Array.isArray(rawTools)) return { tools: [], flattened: 0, rewritten: 0, dropped: 0 };
    const tools: ToolRecord[] = [];
    let flattened = 0;
    let rewritten = 0;
    let dropped = 0;

    for (const raw of rawTools) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const tool = raw as ToolRecord;
        const type = String(tool.type || "");

        if (type === "namespace") {
            const prefix = String(tool.name || "namespace");
            const inner = Array.isArray(tool.tools) ? tool.tools : [];
            for (const child of inner) {
                if (!child || typeof child !== "object" || Array.isArray(child)) continue;
                const record = child as ToolRecord;
                if (String(record.type || "") !== "function") {
                    dropped += 1;
                    continue;
                }
                const name = String(record.name || "");
                if (!name) {
                    dropped += 1;
                    continue;
                }
                const next: ToolRecord = { ...record, name: `${prefix}__${name}` };
                // 被拍平后不再归属某个命名空间，去掉可能存在的嵌套分组字段
                delete next.tools;
                tools.push(next);
                flattened += 1;
            }
            continue;
        }

        if (WEB_SEARCH_TYPES.has(type)) {
            if (type === "web_search") {
                tools.push({ type: "web_search_preview" });
                rewritten += 1;
            } else {
                tools.push(tool);
            }
            continue;
        }

        if (UPSTREAM_NATIVE_TOOL_TYPES.has(type)) {
            tools.push(tool);
            continue;
        }

        logger.debug("Dropping unsupported tool for upstream provider", { type, name: tool.name });
        dropped += 1;
    }

    return { tools, flattened, rewritten, dropped };
}

/**
 * 上游 `/v1/responses` 的 `input` 条目里，`type: "reasoning"` **在任何形态下都无法通过反序列化**
 * （`ResponseInput` 是 untagged enum，实测保留 content / 只留 summary / 换 content 类型均报
 * `data did not match any variant of untagged enum ResponseInput`）。
 *
 * 该条目承载的是上一轮的思考摘要，属于可丢弃的冗余上下文 —— 真正的对话内容在
 * `message` 条目里。丢弃后上游正常返回 200（已实测），因此这里在转发前剔除。
 */
export function stripReasoningItems(input: unknown): { input: unknown; removed: number } {
    if (!Array.isArray(input)) return { input, removed: 0 };
    const kept = input.filter((item) => !(item && typeof item === "object" && !Array.isArray(item) && String((item as ToolRecord).type || "") === "reasoning"));
    return { input: kept, removed: input.length - kept.length };
}

/** 需要改写 `tools`/`input` 的请求体（只处理 /responses 的 POST JSON）。 */
function adaptResponsesBody(original: Buffer): { body: Buffer<ArrayBuffer>; changed: boolean } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(original.toString("utf8"));
    } catch {
        return { body: asBuffer(original), changed: false };
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { body: asBuffer(original), changed: false };
    const payload = parsed as ToolRecord;

    let changed = false;
    let toolsBefore = 0;
    let toolsAfter = 0;
    let flattened = 0;
    let rewritten = 0;
    let dropped = 0;

    if (Array.isArray(payload.tools)) {
        const result = normalizeUpstreamTools(payload.tools);
        toolsBefore = payload.tools.length;
        toolsAfter = result.tools.length;
        flattened = result.flattened;
        rewritten = result.rewritten;
        dropped = result.dropped;
        payload.tools = result.tools;
        if (flattened || rewritten || dropped) changed = true;
    }

    const stripped = stripReasoningItems(payload.input);
    if (stripped.removed) {
        payload.input = stripped.input;
        changed = true;
    }

    if (changed) {
        logger.info("Adapted Codex request for upstream provider", { toolsBefore, toolsAfter, flattened, rewritten, dropped, reasoningRemoved: stripped.removed });
    }
    return { body: changed ? asBuffer(Buffer.from(JSON.stringify(payload), "utf8")) : asBuffer(original), changed };
}

/** 统一 Buffer 泛型，避免 Buffer<ArrayBufferLike> 与 Buffer<ArrayBuffer> 互不兼容。 */
function asBuffer(value: Buffer): Buffer<ArrayBuffer> {
    return value as unknown as Buffer<ArrayBuffer>;
}

/* ============================================================================================
 * Responses → Chat Completions 桥接
 *
 * 有些第三方网关（实测：api.agnes-ai.cn）把 `POST /v1/responses` 做成了**空壳**：返回的
 * `response.created` / `response.completed` 里 `response` 就是请求本身的回显（`output: []`），
 * 不含任何模型输出；带图片时直接 400（其 responses→chat 转换器只认纯文本）；并发高时还会
 * `400 503: The request queue is full.` 或把连接掐掉（Codex 表现为
 * `stream disconnected before completion: error sending request for url (...)`）。
 *
 * 但同一网关的 `POST /v1/chat/completions` 是**完好的**：文本增量、函数调用（tool_calls 增量 +
 * finish_reason）、图片输入（`image_url` data URL，实测 usage 里带 image_tokens）都支持。
 *
 * 因此对这些上游把 Responses 请求翻译成 Chat Completions，再把流式 chat 增量翻译回 Responses
 * 事件流，Codex 侧完全无感。**只对命中名单或显式开关的上游启用**，其余上游保持原样转发。
 *
 * 开关：config.toml 顶层 `canvas_responses_via_chat = true | false`（覆盖默认的按域名判断）。
 * ========================================================================================== */

/** 已知把 `/responses` 做成空壳、但 `/chat/completions` 完好的网关域名。 */
const CHAT_BRIDGE_HOSTS = new Set(["api.agnes-ai.cn"]);

/** 请求 → chat：Responses 的 content parts 转成 chat 的 content。 */
function toChatContent(parts: unknown): { content: unknown; images: number } {
    let images = 0;
    if (!Array.isArray(parts)) return { content: typeof parts === "string" ? parts : "", images };
    const out: ToolRecord[] = [];
    for (const raw of parts) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const part = raw as ToolRecord;
        const type = String(part.type || "");
        if ((type === "input_text" || type === "output_text" || type === "text") && typeof part.text === "string") {
            out.push({ type: "text", text: part.text });
            continue;
        }
        if (type === "input_image" || type === "image_url") {
            const url = imageUrlOf(part);
            if (!url) continue;
            const detail = typeof part.detail === "string" ? part.detail : "";
            out.push({ type: "image_url", image_url: detail ? { url, detail } : { url } });
            images += 1;
            continue;
        }
        if (type === "refusal" && typeof part.refusal === "string") out.push({ type: "text", text: part.refusal });
    }
    // 单段纯文本用字符串形式（部分网关的 content 只接受 string）
    if (out.length === 1 && out[0].type === "text") return { content: out[0].text, images };
    return { content: out, images };
}

function imageUrlOf(part: ToolRecord): string {
    const value = part.image_url ?? part.image ?? part.url;
    if (typeof value === "string") return value;
    if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as ToolRecord).url === "string") {
        return String((value as ToolRecord).url);
    }
    return "";
}

/**
 * Responses 请求体 → Chat Completions 请求体。
 *
 * 只做结构搬运，不改语义：`instructions` → system 消息，`input` 逐条映射为
 * user/assistant/tool 消息（`function_call`/`function_call_output` 归位成 tool_calls / tool 消息），
 * `tools` 由 Responses 的平铺 function 形状包成 chat 的 `{type:"function", function:{...}}`。
 */
export function responsesToChatRequest(payload: ToolRecord, model: string): { chat: ToolRecord; images: number; dropped: number } {
    const messages: ToolRecord[] = [];
    let images = 0;
    let dropped = 0;

    const instructions = typeof payload.instructions === "string" ? payload.instructions.trim() : "";
    if (instructions) messages.push({ role: "system", content: instructions });

    let pendingToolCalls: ToolRecord[] = [];
    const flushToolCalls = () => {
        if (!pendingToolCalls.length) return;
        messages.push({ role: "assistant", content: null, tool_calls: pendingToolCalls });
        pendingToolCalls = [];
    };

    const input = Array.isArray(payload.input) ? payload.input : [];
    for (const raw of input) {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
        const item = raw as ToolRecord;
        const type = String(item.type || "");

        if (type === "message") {
            flushToolCalls();
            const rawRole = String(item.role || "user").toLowerCase();
            const role = rawRole === "developer" ? "system" : rawRole === "assistant" || rawRole === "system" || rawRole === "tool" ? rawRole : "user";
            const converted = toChatContent(item.content);
            images += converted.images;
            messages.push({ role, content: converted.content });
            continue;
        }

        if (type === "function_call" || type === "custom_tool_call") {
            const callId = String(item.call_id || item.id || "");
            const name = String(item.name || "");
            if (!callId || !name) {
                dropped += 1;
                continue;
            }
            const args = type === "custom_tool_call" ? JSON.stringify({ input: item.input ?? "" }) : String(item.arguments ?? "");
            pendingToolCalls.push({ id: callId, type: "function", function: { name, arguments: args } });
            continue;
        }

        if (type === "function_call_output" || type === "custom_tool_call_output") {
            flushToolCalls();
            const callId = String(item.call_id || "");
            if (!callId) {
                dropped += 1;
                continue;
            }
            const output = typeof item.output === "string" ? item.output : JSON.stringify(item.output ?? "");
            messages.push({ role: "tool", tool_call_id: callId, content: output });
            continue;
        }

        // reasoning 摘要属可丢弃的冗余上下文（上游兼容层已剥离，这里兜底）
        if (type === "reasoning") continue;
        dropped += 1;
    }
    flushToolCalls();

    const tools: ToolRecord[] = [];
    if (Array.isArray(payload.tools)) {
        for (const raw of payload.tools) {
            if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
            const tool = raw as ToolRecord;
            if (String(tool.type || "") !== "function") continue;
            const name = String(tool.name || "");
            if (!name) continue;
            const fn: ToolRecord = { name };
            if (typeof tool.description === "string") fn.description = tool.description;
            if (tool.parameters && typeof tool.parameters === "object") fn.parameters = tool.parameters;
            if (typeof tool.strict === "boolean") fn.strict = tool.strict;
            tools.push({ type: "function", function: fn });
        }
    }

    const chat: ToolRecord = { model, messages, stream: true, stream_options: { include_usage: true } };
    if (tools.length) {
        chat.tools = tools;
        const choice = payload.tool_choice;
        if (typeof choice === "string") chat.tool_choice = choice;
        else if (choice && typeof choice === "object" && !Array.isArray(choice)) {
            const name = String((choice as ToolRecord).name || "");
            chat.tool_choice = name ? { type: "function", function: { name } } : "auto";
        }
        if (typeof payload.parallel_tool_calls === "boolean") chat.parallel_tool_calls = payload.parallel_tool_calls;
    }

    return { chat, images, dropped };
}

/** chat 的 usage → Responses 的 usage。 */
function toResponsesUsage(raw: unknown): ToolRecord {
    const source = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as ToolRecord) : {};
    const inputTokens = Number(source.prompt_tokens || 0) || 0;
    const outputTokens = Number(source.completion_tokens || 0) || 0;
    const promptDetails = source.prompt_tokens_details && typeof source.prompt_tokens_details === "object" ? (source.prompt_tokens_details as ToolRecord) : {};
    const completionDetails = source.completion_tokens_details && typeof source.completion_tokens_details === "object" ? (source.completion_tokens_details as ToolRecord) : {};
    return {
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        total_tokens: Number(source.total_tokens || inputTokens + outputTokens) || inputTokens + outputTokens,
        input_tokens_details: { cached_tokens: Number(promptDetails.cached_tokens || 0) || 0 },
        output_tokens_details: { reasoning_tokens: Number(completionDetails.reasoning_tokens || 0) || 0 },
    };
}

function shortId(prefix: string): string {
    let text = "";
    for (let i = 0; i < 24; i += 1) text += "0123456789abcdef"[Math.floor(Math.random() * 16)];
    return `${prefix}${text}`;
}

export type ChatStreamTranslator = {
    /** 喂入 chat SSE 的一段原始文本，返回需要写回 Codex 的 responses SSE 文本。 */
    push(chunk: string): string;
    /** 流结束：补齐 done 事件与 response.completed。幂等。 */
    finish(): string;
    /** 上游中途失败：尽量让 Codex 看到失败原因，并把该轮正常收尾。 */
    failed(message: string): string;
    /** 是否已经产出过正文/工具调用。 */
    hasContent(): boolean;
};

/**
 * 本轮请求里模型可见的 function 工具名（canonical）。
 * 由 forward() 从转换后的 chat.tools 收集，供工具名纠偏使用。
 */
type ToolNameResolver = (called: string) => string;

/** 无纠偏的恒等 resolver（未启用或没有工具清单时使用）。 */
const identityToolName: ToolNameResolver = (called) => called;

/**
 * 工具名纠偏。
 *
 * 背景（2026-10-02 实测，rollout rollout-2026-10-02T05-01-59-*）：第三方免费模型（agnes-2.5-flash）
 * 会把 Codex 暴露的 MCP 工具名 `mcp__infinite-canvas__canvas_get_state`（服务名含连字符）规范成
 * 标识符风格 `mcp__infinite_canvas__canvas_get_state`（下划线）。Codex 的工具注册表按名字精确
 * 匹配，对不上就以 `unsupported call: <名字>` 作为工具输出返回给模型 —— 模型于是认为
 * 「MCP 工具不可用」，画布工具全部调不动。
 *
 * 这里在桥接层把模型发出的工具名对照本轮请求的 canonical 工具清单做宽容匹配：
 *   1) 精确匹配 → 原样；
 *   2) 连字符/下划线 + 大小写归一后唯一命中 → 改写为 canonical；
 *   3) 剥掉 `mcp__<server>__` 前缀后的裸名归一后唯一命中 → 改写为 canonical
 *      （兼容模型按 AGENTS.md 的裸名指令直接调 `canvas_get_state`）；
 *   4) canonical 去前缀后以 `__<裸名>` 结尾的唯一命中 → 改写为 canonical；
 *   5) 其余（真幻觉名、多义匹配）保持原样，交由 Codex 报错。
 * 只在「唯一命中」时改写，避免歧义改写造成错误调用。
 */
export function createToolNameResolver(knownTools: Set<string> | undefined): ToolNameResolver {
    if (!knownTools || knownTools.size === 0) return identityToolName;
    const canonical = [...knownTools];
    const normalized = (value: string) => value.toLowerCase().replace(/-/g, "_");
    const bareOf = (value: string) => (value.includes("__") ? value.split("__").pop() || value : value);
    const warnOnce = new Set<string>();

    return (called: string): string => {
        if (!called || knownTools.has(called)) return called;
        const calledNorm = normalized(called);
        if (!calledNorm) return called;

        const byFull = canonical.filter((name) => normalized(name) === calledNorm);
        if (byFull.length === 1) return byFull[0];

        const calledBare = normalized(bareOf(called));
        const byBare = canonical.filter((name) => normalized(bareOf(name)) === calledBare);
        if (byBare.length === 1) return byBare[0];

        const bySuffix = canonical.filter((name) => normalized(name).endsWith("__" + calledNorm));
        if (bySuffix.length === 1) return bySuffix[0];

        if (!warnOnce.has(called)) {
            warnOnce.add(called);
            logger.warn("Model called an unknown tool name; no unambiguous canonical match", { called });
        }
        return called;
    };
}

/**
 * Chat Completions 流式增量 → Responses 事件流。
 *
 * 事件名与字段按 OpenAI Responses 的 SSE 规范，与官方/上游正常回包保持一致；
 * 输出项顺序即 `response.output` 的顺序（message 与 function_call 按首次出现排序）。
 */
export function createChatStreamTranslator(options: { model: string; instructions?: string; parallelToolCalls?: boolean; toolChoice?: unknown; toolNames?: Set<string> }): ChatStreamTranslator {
    const resolveToolName = createToolNameResolver(options.toolNames);
    const responseId = shortId("resp_");
    const createdAt = Math.floor(Date.now() / 1000);
    let sequence = 0;
    let buffer = "";
    let started = false;
    let finished = false;
    let preamble = "";
    let outputIndex = 0;
    let usage: unknown = null;
    const items: { index: number; item: ToolRecord }[] = [];
    let message: { id: string; index: number; text: string } | null = null;
    const calls = new Map<number, { id: string; callId: string; name: string; args: string; index: number; announced: boolean }>();

    const baseResponse = (status: string): ToolRecord => ({
        id: responseId,
        object: "response",
        created_at: createdAt,
        status,
        model: options.model,
        output: [],
        instructions: options.instructions ?? null,
        metadata: {},
        parallel_tool_calls: options.parallelToolCalls ?? false,
        tool_choice: options.toolChoice ?? "auto",
        tools: [],
        temperature: 1,
        top_p: 1,
        max_output_tokens: null,
        reasoning: null,
        truncation: "disabled",
        store: false,
    });

    const frame = (event: ToolRecord) => {
        sequence += 1;
        return `data: ${JSON.stringify({ ...event, sequence_number: sequence, model: options.model })}\n\n`;
    };

    const ensureStarted = () => {
        if (started) return "";
        started = true;
        preamble = frame({ type: "response.created", response: baseResponse("in_progress") }) + frame({ type: "response.in_progress", response: baseResponse("in_progress") });
        return preamble;
    };

    /** 处理一条 SSE data 负载，返回要写回的文本。 */
    const handle = (payload: string): string => {
        if (!payload || payload === "[DONE]") return "";
        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch {
            return "";
        }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "";
        const record = parsed as ToolRecord;
        if (record.usage) usage = record.usage;
        const choices = Array.isArray(record.choices) ? record.choices : [];
        const choice = choices.length && choices[0] && typeof choices[0] === "object" ? (choices[0] as ToolRecord) : null;
        if (!choice) return "";
        const delta = choice.delta && typeof choice.delta === "object" ? (choice.delta as ToolRecord) : {};
        let out = "";

        if (typeof delta.content === "string" && delta.content) {
            if (!message) {
                message = { id: shortId("msg_"), index: outputIndex++, text: "" };
                out += frame({ type: "response.output_item.added", output_index: message.index, item: { id: message.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
                out += frame({ type: "response.content_part.added", item_id: message.id, output_index: message.index, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
            }
            message.text += delta.content;
            out += frame({ type: "response.output_text.delta", item_id: message.id, output_index: message.index, content_index: 0, delta: delta.content });
        }

        const toolCalls = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
        for (const rawCall of toolCalls) {
            if (!rawCall || typeof rawCall !== "object" || Array.isArray(rawCall)) continue;
            const call = rawCall as ToolRecord;
            const index = typeof call.index === "number" ? call.index : 0;
            const fn = call.function && typeof call.function === "object" ? (call.function as ToolRecord) : {};
            let entry = calls.get(index);
            if (!entry) {
                entry = { id: shortId("fc_"), callId: String(call.id || shortId("call_")), name: fn.name ? resolveToolName(String(fn.name)) : "", args: "", index: outputIndex++, announced: false };
                calls.set(index, entry);
            } else if (!entry.name && fn.name) entry.name = resolveToolName(String(fn.name));
            if (!entry.announced) {
                entry.announced = true;
                out += frame({ type: "response.output_item.added", output_index: entry.index, item: { id: entry.id, type: "function_call", status: "in_progress", call_id: entry.callId, name: entry.name, arguments: "" } });
            }
            if (typeof fn.arguments === "string" && fn.arguments) {
                entry.args += fn.arguments;
                out += frame({ type: "response.function_call_arguments.delta", item_id: entry.id, output_index: entry.index, delta: fn.arguments });
            }
        }
        return out;
    };

    /** 汇总 output 数组并补齐 done 事件。 */
    const close = (): string => {
        if (finished) return "";
        finished = true;
        let out = message
            ? frame({ type: "response.output_text.done", item_id: message.id, output_index: message.index, content_index: 0, text: message.text }) +
              frame({ type: "response.content_part.done", item_id: message.id, output_index: message.index, content_index: 0, part: { type: "output_text", text: message.text, annotations: [] } }) +
              frame({
                  type: "response.output_item.done",
                  output_index: message.index,
                  item: { id: message.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message.text, annotations: [] }] },
              })
            : "";
        if (message) items.push({ index: message.index, item: { id: message.id, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message.text, annotations: [] }] } });
        for (const entry of [...calls.values()].sort((a, b) => a.index - b.index)) {
            out += frame({ type: "response.function_call_arguments.done", item_id: entry.id, output_index: entry.index, arguments: entry.args });
            const item = { id: entry.id, type: "function_call", status: "completed", call_id: entry.callId, name: entry.name, arguments: entry.args };
            out += frame({ type: "response.output_item.done", output_index: entry.index, item });
            items.push({ index: entry.index, item });
        }
        const output = items.sort((a, b) => a.index - b.index).map((entry) => entry.item);
        out += frame({ type: "response.completed", response: { ...baseResponse("completed"), output, usage: toResponsesUsage(usage) } });
        return out;
    };

    return {
        push(chunk: string): string {
            let out = ensureStarted();
            buffer += chunk;
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";
            for (const rawLine of lines) {
                const line = rawLine.replace(/\r$/, "");
                if (!line.startsWith("data:")) continue;
                out += handle(line.slice(5).trim());
            }
            return out;
        },
        finish(): string {
            return ensureStarted() + close();
        },
        failed(message: string): string {
            let out = ensureStarted();
            out += frame({ type: "response.failed", response: { ...baseResponse("failed"), error: { code: "upstream_error", message } } });
            // 兜底收尾：即便 Codex 不认 response.failed，也能结束该轮，不至于卡在「等待」。
            out += close();
            return out;
        },
        hasContent(): boolean {
            return Boolean(message) || calls.size > 0;
        },
    };
}

/** 是否需要把 Responses 请求桥接到 Chat Completions。 */
export function chatBridgeEnabled(): boolean {
    const raw = (readCodexDefaults().chatBridge || "").trim().toLowerCase();
    if (/^(true|1|yes|on)$/.test(raw)) return true;
    if (/^(false|0|no|off)$/.test(raw)) return false;
    const upstream = codexUpstreamBaseUrl();
    if (!upstream) return false;
    try {
        return CHAT_BRIDGE_HOSTS.has(new URL(upstream).hostname.toLowerCase());
    } catch {
        return false;
    }
}

let proxyServer: Server | null = null;
let proxyPort = 0;

/** 转发层是否承载真实上游（config.toml 声明了非官方 provider 才需要）。 */
export function upstreamProxyEnabled() {
    return Boolean(codexUpstreamBaseUrl());
}

/** 转发层在当前进程内的回环地址；未启动或未启用时返回 undefined。 */
export function upstreamProxyUrl(): string | undefined {
    // 注意：Codex 会自行追加 `/v1/responses`，这里只能给到 origin，多带一段路径会 404
    return proxyServer && proxyPort ? `http://127.0.0.1:${proxyPort}` : undefined;
}

/** 幂等启动回环转发层。 */
export async function ensureUpstreamProxy(): Promise<string | undefined> {
    if (!upstreamProxyEnabled()) return undefined;
    if (proxyServer) return upstreamProxyUrl();
    const upstream = codexUpstreamBaseUrl();
    if (!upstream) return undefined;

    const server = createServer((req, res) => {
        void forward(req, res, upstream).catch((error) => {
            logger.warn("Upstream proxy forward failed", { error: error instanceof Error ? error.message : String(error) });
            if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } }));
        });
    });

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });

    const address = server.address();
    if (!address || typeof address === "string") {
        server.close();
        throw new Error("上游转发层没有拿到可用端口");
    }
    proxyServer = server;
    proxyPort = address.port;
    logger.info("Upstream tool-compat proxy started", { port: proxyPort, upstream });
    return upstreamProxyUrl();
}

/** 进程退出时释放端口。 */
export function closeUpstreamProxy() {
    proxyServer?.close();
    proxyServer = null;
    proxyPort = 0;
}

/** 读取请求体，改写 tools 后转发，并把响应（含 SSE）流式回传。 */
async function forward(req: IncomingMessage, res: ServerResponse, upstream: string) {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body = Buffer.concat(chunks);

    // Codex 侧配置的是 origin，请求路径由它自己追加（/v1/responses 等），这里原样拼接
    const incoming = String(req.url || "/");
    const pathname = incoming.replace(/\?.*$/, "");
    let target = new URL(`${upstream.replace(/\/+$/, "")}${incoming.startsWith("/") ? incoming : `/${incoming}`}`);
    const isResponses = req.method === "POST" && pathname.endsWith("/responses");

    // 命中「/responses 空壳」的网关时改走 chat/completions，并把增量翻译回 Responses 事件
    let translator: ChatStreamTranslator | null = null;
    if (isResponses && body.length) {
        body = adaptResponsesBody(body).body;
        if (chatBridgeEnabled()) {
            const payload = parseJsonRecord(body);
            if (payload) {
                const { chat, images, dropped } = responsesToChatRequest(payload, String(payload.model || ""));
                const messages = Array.isArray(chat.messages) ? chat.messages : [];
                if (messages.length) {
                    const instructions = messages[0]?.role === "system" && typeof messages[0]?.content === "string" ? (messages[0].content as string) : undefined;
                    // 本轮模型可见的 canonical 工具名，供桥接层对模型发出的工具名做纠偏
                    // （免费模型常把 mcp__<server>__tool 的连字符规范成下划线，Codex 按名精确匹配会报 unsupported call）
                    const toolNames = new Set<string>();
                    if (Array.isArray(chat.tools)) {
                        for (const rawTool of chat.tools) {
                            const fn = rawTool && typeof rawTool === "object" && !Array.isArray(rawTool) ? (rawTool as ToolRecord).function : null;
                            const fnRecord = fn && typeof fn === "object" && !Array.isArray(fn) ? (fn as ToolRecord) : null;
                            if (fnRecord && typeof fnRecord.name === "string" && fnRecord.name) toolNames.add(fnRecord.name);
                        }
                    }
                    translator = createChatStreamTranslator({
                        model: String(payload.model || ""),
                        instructions,
                        parallelToolCalls: typeof payload.parallel_tool_calls === "boolean" ? payload.parallel_tool_calls : undefined,
                        toolChoice: typeof payload.tool_choice === "string" ? payload.tool_choice : undefined,
                        toolNames,
                    });
                    body = asBuffer(Buffer.from(JSON.stringify(chat), "utf8"));
                    target = new URL(`${upstream.replace(/\/+$/, "")}/chat/completions`);
                    logger.info("Bridged Responses request to Chat Completions", {
                        images,
                        droppedItems: dropped,
                        messages: messages.length,
                        tools: Array.isArray(chat.tools) ? chat.tools.length : 0,
                        payload: body.length,
                    });
                }
            }
        }
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        const name = key.toLowerCase();
        // host 必须换成上游主机；accept-encoding 交给 undici 自行协商，避免上游返回未解压内容
        if (name === "host" || name === "content-length" || name === "accept-encoding" || name === "connection") continue;
        if (typeof value === "string") headers[name] = value;
        else if (Array.isArray(value)) headers[name] = value.join(", ");
    }

    const response = await fetch(target, {
        method: req.method || "POST",
        headers,
        ...(body.length && req.method !== "GET" && req.method !== "HEAD" ? { body: new Uint8Array(body) } : {}),
    });

    if (translator) {
        await bridgeChatResponse(response, res, translator);
        return;
    }

    res.statusCode = response.status;
    for (const [key, value] of response.headers.entries()) {
        const name = key.toLowerCase();
        if (name === "content-encoding" || name === "content-length" || name === "transfer-encoding" || name === "connection") continue;
        res.setHeader(key, value);
    }

    if (!response.body) {
        res.end();
        return;
    }
    // SSE 与普通 JSON 都按字节流透传，避免缓冲破坏增量语义
    const reader = response.body.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) res.write(Buffer.from(value));
    }
    res.end();
}

/** 尽量把 Buffer 解析成对象（解析失败返回 null，不抛）。 */
function parseJsonRecord(value: Buffer): ToolRecord | null {
    try {
        const parsed: unknown = JSON.parse(value.toString("utf8"));
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
        return parsed as ToolRecord;
    } catch {
        return null;
    }
}

/** 上游没按 SSE 返回时，把一份完整的 chat.completion 拼成 chat SSE 形状再交给翻译器。 */
function chatSseFromJson(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) return "";
    const record = value as ToolRecord;
    const choices = Array.isArray(record.choices) ? record.choices : [];
    const first = choices.length && choices[0] && typeof choices[0] === "object" ? (choices[0] as ToolRecord) : null;
    const message = first?.message && typeof first.message === "object" ? (first.message as ToolRecord) : null;
    if (!message) return "";
    const base = { id: record.id, object: "chat.completion.chunk", created: record.created, model: record.model };
    const lines: string[] = [];
    const content = typeof message.content === "string" ? message.content : "";
    if (content) lines.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content } }] }));
    const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
    for (const rawCall of toolCalls) {
        if (!rawCall || typeof rawCall !== "object") continue;
        const call = rawCall as ToolRecord;
        const fn = call.function && typeof call.function === "object" ? (call.function as ToolRecord) : {};
        lines.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: typeof call.index === "number" ? call.index : 0, id: call.id, type: "function", function: { name: fn.name, arguments: fn.arguments } }] } }] }));
    }
    if (record.usage) lines.push(JSON.stringify({ ...base, choices: [{ index: 0, delta: {} }], usage: record.usage }));
    return lines.map((line) => `data: ${line}\n`).join("") + "data: [DONE]\n";
}

/** chat/completions 的流式响应 → Responses 事件流，边收边写。 */
async function bridgeChatResponse(response: Response, res: ServerResponse, translator: ChatStreamTranslator) {
    if (!response.ok) {
        // 上游明确报错时原样回传，Codex 会把它作为该轮的错误显示出来
        const text = await response.text().catch(() => "");
        res.statusCode = response.status;
        res.setHeader("content-type", response.headers.get("content-type") || "application/json; charset=utf-8");
        res.end(text || JSON.stringify({ error: { message: `上游 chat/completions 返回 ${response.status}` } }));
        return;
    }

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream; charset=utf-8");
    res.setHeader("cache-control", "no-cache");

    const contentType = (response.headers.get("content-type") || "").toLowerCase();
    const streamed = contentType.includes("text/event-stream");

    if (!response.body) {
        res.end(translator.finish());
        return;
    }

    const decoder = new TextDecoder("utf-8");
    const reader = response.body.getReader();
    let raw = "";
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!value) continue;
            const text = decoder.decode(value, { stream: true });
            if (streamed) {
                const events = translator.push(text);
                if (events) res.write(events);
            } else if (raw.length < 8 * 1024 * 1024) {
                raw += text;
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn("Chat bridge stream failed", { error: message, wroteContent: translator.hasContent() });
        res.write(translator.failed(`上游 chat/completions 流中断：${message}`));
        res.end();
        return;
    }

    if (streamed) {
        res.write(translator.finish());
    } else {
        const parsed: unknown = (() => {
            try {
                return JSON.parse(raw);
            } catch {
                return null;
            }
        })();
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (parsed as ToolRecord).error) {
            const message = String(((parsed as ToolRecord).error as ToolRecord)?.message || "上游返回错误");
            res.write(translator.failed(message));
        } else {
            res.write(translator.push(chatSseFromJson(parsed)));
            res.write(translator.finish());
        }
    }
    res.end();
}

