/**
 * GPU 实例的「可调用性」探测。
 *
 * 背景：优云智算的 GPU 实例在 8000 端口暴露一个 **OpenAI 兼容 API**
 * （`/v1/models`、`/v1/chat/completions`、`/v1/images/generations`…），
 * 画布的文本 / 图像 / 视频 / 音频请求正好都走 `buildApiUrl(baseUrl, path)`。
 * 所以「实例能不能被画布调用」= 「这个地址的 /v1/models 能不能列出模型，
 * 且这些模型分别是什么能力」。
 *
 * 为什么必须由 Agent 发这个请求（而不是前端 fetch）：
 *   · 浏览器的 CORS：实例地址是 `*.pod.compshare.cn`，页面直接 fetch 会被拦；
 *   · 画布本身已有本地转发代理（`withLocalProxy`），但**探测阶段还没配置渠道**，
 *     借不到它；让 Agent 探一次最直接，也复用了「本机出网」这条已验证通路。
 *
 * 探测结果按能力归类，供前端决定「这个实例能喂给画布哪类节点」。
 */
import http from "node:http";
import https from "node:https";

import { DEFAULT_VLLM_API_KEY, buildEndpoints } from "./compshare.js";

/** 画布的模型能力口径（与 `stores/use-config-store.ts` 的 ModelCapability 保持一致）。 */
export type InstanceCapability = "image" | "video" | "text" | "audio";

export type ProbedModel = {
    id: string;
    capability: InstanceCapability;
};

export type ProbeResult =
    | {
          ok: true;
          baseUrl: string;
          apiBase: string;
          models: ProbedModel[];
          /** 按能力归类后的模型名（前端直接填进画布渠道的 models 列表） */
          byCapability: Record<InstanceCapability, string[]>;
          /** 实例是否至少提供一类能力 */
          usable: boolean;
      }
    | {
          ok: false;
          baseUrl: string;
          apiBase: string;
          /** 可行动的原因（区分「实例没开」「地址不对」「没装服务」） */
          reason: string;
          code: "unreachable" | "http" | "not-openai" | "no-model" | "instance-not-running";
      };

/**
 * 按模型名推断能力。
 *
 * 与画布 `guessCapability` 的口径一致（vllm / sora / veo / whisper 等前缀），
 * 这里额外覆盖 GPU 实例镜像常见的自建服务名（ComfyUI 之类通常不在 /v1/models 里，
 * 但用户会自己在实例上起服务后注册进来）。
 */
export function guessCapability(name: string): InstanceCapability {
    const value = String(name || "").toLowerCase();
    if (/whisper|tts|audio|voice|speech|cosyvoice|fish-speech|edge-tts/.test(value)) return "audio";
    if (/sora|veo|video|kling|wan|hailuo|runway|vidu|seedance|可灵/.test(value)) return "video";
    if (/flux|sd3|stable-diffusion|sdxl|dall|midjourney|image|kolors|qwen-image|wanx|cogview|ernie-irag/.test(value)) return "image";
    return "text";
}

/** 单次 GET，带超时；只取状态码与响应体前若干字节。 */
function fetchText(url: string, headers: Record<string, string>, timeoutMs: number): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
        const client = url.startsWith("http://") ? http : https;
        const request = client.get(url, { headers, timeout: timeoutMs }, (response) => {
            let body = "";
            response.setEncoding("utf8");
            response.on("data", (chunk: string) => {
                // 限制读取量：实例的 models 响应可能很大，超出即够解析
                if (body.length < 512 * 1024) body += chunk;
            });
            response.on("end", () => resolve({ status: response.statusCode || 0, body }));
        });
        request.on("timeout", () => {
            request.destroy();
            reject(new Error("timeout"));
        });
        request.on("error", reject);
    });
}

