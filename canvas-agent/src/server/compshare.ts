import crypto from "node:crypto";

/**
 * 优云智算（CompShare）GPU 实例平台的 API 客户端。
 *
 * ## 为什么在 Agent 侧而不是前端
 *
 * 该平台用 **UCloud 公私钥签名** 认证（`public_key` + `private_key`），不是 Bearer Token。
 * 私钥放前端等于公开泄露，且浏览器直连 `api.compshare.cn` 还有 CORS 硬约束。
 * 因此密钥只落本机（Agent 侧配置文件），前端只连自己的 Agent。
 *
 * ## 签名算法（**以 UCloud 官方 SDK 源码为准**）
 *
 * 依据 `@ucloud-sdks/ucloud-sdk-js` 的 `lib/core/credential`（`verifyAc`），
 * 而不是文档的文字描述 —— **两者不一致，照文档写会一直报 `Signature VerifyAC Error`**：
 *
 * 1. 参数加 `PublicKey` 后按**参数名升序**；
 * 2. 拼接为 **`key` 直接接 `value`**（无 `=`、无 `&`），跳过 null/undefined；
 * 3. **末尾追加 PrivateKey**；
 * 4. `Signature = SHA1(该串)`，**小写十六进制**（不是 HMAC，也不是 Base64）。
 *
 * 已用文档样例验证签名值与官方期望值逐字符一致。
 */

/** 平台默认接入点与默认地域。 */
export const COMP_SHARE_BASE_URL = "https://api.compshare.cn";
export const COMP_SHARE_DEFAULT_REGION = "cn-wlcb";
export const COMP_SHARE_DEFAULT_ZONE = "cn-wlcb-01";
/** 文档声明的公共 API 版本。 */
const API_VERSION = "2023-11-27";

export type CompShareCredentials = { publicKey: string; privateKey: string };

/** 上游返回的错误（带平台错误码，便于前端分流）。 */
export class CompShareError extends Error {
    constructor(readonly retCode: number, message: string) {
        super(message || `上游返回错误码 ${retCode}`);
        this.name = "CompShareError";
    }
}

/** 缺少密钥时的可行动错误（区别于「密钥错误」）。 */
export class CompShareNoKeyError extends Error {
    constructor() {
        super("尚未配置优云智算的 API 公私钥：请在「配置 → 本地代理 → GPU 实例」填入控制台「账户中心 → API 密钥」里的公钥与私钥");
        this.name = "CompShareNoKeyError";
    }
}

function assertKey(creds: CompShareCredentials | null | undefined): asserts creds is CompShareCredentials {
    if (!creds || !creds.publicKey?.trim() || !creds.privateKey?.trim()) throw new CompShareNoKeyError();
}

/** 逐字节 ASCII 字典序排序（UCloud 签名要求，不能用 localeCompare）。 */
function asciiSort(input: Record<string, unknown>): [string, string][] {
    return Object.entries(input)
        .filter(([, value]) => value !== undefined && value !== null && value !== "")
        .map(([key, value]) => [key, String(value)] as [string, string])
        .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}


/**
 * 把嵌套参数扁平化成点号路径 —— 与官方 SDK `Request.encode` 完全一致。
 *
 * `Disks: [{ IsBoot: true, Type: "CLOUD_SSD", Size: 100 }]`
 *   → `{ "Disks.0.IsBoot": true, "Disks.0.Type": "CLOUD_SSD", "Disks.0.Size": 100 }`
 * 数组里的标量元素则变成 `key.0`。
 *
 * 不做这一步就会报 `Params [api.<Action>.Request.<字段>] not available` ——
 * 网关按扁平的字段名寻址，收不到嵌套 JSON 里的字段。
 */
