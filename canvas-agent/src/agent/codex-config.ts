import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import type { CodexReasoningEffort } from "./codex-protocol.js";
import type { JsonRecord } from "../utils/value.js";

/**
 * 画布「模型：自动」的语义解析。
 *
 * Codex app-server 会把线程创建时的模型**持久化在线程里**（`thread/resume` 不携带 model，
 * 因此沿用线程内的旧值）。一旦用户在 `~/.codex/config.toml` 里换了供应商/模型，
 * 已存在的线程仍会继续用旧模型 —— 表现为「配置成免费模型，调用技能却仍然扣费」。
 *
 * 这里在每一轮 turn 之前读取 config.toml 的当前值并显式下传，使「自动」真正等同于
 * 「跟随当前 Codex 配置」。用户在前端显式选定的模型/档位优先级更高，不受影响。
 */

/** 上游 OpenAI 兼容端点只接受这四档；Codex 的 xhigh/max/ultra 会被上游以 unknown variant 400 拒绝。 */
const UPSTREAM_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "low", "medium", "high"]);
const KNOWN_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

/**
 * agnes-ai 中国站的**免费**模型白名单（来源：官方文档「模型定价」页）。
 *
 * 文本：agnes-2.5-flash、agnes-3.0-flash —— 输入/输出 Token 现价均为 ¥0。
 *       （agnes-2.5-pro / pro-alpha / pro-beta 按刊例价计费，属付费模型。）
 * 图像：agnes-image-2.0-flash / 2.1-flash / 2.5-flash —— 各分辨率输出与输入参考图均 ¥0。
 * 视频：agnes-video-v2.0（¥0/秒）、agnes-video-2.5-flash（限时免费）。
 *       （agnes-video-2.5 按分辨率与时长计费，属付费模型。）
 *
 * 画布侧只接免费模型时，凡是命中付费模型的请求都在进入上游前拦下，
 * 避免出现「配了免费模型却仍按付费模型扣费」。
 */
const FREE_TEXT_MODELS = new Set(["agnes-2.5-flash", "agnes-3.0-flash"]);
const FREE_IMAGE_MODELS = new Set(["agnes-image-2.0-flash", "agnes-image-2.1-flash", "agnes-image-2.5-flash"]);
const FREE_VIDEO_MODELS = new Set(["agnes-video-v2.0", "agnes-video-2.5-flash"]);
const FREE_MODELS = new Set([...FREE_TEXT_MODELS, ...FREE_IMAGE_MODELS, ...FREE_VIDEO_MODELS]);

/** 上游付费模型与其免费替代，用于给出可操作的报错文案。 */
const PAID_MODEL_FALLBACK: Record<string, string> = {
    "agnes-2.0-flash": "agnes-2.5-flash",
    "agnes-2.5-pro": "agnes-2.5-flash",
    "agnes-2.5-pro-alpha": "agnes-2.5-flash",
    "agnes-2.5-pro-beta": "agnes-2.5-flash",
    "agnes-image-2.0": "agnes-image-2.5-flash",
    "agnes-video-2.5": "agnes-video-v2.0",
};

/** 判断某个模型是否在免费白名单内；非 agnes 模型一律视为「不受本白名单约束」。 */
export function isFreeModel(model: string): boolean {
    return FREE_MODELS.has(model.trim().toLowerCase());
}

/**
 * 是否只允许免费模型。
 *
 * 默认关闭，避免悄悄改变既有行为；用户显式开启后（`config.toml` 顶层
 * `canvas_free_models_only = true`），付费模型会被拦下并给出免费替代建议。
 */
export function freeModelsOnly(): boolean {
    return /^(true|1|yes)$/i.test(readCodexDefaults().freeModelsOnly || "");
}

/**
 * 校验模型是否可放行。
 *
 * 返回 `null` 表示放行；返回字符串表示拒绝原因。
 * 仅在「只允许免费模型」开启、且模型确实属于 agnes 系列时才拦截 ——
 * 用户切换到别的供应商（模型名不含 agnes 前缀）时不做限制。
 */
export function rejectNonFreeModel(model: string | undefined): string | null {
    const name = (model || "").trim().toLowerCase();
    if (!name || !name.startsWith("agnes-")) return null;
    if (!freeModelsOnly()) return null;
    if (isFreeModel(name)) return null;
    const fallback = PAID_MODEL_FALLBACK[name] || "agnes-2.5-flash";
    return `当前设置为「仅使用免费模型」，而 "${name}" 属于付费模型（会按刊例价计费）。请改用免费模型 "${fallback}"，或关闭仅免费模型限制。`;
}

/** 当前配置里的可用免费文本模型，供前端在「仅免费」模式下收敛候选列表。 */
export function freeModelCatalogue() {
    return {
        text: [...FREE_TEXT_MODELS],
        image: [...FREE_IMAGE_MODELS],
        video: [...FREE_VIDEO_MODELS],
    };
}

type CodexDefaults = { model?: string; effort?: CodexReasoningEffort; provider?: string; baseUrl?: string; freeModelsOnly?: string; chatBridge?: string };

let cached: { file: string; mtimeMs: number; size: number; value: CodexDefaults } | null = null;

/** Codex 配置目录：`CODEX_HOME` 优先，否则 `~/.codex`。 */
export function codexHomeDir(): string {
    const override = process.env.CODEX_HOME?.trim();
    return override ? path.resolve(override) : path.join(homedir(), ".codex");
}