/**
 * 探测一个实例能否被画布调用。
 *
 * 只读操作：不改实例任何配置，也不产生费用。
 *
 * `apiBaseOverride` 用于自定义端点（默认按实例 ID 拼 `8000-<id>.pod.compshare.cn/v1`）。
 * 保留这个口子有两个实际用途：① 平台将来换域名时不必改这里；② 端到端测试可以
 * 指向本机假服务验证探测逻辑，而不必真的申请实例。
 */
export async function probeInstance(instanceId: string, apiKey = DEFAULT_VLLM_API_KEY, apiBaseOverride?: string): Promise<ProbeResult> {
    const endpoints = buildEndpoints(instanceId, apiKey);
    const apiBase = String(apiBaseOverride || endpoints.apiBase).replace(/\/+$/, "");
    const baseUrl = apiBase.replace(/\/v1$/, "");
    // 失败分支统一从这里构造，保证 reason 与 code 成对出现（前端按 code 分支展示）
    const fail = (code: Extract<ProbeResult, { ok: false }>["code"], reason: string): ProbeResult => ({
        ok: false,
        baseUrl,
        apiBase,
        reason,
        code,
    });

    let response: { status: number; body: string };
    try {
        response = await fetchText(`${apiBase}/models`, { accept: "application/json", authorization: `Bearer ${apiKey}` }, 15_000);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // 域名解析失败/连接被拒/超时 —— 结合「实例是否在运行」给可行动提示
        if (/timeout|ETIMEDOUT|ESOCKETTIMEDOUT/.test(message)) {
            return fail("unreachable", "连接超时。实例可能仍在开机中，或 8000 端口的服务还没启动完成（开机后通常需要 1~3 分钟）。");
        }
        if (/ENOTFOUND|EAI_AGAIN/.test(message)) {
            return fail("unreachable", "域名解析失败。请确认实例 ID 正确、且该实例的 8000 端口已在平台控制台开放。");
        }
        return fail("unreachable", `连不上实例的 API 地址（${message}）。请确认实例处于「运行中」状态。`);
    }

    if (response.status === 401 || response.status === 403) {
        return fail("http", `鉴权被拒（HTTP ${response.status}）。该实例的 vLLM API Key 与镜像内预置值不一致，请在接入画布时手动填写正确的 Key。`);
    }
    if (response.status === 404) {
        return fail("not-openai", `该地址没有 /v1/models（HTTP 404）。这个镜像可能没有内置 OpenAI 兼容服务，请在实例内自行部署服务后再接入画布。`);
    }
    if (response.status < 200 || response.status >= 300) {
        return fail("http", `实例 API 返回 HTTP ${response.status}。请查看实例内的服务日志确认状态。`);
    }

    // 解析模型列表：兼容 OpenAI 标准 {data:[{id}]} 与裸数组 [{id}]
    let ids: string[] = [];
    try {
        const parsed = JSON.parse(response.body) as { data?: Array<{ id?: string; name?: string }> } | Array<{ id?: string; name?: string }>;
        const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.data) ? parsed.data : [];
        ids = list.map((item) => String(item?.id || item?.name || "").trim()).filter(Boolean);
    } catch {
        return fail("not-openai", "实例返回的不是 JSON。它可能不是 OpenAI 兼容服务（而是 ComfyUI 等图形界面服务，需要用另一种方式接入）。");
    }

    if (!ids.length) {
        return fail("no-model", "实例 API 可访问，但 /v1/models 没有列出任何模型。通常是 vLLM 还在加载权重，请稍后再试。");
    }

    // vLLM 在多卡/多 LoRA 下会在 /v1/models 里重复列出同一个模型；
    // 不去重会让画布渠道出现重复项（下拉里同一个模型选两次），所以这里先收敛。
    const uniqueIds = [...new Set(ids)];
    const models: ProbedModel[] = uniqueIds.map((id) => ({ id, capability: guessCapability(id) }));
    const byCapability: Record<InstanceCapability, string[]> = { image: [], video: [], text: [], audio: [] };
    for (const model of models) byCapability[model.capability].push(model.id);

    return {
        ok: true,
        baseUrl,
        apiBase,
        models,
        byCapability,
        usable: models.length > 0,
    };
}
