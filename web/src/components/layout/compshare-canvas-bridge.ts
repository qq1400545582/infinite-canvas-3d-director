/**
 * GPU 实例 → 画布渠道 的接入桥。
 *
 * 画布的文本 / 图像 / 视频 / 音频请求都走同一个通路（`services/api/*.ts` 里的
 * `buildApiUrl(config.baseUrl, path)`），而 GPU 实例在 8000 端口暴露的正是
 * **OpenAI 兼容 API**（`/v1/models`、`/v1/chat/completions`、`/v1/images/generations`…）。
 * 所以「部署实例 → 画布可用」不需要改任何请求代码，只要把实例写成一个
 * `ModelChannel`，画布节点里就能选到它，生成结果按既有通路回填节点。
 *
 * 这个模块只负责「生成渠道对象」与「写入 store」，**不碰任何请求通路**。
 */
import { useConfigStore, type ApiCallFormat, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

/** Agent 探测返回的模型（与 `canvas-agent/src/server/compshare-probe.ts` 对齐）。 */
export type ProbedModel = {
    id: string;
    capability: ModelCapability;
};

export type ProbeOk = {
    ok: true;
    baseUrl: string;
    apiBase: string;
    models: ProbedModel[];
    byCapability: Record<ModelCapability, string[]>;
    usable: boolean;
};

export type ProbeFailed = {
    ok: false;
    baseUrl: string;
    apiBase: string;
    reason: string;
    code: string;
};

export type ProbeOutcome = ProbeOk | ProbeFailed;

/** 渠道 id 前缀：便于日后识别/清理「由 GPU 实例生成的渠道」，不会与用户手建渠道混淆。 */
export const INSTANCE_CHANNEL_PREFIX = "compshare-instance:";

export function instanceChannelId(instanceId: string) {
    return `${INSTANCE_CHANNEL_PREFIX}${String(instanceId || "").trim()}`;
}

/**
 * 画布的 `buildApiUrl` 会在 baseUrl 后补 `/v1`（除非已以 /v1 结尾），
 * 所以这里传**不带 /v1 的根地址**，避免出现 `/v1/v1/…`。
 */
export function normalizeInstanceBaseUrl(apiBase: string) {
    return String(apiBase || "").trim().replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** 探测到的模型 → 画布渠道的 models 列表（同名模型只保留一条）。 */
export function toChannelModels(models: ProbedModel[]) {
    const seen = new Set<string>();
    const list: { name: string; capability: ModelCapability }[] = [];
    for (const model of models) {
        const name = String(model?.id || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        list.push({ name, capability: model.capability || "text" });
    }
    return list;
}

/**
 * 构造一个 GPU 实例渠道。
 *
 * `apiFormat` 固定 `openai` —— 实例提供的是 OpenAI 兼容接口，
 * 画布对 `openai` 格式会走 `/v1/responses`（并在被上游拒绝时自动回退
 * `/v1/chat/completions`），这两条 vLLM 都支持。
 */
export function buildInstanceChannel(input: {
    instanceId: string;
    instanceName?: string;
    apiBase: string;
    apiKey: string;
    models: ProbedModel[];
}): ModelChannel {
    return {
        id: instanceChannelId(input.instanceId),
        name: `GPU 实例 · ${input.instanceName || input.instanceId}`.trim(),
        baseUrl: normalizeInstanceBaseUrl(input.apiBase),
        apiKey: input.apiKey.trim(),
        apiFormat: "openai" as ApiCallFormat,
        models: toChannelModels(input.models),
    };
}

/**
 * 把实例渠道写入画布配置。
 *
 * 行为约定（避免引出用户没预期的问题）：
 *   · 同实例重复接入 ⇒ **更新**同一渠道（按 id 覆盖），不产生重复项；
 *   · 不动用户已有的其它渠道，也不改当前选中的模型 —— 只在本次新增/更新时
 *     把该渠道的**第一个文本模型**设为当前模型（用户马上就能在节点里用），
 *     其余能力的模型需要用户在模型下拉里自己选（因为不同节点用不同能力）。
 */
export function connectInstanceToCanvas(channel: ModelChannel) {
    const { config, updateConfig } = useConfigStore.getState();
    if (!channel.models.length) {
        return { ok: false as const, reason: "该实例没有可用模型，无法接入画布" };
    }
    const existed = config.channels.some((item) => item.id === channel.id);
    // 同 id 覆盖：放在原位，保持用户的渠道顺序稳定
    const channels = existed ? config.channels.map((item) => (item.id === channel.id ? channel : item)) : [...config.channels, channel];

    updateConfig("channels", channels);
    // 当前模型指向该渠道的首个文本模型；没有文本模型就不动（避免把生图节点模型改成文本模型）
    const firstText = channel.models.find((model) => model.capability === "text");
    if (firstText && !channels.some((item) => item.id !== channel.id && item.models.some((m) => m.name === config.model))) {
        updateConfig("model", firstText.name);
    }
    return { ok: true as const, channelId: channel.id, replaced: existed, firstTextModel: firstText?.name };
}

/** 该实例是否已经接入过画布（用于按钮态：已接入时显示「已接入」）。 */
export function isInstanceConnected(instanceId: string) {
    return useConfigStore.getState().config.channels.some((item) => item.id === instanceChannelId(instanceId));
}

/** 探测结果的文字摘要（配置面板上直接展示，避免用户看 JSON）。 */
export function describeProbe(outcome: ProbeOutcome) {
    if (!outcome.ok) return outcome.reason;
    const { byCapability } = outcome;
    const parts: string[] = [];
    if (byCapability.text.length) parts.push(`文本 ${byCapability.text.length}`);
    if (byCapability.image.length) parts.push(`图像 ${byCapability.image.length}`);
    if (byCapability.video.length) parts.push(`视频 ${byCapability.video.length}`);
    if (byCapability.audio.length) parts.push(`语音 ${byCapability.audio.length}`);
    return parts.length ? `可调用：${parts.join(" · ")}` : "实例 API 可访问，但没有模型";
}