export function flattenParams(args: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(args)) {
        if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
        const value = args[key];
        if (value === null || value === undefined) continue;
        if (Array.isArray(value)) {
            value.forEach((item, index) => {
                if (item !== null && typeof item === "object") {
                    for (const [innerKey, innerValue] of Object.entries(flattenParams(item as Record<string, unknown>))) {
                        result[`${key}.${index}.${innerKey}`] = innerValue;
                    }
                } else {
                    result[`${key}.${index}`] = item;
                }
            });
        } else if (typeof value === "object") {
            for (const [innerKey, innerValue] of Object.entries(flattenParams(value as Record<string, unknown>))) {
                result[`${key}.${innerKey}`] = innerValue;
            }
        } else {
            result[key] = value;
        }
    }
    return result;
}

function newRequestId() {
    return crypto.randomUUID();
}

/**
 * 组装并签名一次请求。
 *
 * ⚠️ 算法**以 UCloud 官方 SDK 源码为准**（`@ucloud-sdks/ucloud-sdk-js`
 * `lib/core/credential` 的 `verifyAc`），而不是按文档的文字描述 —— 两者不一致，
 * 照文档写会一直报 `Signature VerifyAC Error`。要点：
 *
 * 1. 参数加入 `PublicKey` 后按**参数名升序**排序；
 * 2. 拼接是 **`key` 直接接 `value`**（`s += key; s += value`）——**没有 `=`、没有 `&`**；
 * 3. **末尾追加 PrivateKey**；
 * 4. `Signature = SHA1(上述字符串)`，**小写十六进制**（不是 HMAC，也不是 Base64）；
 * 5. 签名值与 PublicKey 一起放进请求参数（query 与 body 都带）。
 *
 * 已用文档样例验证：PublicKey=`ucloudsomeone@example.com…` / PrivateKey=`46f09bb9f…`
 * + {Action:DescribeUHostInstance, Region:cn-bj2, Limit:10}
 * ⇒ 签名 `cba5cf5ec4d4233d206b1b54951e3787350a642f`，与官方文档期望值**逐字符一致**。
 */
export function signRequest(creds: CompShareCredentials, method: "GET" | "POST", action: string, body: Record<string, unknown>, region = COMP_SHARE_DEFAULT_REGION, zone = COMP_SHARE_DEFAULT_ZONE) {
    assertKey(creds);
    const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    // **先按官方 SDK 的 Request.encode 把嵌套结构扁平化**，否则网关会报
    // `Params [api.<Action>.Request.<字段>] not available`（Disks 就是数组对象）。
    const flat = flattenParams(body);
    const params: Record<string, unknown> = { ...flat, Action: action, Version: API_VERSION, RequestId: newRequestId(), Timestamp: timestamp, PublicKey: creds.publicKey };
    if (region) params.Region = region;
    if (zone) params.Zone = zone;

    // key 直接接 value，跳过 null/undefined（与官方 SDK 的 forEach 判断一致）
    let raw = "";
    for (const key of Object.keys(params).sort()) {
        const value = params[key];
        if (value === null || value === undefined) continue;
        raw += key + String(value);
    }
    raw += creds.privateKey;
    const signature = crypto.createHash("sha1").update(raw).digest("hex");

    const query = asciiSort({ ...params, Signature: signature }).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
    return {
        url: `?${query}`,
        // body 里同样带上 Action/PublicKey/Signature（官方 SDK 的 sign() 也是放进参数里）
        // body 同样用扁平化后的参数 + Action/PublicKey/Signature（与 SDK 发送形态一致）
        body: method === "POST" ? JSON.stringify({ ...flat, Action: action, PublicKey: creds.publicKey, Signature: signature }) : null,
        signature,
        timestamp,
    };
}