export function codexConfigPath(): string {
    return path.join(codexHomeDir(), "config.toml");
}

/** 去掉行尾注释；带引号的值取引号内内容。 */
function stripComment(value: string): string {
    const quote = value[0];
    if (quote === '"' || quote === "'") {
        const end = value.indexOf(quote, 1);
        return (end > 0 ? value.slice(1, end) : value.slice(1)).trim();
    }
    const hash = value.indexOf("#");
    return (hash >= 0 ? value.slice(0, hash) : value).trim();
}

/** 只解析顶层标量，以及 `[model_providers.<id>]` 段内需要的键。 */
function parseConfig(text: string): { scalars: Record<string, string>; providers: Map<string, Record<string, string>> } {
    const scalars: Record<string, string> = {};
    const providers = new Map<string, Record<string, string>>();
    let section: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        if (line.startsWith("[")) {
            section = line.replace(/^\[+|\]+$/g, "").split(".").map((part) => stripComment(part.trim()));
            continue;
        }
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        const key = line.slice(0, eq).trim();
        if (!key) continue;
        const value = stripComment(line.slice(eq + 1).trim());
        if (!section.length) {
            scalars[key] = value;
            continue;
        }
        if (section[0] === "model_providers" && section[1]) {
            const entry = providers.get(section[1]) || {};
            entry[key] = value;
            providers.set(section[1], entry);
        }
    }
    return { scalars, providers };
}

/** 读取 config.toml 的 model / model_reasoning_effort；读不到时静默回退（保持既有行为）。 */
export function readCodexDefaults(): CodexDefaults {
    const file = codexConfigPath();
    try {
        const info = statSync(file);
        if (cached && cached.file === file && cached.mtimeMs === info.mtimeMs && cached.size === info.size) return cached.value;
        const { scalars, providers } = parseConfig(readFileSync(file, "utf8"));
        const model = scalars.model?.trim() || undefined;
        const rawEffort = scalars.model_reasoning_effort?.trim().toLowerCase();
        const effort = rawEffort && KNOWN_EFFORTS.has(rawEffort as CodexReasoningEffort) ? (rawEffort as CodexReasoningEffort) : undefined;
        const provider = scalars.model_provider?.trim() || undefined;
        // base_url 只从当前 provider 段取，避免读到其它供应商的地址
        const baseUrl = provider ? providers.get(provider)?.base_url?.trim() || undefined : undefined;
        const freeModelsOnly = scalars.canvas_free_models_only?.trim() || undefined;
        // 部分第三方网关把 /responses 做成了空壳（只回显、无输出），需要改走 chat/completions；
        // 这个开关用于覆盖默认的「按上游域名判断」行为。
        const chatBridge = scalars.canvas_responses_via_chat?.trim() || undefined;
        const value: CodexDefaults = { model, effort, provider, baseUrl, freeModelsOnly, chatBridge };
        cached = { file, mtimeMs: info.mtimeMs, size: info.size, value };
        return value;
    } catch {
        return {};
    }
}

/** 「自动」模型 = config.toml 当前的 model。 */
export function resolveCodexDefaultModel(): string | undefined {
    return readCodexDefaults().model;
}

/** 「自动」档位 = config.toml 当前的 effort，并把上游不认的高档位收敛为 high。 */
export function resolveCodexDefaultEffort(): CodexReasoningEffort | undefined {
    const effort = readCodexDefaults().effort;
    if (!effort) return undefined;
    return UPSTREAM_EFFORTS.has(effort) ? effort : "high";
}

/** 当前 provider id（config.toml 未声明时等同于官方 openai）。 */
export function resolveCodexProviderId(): string {
    return readCodexDefaults().provider || "openai";
}

/** 当前 provider 声明的上游 Base URL；官方 provider 或未声明时返回 undefined。 */
export function codexUpstreamBaseUrl(): string | undefined {
    const { provider, baseUrl } = readCodexDefaults();
    if (!provider || provider === "openai") return undefined;
    if (!baseUrl || !/^https?:\/\//i.test(baseUrl)) return undefined;
    // 已经指向本机转发层时不再二次包装，避免自环
    if (/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(baseUrl)) return undefined;
    return baseUrl.replace(/\/+$/, "");
}

/**
 * 需要把请求导向本机转发层时使用回环地址替换 provider 的 base_url。
 *
 * Codex 0.146 会下发 `type: "namespace"` 与 `type: "web_search"` 两类官方专有工具，
 * 第三方 OpenAI 兼容网关的反序列化器不认（400 `unknown variant`），且 **app-server 模式下
 * 没有任何配置项能移除它们**（`-c` 被线程级 config 覆盖，`features.multi_agent=false`
 * 仅在 `codex exec` 生效）。因此改由本机转发层在转发前改写 tools 形态。
 */
export function codexProviderConfigOverrides(proxyBaseUrl?: string): JsonRecord {
    if (!proxyBaseUrl) return {};
    const provider = resolveCodexProviderId();
    if (provider === "openai") return {};
    return { model_providers: { [provider]: { base_url: proxyBaseUrl } } };
}

/** 同一组兼容项的启动参数形式（web_search 是顶层键，`-c` 对该键无效，改由转发层处理）。 */
export function codexToolCompatArgs(): string[] {
    return [];
}
