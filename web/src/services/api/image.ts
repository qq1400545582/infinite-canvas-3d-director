import axios from "axios";

import i18n from "@/i18n";
import { buildApiUrl, resolveModelRequestConfig, resolveModelScript, withLocalProxy, type AiConfig, type ModelChannel } from "@/stores/use-config-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { nanoid } from "nanoid";
import { dataUrlToFile } from "@/lib/image-utils";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import { imageSizePresets, inferMediaScale } from "@/lib/media-size";
import type { ReferenceImage } from "@/types/image";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
type RequestOptions = { signal?: AbortSignal };

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";
// 与 image-storage 的下载超时保持一致，避免接口挂起时节点一直停在生成中。
const IMAGE_REQUEST_TIMEOUT_MS = 10 * 60_000;

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const scale = quality === "high" ? "4k" : quality === "medium" || quality === "hd" ? "2k" : "1k";
    const preset = imageSizePresets[scale][ratio];
    if (preset) return preset;
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { imageConfig: image } : {};
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality);
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const size = `${dimensions.width}x${dimensions.height}`;
    const scale = inferMediaScale(size);
    if (Object.values(imageSizePresets[scale]).includes(size)) return scale.toUpperCase();
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageSource(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0) {
        throw new Error(payload.msg || apiText("requestFailed"));
    }
    // Support data, images, and results response fields used by different APIs.
    const imageList = payload.data
        || (payload as Record<string, unknown>).images as Array<Record<string, unknown>> | undefined
        || (payload as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined
        || [];
    const images = imageList
        .map(resolveImageSource)
        .filter((value): value is string => Boolean(value))
        .map((dataUrl) => ({ id: nanoid(), dataUrl }));

    if (images.length === 0) {
        // Check whether the response contains data in an unrecognized format.
        const rawKeys = Object.keys(payload).filter((k) => k !== "code" && k !== "msg" && k !== "error");
        throw new Error(rawKeys.length > 0
            ? apiText("unknownImageResponse", { fields: rawKeys.join(", ") })
            : apiText("noImageReturned"));
    }

    return images;
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        // The value may be serialized JSON, such as error.message, or a plain-text error.
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            // Treat an empty parsed object such as "{}" as having no useful message.
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            // Detect HTML error pages.
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") return apiText("imageTimeout");
        if (!error.response && error.code === "ERR_NETWORK") return apiText("requestFailed");
        const responseData = error.response?.data;
        // Prefer the API error from the response body.
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        // Infer the error from the HTTP status when the response body has no usable message.
        const statusMsg = readStatusError(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        // Fall back to Axios's own error message.
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

/** 带上 HTTP 状态的上游错误：判断「是否该换请求形状重试」需要状态码，光有 message 不够。 */
export class UpstreamRequestError extends Error {
    constructor(
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = "UpstreamRequestError";
    }
}

/** 上游把整份 pydantic 校验转储塞进 error.message（可达数千字符），这里压成「首条原因 + 提示」。 */
const VALIDATION_DUMP = /validation errors? for|field required|input_value=|value_error|invalid_request_error/i;

/**
 * 压缩上游校验转储：只留第一条真正的原因（去掉 loc/type/input_value 这类噪声尾巴），
 * 再补一句可操作提示。特征不明显就原样返回，**不做任何猜测性改写**。
 */
export function condenseUpstreamError(message: string): string {
    const text = String(message || "");
    if (text.length <= 240 || !VALIDATION_DUMP.test(text)) return text;
    // 取第一段错误：形如 "1 validation error for ChatCompletionRequest:\nbody.messages.0.role\n  Field required ..."
    const lines = text.split(/\r?\n/);
    const firstIndex = lines.findIndex((line) => /^\s*\d+\s+validation error/.test(line) || VALIDATION_DUMP.test(line));
    const head = (firstIndex >= 0 ? lines.slice(firstIndex) : lines).map((line) => line.trim()).filter(Boolean);
    const reason = head.slice(0, 3).join(" ").replace(/\s{2,}/g, " ").trim();
    const keep = reason.slice(0, 180);
    return `${apiText("upstreamValidation", { reason: keep })}`;
}

/**
 * 判断这次失败是否值得换一种请求形状（chat/completions）重试。
 *
 * 背景：画布文本（含带图反推）默认发 `/v1/responses`。不少第三方网关只认 chat/completions，
 * 收到 Responses 形状的 `input` / `input_image` 会回 400 + 一大段校验错误。
 * 这类失败换形状就能成；而鉴权 / 额度 / 限流 / 服务端错误换形状没有意义，重试只是浪费配额。
 */
export function isUpstreamShapeMismatch(error: unknown): boolean {
    if (!(error instanceof UpstreamRequestError)) return false;
    const status = error.status ?? 0;
    if (![400, 404, 405, 415, 422].includes(status)) return false;
    if (status === 404) return true; // 网关根本没有 /v1/responses
    return VALIDATION_DUMP.test(String(error.message || "")) || /unknown|unsupported|not support|unrecognized|role must be|参数|校验/i.test(String(error.message || ""));
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return withLocalProxy(`${baseUrl}/models`);
    return withLocalProxy(`${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`);
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(apiText("geminiRejected", { reason: payload.promptFeedback.blockReason }));
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return new UpstreamRequestError(readStatusError(response.status, fallback), response.status);
    try {
        return new UpstreamRequestError(condenseUpstreamError(responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback)), response.status);
    } catch {
        return new UpstreamRequestError(condenseUpstreamError(text.slice(0, 300) || readStatusError(response.status, fallback)), response.status);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

/**
 * 内部消息 → chat/completions 的 `messages`。
 * 内部形状本来就是 chat 规范（`content: [{type:'text'|'image_url', …}]`），这里只需
 * 剔除 Responses 专属项（function_call / role:'tool' / thoughtSignature），保持内容原样。
 */
function toChatMessages(messages: ResponseInputMessage[]): Array<Record<string, unknown>> {
    return messages.flatMap((message) => {
        if ("type" in message) return message.type === "function_call" ? [] : [];
        if (message.role === "tool") return [];
        return [{ role: message.role, content: message.content }];
    });
}

/** 解析 chat/completions 的流式分片：choices[0].delta.content 累积。 */
function consumeChatStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    let event: Record<string, unknown>;
    try {
        event = JSON.parse(data) as Record<string, unknown>;
    } catch {
        return; // 网关偶发非 JSON 心跳行，忽略即可
    }
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    const choices = Array.isArray(event.choices) ? event.choices : [];
    for (const choice of choices) {
        const payload = (choice as { delta?: { content?: unknown }; message?: { content?: unknown } }) || {};
        const piece = typeof payload.delta?.content === "string" ? payload.delta.content : typeof payload.message?.content === "string" ? payload.message.content : "";
        if (!piece) continue;
        state.text += piece;
        onDelta?.(state.text);
    }
}

/** 往 chat 流式缓冲里追加文本，按空行切块交给 consumeChatStreamBlock。 */
function feedChatStream(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeChatStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeChatStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

/**
 * chat/completions 流式请求（Responses 形状不被网关接受时的回退通路）。
 * 与 requestStreamingResponse 同构：优先读 SSE，部分网关忽略 stream 参数时回落非流式 JSON。
 */
async function requestChatCompletionStreaming(config: AiConfig, messages: ResponseInputMessage[], onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/chat/completions"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ model: config.model, messages: toChatMessages(messages), stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw await readFetchError(response, apiText("requestFailed"));
    if (!response.body) {
        const payload = (await response.json()) as { choices?: Array<{ message?: { content?: unknown } }>; error?: { message?: string } };
        if (payload.error?.message) throw new UpstreamRequestError(condenseUpstreamError(payload.error.message), response.status);
        const content = typeof payload.choices?.[0]?.message?.content === "string" ? payload.choices[0]!.message!.content! : "";
        if (content) onDelta?.(content);
        return { content, toolCalls: [] };
    }
    const state: ResponseStreamState = { text: "", buffer: "" };
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        feedChatStream(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new UpstreamRequestError(condenseUpstreamError(state.error), response.status);
    }
    feedChatStream(state, decoder.decode(), onDelta, true);
    if (state.error) throw new UpstreamRequestError(condenseUpstreamError(state.error), response.status);
    return { content: state.text, toolCalls: [] };
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw await readFetchError(response, apiText("requestFailed"));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(`${geminiApiUrl(config, "streamGenerateContent")}?alt=sse`, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw await readFetchError(response, apiText("requestFailed"));
    if (!response.body) {
        const payload = (await response.json()) as GeminiPayload;
        return parseGeminiToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal, timeout: IMAGE_REQUEST_TIMEOUT_MS },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error(apiText("geminiNoImage"));
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const promptText = withSystemPrompt(requestConfig, prompt);
    try {
        const images = await withImageFieldFallback(async (skip) => {
            const response = await axios.post<ImageApiResponse>(
                aiApiUrl(requestConfig, "/images/generations"),
                {
                    model: requestConfig.model,
                    prompt: promptText,
                    n: skip.has("n") ? undefined : n,
                    ...(quality && !skip.has("quality") ? { quality } : {}),
                    ...(requestSize && !skip.has("size") ? { size: requestSize } : {}),
                    ...(background && !skip.has("background") ? { background } : {}),
                    // gpt-image models reject response_format; they always return b64.
                    ...(/gpt-image/.test(requestConfig.model) || skip.has("response_format") ? {} : { response_format: "b64_json" }),
                    // 严格校验的网关会拒收不认识的字段，遇到时由 withImageFieldFallback 剔除后重试
                    ...(skip.has("output_format") ? {} : { output_format: IMAGE_OUTPUT_FORMAT }),
                },
                {
                    headers: aiHeaders(requestConfig, "application/json"),
                    signal: options?.signal,
                    timeout: IMAGE_REQUEST_TIMEOUT_MS,
                },
            );
            return parseImagePayload(response.data);
        });
        return images;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script) {
        const quality = normalizeQuality(config.quality);
        const requestSize = resolveRequestSize(quality, config.size);
        const background = normalizeBackground(config.background);
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: requestSize, quality, count: n, ...(background ? { background } : {}) },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }

    const quality = normalizeQuality(config.quality);
    const requestSize = resolveRequestSize(quality, config.size);
    const background = normalizeBackground(config.background);
    const promptText = withSystemPrompt(requestConfig, requestPrompt);
    // File 按次构造并缓存：FormData 一旦发送就不可复用，重试必须重新组装（但不必重新解码图片）。
    const fileCache = new Map<string, File>();
    const fileOf = async (image: ReferenceImage) => {
        const key = `${image.id}:${image.dataUrl.length}`;
        const cached = fileCache.get(key);
        if (cached) return cached;
        const file = dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) });
        fileCache.set(key, file);
        return file;
    };
    const files = await Promise.all(references.map((image) => fileOf(image)));
    const imageField = files.length > 1 ? "image[]" : "image";

    try {
        const images = await withImageFieldFallback(async (skip) => {
            const formData = new FormData();
            formData.set("model", requestConfig.model);
            formData.set("prompt", promptText);
            if (!skip.has("n")) formData.set("n", String(n));
            // gpt-image models reject response_format; they always return b64.
            if (!/gpt-image/.test(requestConfig.model) && !skip.has("response_format")) {
                formData.set("response_format", "b64_json");
            }
            // 严格校验的网关会拒收不认识的字段，遇到时由 withImageFieldFallback 剔除后重试
            if (!skip.has("output_format")) formData.set("output_format", IMAGE_OUTPUT_FORMAT);
            if (quality && !skip.has("quality")) {
                formData.set("quality", quality);
            }
            if (requestSize && !skip.has("size")) {
                formData.set("size", requestSize);
            }
            if (background && !skip.has("background")) {
                formData.set("background", background);
            }
            files.forEach((file) => formData.append(imageField, file));
            const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/edits"), formData, { headers: aiHeaders(requestConfig), signal: options?.signal, timeout: IMAGE_REQUEST_TIMEOUT_MS });
            return parseImagePayload(response.data);
        });
        return images;
    } catch (error) {
        if (isGenerationCanceled(error)) throw error;
        // 该渠道没有 /images/edits（图生图端点）：改走 generations 端点把参考图带过去，
        // 否则用户只会看到一句无解的 404「接口地址不存在」。
        if (isMissingEndpointError(error) && references.length) {
            return requestEditViaGenerations(requestConfig, { promptText, references, n, quality, requestSize, background, options });
        }
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

/** 取消（用户中止）不该被当成「端点缺失」而触发重试。 */
function isGenerationCanceled(error: unknown) {
    if (axios.isCancel(error)) return true;
    const message = error instanceof Error ? error.message : String(error ?? "");
    return /canceled|cancelled|已取消|请求取消|aborted/i.test(message);
}

/**
 * 没有 /images/edits 时的图生图回退：同一个 `/images/generations` 端点，参考图按两种形状带上。
 * 顺序有意为之：顶层 `image` 是更常见的约定（多数网关与官方 SDK 的做法），
 * `extra_body.image` 是 Agnes 这类「参数需包一层」的渠道写法，放最后作为兜底。
 */
async function requestEditViaGenerations(
    requestConfig: AiConfig,
    params: {
        promptText: string;
        references: ReferenceImage[];
        n: number;
        quality: string | undefined;
        requestSize: string | undefined;
        background: string | undefined;
        options?: RequestOptions;
    },
) {
    const { promptText, references, n, quality, requestSize, background, options } = params;
    const dataUrls = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const shapes: Array<(body: Record<string, unknown>) => void> = [
        (body) => {
            body.image = dataUrls;
        },
        (body) => {
            body.extra_body = { image: dataUrls };
        },
    ];
    let lastError: unknown = null;
    for (const applyShape of shapes) {
        try {
            return await withImageFieldFallback(async (skip) => {
                const body: Record<string, unknown> = { model: requestConfig.model, prompt: promptText };
                if (!skip.has("n")) body.n = n;
                if (quality && !skip.has("quality")) body.quality = quality;
                if (requestSize && !skip.has("size")) body.size = requestSize;
                if (background && !skip.has("background")) body.background = background;
                if (!/gpt-image/.test(requestConfig.model) && !skip.has("response_format")) body.response_format = "b64_json";
                if (!skip.has("output_format")) body.output_format = IMAGE_OUTPUT_FORMAT;
                applyShape(body);
                const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/generations"), body, {
                    headers: aiHeaders(requestConfig, "application/json"),
                    signal: options?.signal,
                    timeout: IMAGE_REQUEST_TIMEOUT_MS,
                });
                return parseImagePayload(response.data);
            });
        } catch (error) {
            if (isGenerationCanceled(error)) throw error;
            // 鉴权 / 额度 / 限流这类错误换形状也没意义，直接抛。
            const status = readErrorStatus(error);
            if (status === 401 || status === 403 || status === 429) throw error;
            lastError = error;
        }
    }
    throw new Error(`${apiText("imageEditUnsupported")}（${condenseUpstreamError(readAxiosError(lastError, apiText("requestFailed")))}）`);
}