/** 发起一次已签名的调用，返回 `data` 部分（非 0 码抛 CompShareError）。 */
export async function callCompShare<T = unknown>(creds: CompShareCredentials | null, action: string, params: Record<string, unknown> = {}, options: { method?: "GET" | "POST"; region?: string; zone?: string; baseUrl?: string; timeoutMs?: number } = {}): Promise<T> {
    assertKey(creds);
    const method = options.method || "GET";
    const baseUrl = (options.baseUrl || COMP_SHARE_BASE_URL).replace(/\/+$/, "");
    const { url, body } = signRequest(creds, method, action, params, options.region ?? COMP_SHARE_DEFAULT_REGION, options.zone ?? COMP_SHARE_DEFAULT_ZONE);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
    try {
        const response = await fetch(`${baseUrl}${url}`, {
            method,
            headers: { ...(body ? { "content-type": "application/json" } : {}), accept: "application/json" },
            body: body ?? undefined,
            signal: controller.signal,
        });
        const text = await response.text();
        let json: { RetCode?: number; Message?: string; Action?: string } & Record<string, unknown>;
        try {
            json = JSON.parse(text) as typeof json;
        } catch {
            // 非 JSON：通常是网关错误或 HTML 错误页，报可行动信息而不是让 JSON.parse 崩
            throw new CompShareError(-1, `接口返回了非 JSON 内容（HTTP ${response.status}）：${text.slice(0, 160)}`);
        }
        const retCode = Number(json.RetCode ?? 0);
        if (retCode !== 0) throw new CompShareError(retCode, String(json.Message || ""));
        return json as T;
    } catch (error) {
        if (error instanceof CompShareError) throw error;
        if (error instanceof Error && error.name === "AbortError") throw new CompShareError(-2, "请求超时（30 秒）");
        throw new CompShareError(-1, error instanceof Error ? error.message : String(error));
    } finally {
        clearTimeout(timer);
    }
}

/* ── 业务动作：只读查询 ── */

/** 可用区（含库存的地域/可用区列表）。 */
export function describeSupportZone(creds: CompShareCredentials) {
    return callCompShare<{ Zones?: { Zone?: string; Region?: string; ZoneName?: string }[] }>(creds, "DescribeCompShareSupportZone");
}

/** 可用 GPU 规格组合（CPU/内存的合法搭配必须查这个接口，不能任意配）。 */
export function describeInstanceTypes(creds: CompShareCredentials) {
    return callCompShare<{ InstanceTypes?: unknown[] }>(creds, "DescribeAvailableCompShareInstanceTypes");
}

/**
 * 镜像列表。
 *
 * Action 名是**平台真实提供的**（我先前写的 `DescribeCompShareImage` 在文档里 404）：
 *   · `DescribeCompShareImages`      平台/系统 + 应用镜像（ImageType: System / App）
 *   · `DescribeCommunityImages`      **社区镜像（500+，支持名称/作者/标签筛选与排序）**
 *   · `DescribeCompShareCustomImages` 自制镜像
 * 三者分别拉取后合并，页面按来源分组展示。
 */
export function describePlatformImages(creds: CompShareCredentials) {
    return callCompShare<{ ImageSet?: unknown[]; TotalCount?: number }>(creds, "DescribeCompShareImages", { Limit: 100 });
}

/**
 * 社区镜像列表。
 *
 * 响应结构与平台镜像**完全不同**（这是踩过的坑）：
 *   · 平台/自制镜像 → `ImageSet: [ … ]`（扁平行）
 *   · **社区镜像 → `CompshareImageGroup: [ { …, Data: [ CompShareImage, … ] } ]`（按版本组嵌套）**
 * 之前按 `ImageSet` 读社区镜像 ⇒ 恒为 undefined ⇒ 社区分组永远空。
 *
 * `Tag` 是**字符串数组**（平台文档写 `Array of String`），不是对象数组。
 */
export function describeCommunityImages(creds: CompShareCredentials, params: Record<string, unknown> = {}) {
    return callCompShare<{ CompshareImageGroup?: unknown[]; TotalCount?: number; AvailableTotalCount?: number }>(creds, "DescribeCommunityImages", {
        // 排除使用说明（富文本很长，会把响应撑爆且前端用不上）
        ExcludeReadme: true,
        SortCondition: { Field: "Favor", ASC: false },
        Limit: 100,
        ...params,
    });
}

export function describeCustomImages(creds: CompShareCredentials) {
    return callCompShare<{ ImageSet?: unknown[]; TotalCount?: number }>(creds, "DescribeCompShareCustomImages", { Limit: 100 });
}

/** 应用的预设端口（如 8888/8889/6006 等），用于「更多配置」提示可用端口。 */
export function describeSoftwarePorts(creds: CompShareCredentials) {
    return callCompShare<{ Softwares?: unknown[] }>(creds, "DescribeCompShareSoftwarePort");
}

/** GPU 余量库存（创建前判断卡型是否还有货，比 Describe 类接口可靠）。 */
export function describeGpuInventory(creds: CompShareCredentials, region?: string) {
    return callCompShare<unknown>(creds, "DescribeCompShareGpuInventory", {}, { region });
}

/** 我的实例列表。 */
export function describeInstances(creds: CompShareCredentials, region = COMP_SHARE_DEFAULT_REGION) {
    return callCompShare<{ Instances?: unknown[]; TotalCount?: number }>(creds, "DescribeCompShareInstance", { Limit: 100 }, { region });
}

/** 资源库存检查（创建前必须先查，文档明确要求不能用 Describe 类接口代替）。 */
export function checkResourceCapacity(creds: CompShareCredentials, params: Record<string, unknown>) {
    return callCompShare<unknown>(creds, "CheckCompShareResourceCapacity", params);
}

/* ── 业务动作：写操作（会产生费用 / 不可逆） ── */

/**
 * 创建实例。**会计费**。
 *
 * 文档约束（这里做前置校验，不把错误留给上游）：
 *   · 创建前必须先 `CheckCompShareResourceCapacity` 判断库存；
 *   · 账户有未支付订单时无法创建；
 *   · 内存必须是 1024 的整数倍（MB）。
 */
export function createInstance(creds: CompShareCredentials, params: Record<string, unknown>) {
    // **先校验凭据再校验参数**：否则未配置密钥时用户会看到「内存必须 1024 的整数倍」这种
    // 驴唇不对马嘴的提示，而真正的原因是缺密钥。
    assertKey(creds);
    const memory = Number(params.Memory);
    if (!Number.isFinite(memory) || memory <= 0 || memory % 1024 !== 0) {
        throw new CompShareError(-3, "内存必须是 1024 的整数倍（MB），例如 64GB 传 65536");
    }
    return callCompShare<{ UHostIds?: string[] }>(creds, "CreateCompShareInstance", params, { method: "POST" });
}

/** 启动实例（计费继续）。 */
export function startInstance(creds: CompShareCredentials, instanceId: string) {
    return callCompShare(creds, "StartCompShareInstance", { InstanceId: instanceId }, { method: "POST" });
}

/** 关机实例（停止计费，具体以平台规则为准）。 */
export function stopInstance(creds: CompShareCredentials, instanceId: string) {
    return callCompShare(creds, "StopCompShareInstance", { InstanceId: instanceId }, { method: "POST" });
}

/**
 * 释放实例。**不可恢复，数据会丢** —— 前端必须二次确认，这里再拦一道。
 */
export function releaseInstance(creds: CompShareCredentials, instanceId: string) {
    if (!instanceId?.trim()) throw new CompShareError(-3, "缺少实例 ID");
    return callCompShare(creds, "ReleaseCompShareInstance", { InstanceId: instanceId }, { method: "POST" });
}

/* ── 接入信息（用户在实例页看到的那些地址） ── */

/** vLLM 默认 API Key：平台侧约定的固定值，允许用户覆盖。 */
export const DEFAULT_VLLM_API_KEY = "sk-mycanvas-2026";

/**
 * 由实例 ID 拼出各端口的接入地址。
 *
 * 平台约定：
 *   · 8000 → OpenAI 兼容 API，**末尾要加 /v1**；
 *   · 8001 → GPU 监控，**末尾要加 /gpu-stats**；
 *   · 6006 → ComfyUI，**保持原样**（不加后缀）。
 */
export function buildEndpoints(instanceId: string, vllmApiKey = DEFAULT_VLLM_API_KEY) {
    const id = String(instanceId || "").trim();
    const base = (port: string) => `https://${port}-${id}.pod.compshare.cn`;
    return {
        apiBase: `${base("8000")}/v1`,
        apiKey: vllmApiKey,
        gpuStats: `${base("8001")}/gpu-stats`,
        comfyui: base("6006"),
    };
}