/**
 * 画布会附带一些「OpenAI 之外并非人人都认」的可选字段（output_format / response_format /
 * quality / background）。不少第三方网关做**严格校验**，遇到不认识的字段直接 400，例如
 * 「output_format 不是文本图片队列支持的字段」。这类渠道往往只是不接受这个字段，并不缺功能。
 *
 * 这里在失败时读出**被点名的那一个字段**并剔除后重试：只动报错里明确指出的字段，
 * 且只在我们自己确实发过的白名单内，绝不瞎猜、绝不删模型/提示词等必需参数。
 */
const OPTIONAL_IMAGE_FIELDS = ["output_format", "response_format", "quality", "background", "size", "n"];

/** 从错误文案里识别「被拒的字段名」；只认白名单内的字段，其余一律返回 null。 */
export function readRejectedImageField(message: string): string | null {
    const text = String(message || "");
    const patterns = [
        /["'`]?([a-z_]{1,20})["'`]?\s*(?:不是|不属于|未被)\s*[^\n]{0,24}(?:支持|允许|接受)/i,
        /(?:unknown|unsupported|unrecognized|unexpected|invalid|not\s+supported)\s*(?:field|parameter|argument|key|property)?\s*[:\s]+["'`]?([a-z_]{1,20})/i,
        /field\s+["'`]?([a-z_]{1,20})["'`]?\s+(?:is\s+)?(?:not\s+supported|unsupported|not\s+allowed|invalid|unknown)/i,
        // 字段名在前、判定在后的句式，例如「response_format is not supported」
        /["'`]?([a-z_]{1,20})["'`]?\s+(?:is\s+)?(?:not\s+supported|unsupported|not\s+allowed|not\s+recognized|invalid)\b/i,
    ];
    for (const pattern of patterns) {
        const hit = pattern.exec(text)?.[1]?.toLowerCase();
        if (hit && OPTIONAL_IMAGE_FIELDS.includes(hit)) return hit;
    }
    return null;
}

/**
 * 端点缺失判定：不少渠道**只实现 `/images/generations`，不提供 `/images/edits`**
 * （Agnes 就是这样，图生图要在 generations 里用 extra_body.image 传图）。
 * 这类渠道做图生图时会直接 404，报错文案形如 `{"detail":"Not Found"}`。
 *
 * 命中后我们改走 generations 端点重试，而不是让用户看到一句无解的 404。
 */
const MISSING_ENDPOINT = /\b404\b|\b405\b|not\s*found|no\s*such\s*endpoint|unknown\s*(?:endpoint|path|route)|接口(?:地址)?不存在|未找到接口|页面不存在|无此接口/i;

/** 从错误里读出 HTTP 状态码（axios 与我们自己抛的 UpstreamRequestError 都覆盖）。 */
function readErrorStatus(error: unknown): number | undefined {
    if (axios.isAxiosError(error)) return error.response?.status;
    if (error instanceof UpstreamRequestError) return error.status;
    return undefined;
}

/** 该错误是否意味着「这个端点不存在」——只有 404/405 与明确的 not found 文案才算。 */
export function isMissingEndpointError(error: unknown): boolean {
    if (axios.isCancel(error)) return false;
    const status = readErrorStatus(error);
    if (status === 404 || status === 405) return true;
    if (status !== undefined) return false;
    return MISSING_ENDPOINT.test(error instanceof Error ? error.message : String(error ?? ""));
}

/** 最多重试 3 次：每次按报错剔除一个字段；仍失败则把原始错误抛出去。 */
async function withImageFieldFallback<T>(send: (skip: ReadonlySet<string>) => Promise<T>): Promise<T> {
    const skip = new Set<string>();
    for (let attempt = 0; attempt <= OPTIONAL_IMAGE_FIELDS.length; attempt += 1) {
        try {
            return await send(skip);
        } catch (error) {
            const field = readRejectedImageField(error instanceof Error ? error.message : String(error));
            if (!field || skip.has(field)) throw error;
            skip.add(field);
        }
    }
    throw new Error(apiText("requestFailed"));
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || apiText("noContent");
            if (text === apiText("noContent")) onDelta(text);
            return text;
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    try {
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || apiText("noContent");
            if (answer === apiText("noContent")) onDelta(answer);
            return answer;
        }
        const input = toResponseInput(withSystemMessage(requestConfig, messages));
        // 记录是否已经吐出过内容：已经吐字再换通路重试会让流式文本重复错乱，此时宁可报错。
        let emitted = "";
        const trackDelta = (text: string) => {
            if (text) emitted = text;
            onDelta(text);
        };
        let answer = "";
        try {
            answer = (
                await requestStreamingResponse(
                    requestConfig,
                    {
                        model: requestConfig.model,
                        input,
                        ...(requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } }),
                    },
                    trackDelta,
                    options,
                )
            ).content;
        } catch (error) {
            // 回退：网关不认 Responses 形状（带图反推最容易踩）时换 chat/completions 再试一次。
            // 只在「形状/校验类失败」时换，鉴权、额度、限流、服务端错误换形状没有意义。
            if (emitted || !isUpstreamShapeMismatch(error)) throw error;
            answer = (await requestChatCompletionStreaming(requestConfig, withSystemMessage(requestConfig, messages), trackDelta, options)).content;
        }
        const text = answer || apiText("noContent");
        if (text === apiText("noContent")) onDelta(text);
        return text;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const response = await axios.get<{ data?: Array<{ id?: string }>; error?: { message?: string } }>(buildApiUrl(config.baseUrl, "/models"), {
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
            },
        });
        return (response.data.data || [])
            .map((model) => model.id)
            .filter((id): id is string => Boolean(id))
            .sort((a, b) => a.localeCompare(b));
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

export async function fetchChannelModels(channel: ModelChannel): Promise<string[]> {
    const baseUrl = channel.baseUrl.trim().replace(/\/+$/, "");
    const modelsUrl = `${baseUrl.endsWith("/v1") ? baseUrl : `${baseUrl}/v1`}/models`;
    // 先直接打上游。多数合规的 OpenAI 兼容上游会返回 ACAO=*，浏览器能读到 body。
    try {
        return await fetchImageModels({ baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat });
    } catch (primary) {
        // 常见原因：上游没把 CORS 头补全（常见于 CF Worker、自建网关等），浏览器拿不到 body，
        // Axios 报 ERR_NETWORK。此时改走本机 Agent 做服务端代理转发，Agent 侧统一加合规的 CORS 头。
        const msg = primary instanceof Error ? primary.message : "";
        if (!/ERR_NETWORK|Failed to fetch|network/i.test(msg)) throw primary;
        const token = useAgentStore.getState().token || "";
        if (!token) throw primary;
        const relayUrl = `${window.location.protocol}//${window.location.host}/proxy/models?upstream=${encodeURIComponent(modelsUrl)}`;
        const resp = await fetch(relayUrl, {
            headers: { "x-canvas-agent-token": token, "x-proxy-authorization": `Bearer ${channel.apiKey}`, accept: "application/json" },
            signal: AbortSignal.timeout(15_000),
        });
        if (!resp.ok) throw new Error(`${msg}（本机代理返回 ${resp.status}）`);
        const body = await resp.json().catch(() => null);
        const items = (body?.data || []) as Array<{ id?: string }>;
        if (!items.length) throw primary; // 没有 body 内容，把原始错抛出去让前端展示
        return items.map((item) => item.id).filter((id): id is string => Boolean(id)).sort((a, b) => a.localeCompare(b));
    }
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};
