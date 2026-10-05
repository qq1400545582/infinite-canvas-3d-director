import { useUserLibrary, type UpdateChannel } from "./state/user-library";
import type { LibraryItem } from "./data/types";

/**
 * 更新渠道的目录拉取。
 *
 * 渠道协议：一个 JSON 目录地址，可选 GET / POST。
 *   · GET  —— 直接 fetch，地址不带参数；
 *   · POST —— 请求体为 JSON（渠道的 `body` 字段原样发送），用于那些**只接受 POST**
 *              的接口（LibTV 的技能流就是如此：GET 或把 page 放 query 一律 404）。
 * 响应形如 `[{id,name,description,...}]`，或 `{items:[...]}` / `{data:{list:[...]}}` 等包裹。
 *
 * 为什么自己 fetch 而不复用 Agent 同步端点：那条通路会把技能正文**落盘**到
 * `.agents/skills`（可执行文件），而渠道目录只是「展示 + 调用提示词」，
 * 不该让一个用户填的任意地址获得本机写权限。
 *
 * 安全约束（面向用户自填地址）：
 *   · 只接受 http/https，拦掉 javascript:/file:/data: 等危险协议；
 *   · 目录响应先经最小形态校验 + normalizeChannelItem 补齐，坏数据丢弃，
 *     绝不让不可信字段直接进卡片渲染；
 *   · 单次请求 30 秒超时；翻页有上限，接口异常也不会死循环；
 *   · 错误文案按「HTML 页面 / 跨域受限 / 格式不对」分别给出**可行动提示**。
 */

export class ChannelError extends Error {
    constructor(readonly code: "bad-url" | "http" | "network" | "cors" | "html" | "shape" | "empty" | string, message: string) {
        super(message);
        this.name = "ChannelError";
    }
}

/**
 * 渠道原始条目 → LibraryItem 的形态归一。
 *
 * 为什么必须有这一步：渠道返回的是**它自己的字段体系**（LibTV 是
 * `templateUuid / skillKey / ownerName / usePv / useScenario / resultType …`），
 * 与 LibraryItem 完全不同构 —— 有的连 `id` 都没有。不归一的话：
 *   · 最小形态校验会把整页全过滤掉（表现为「没有返回任何技能条目」）；
 *   · 即便混进来，卡片与调用提示词也全是空值。
 *
 * **id 必须唯一**：实测 LibTV 的 `skillKey` 首段会大量撞名（`oriental-*` 34 条、
 * `xianxia-*` 12 条…），只取首段会让 1338 条挤成 517 个 id ⇒ 卡片互相覆盖。
 * 因此这里用**完整 skillKey**（实测 1338 条全唯一）；无 key 时回落 uuid。
 * 随包静态目录用同一套规则（`build-self-media.mjs` 里 slug + 冲突补序号），
 * 两条来源对同一条技能算出的 id 一致，列表按 id 去重后只显示一张卡。
 */
export function channelItemToLibraryItem(raw: unknown): LibraryItem | null {
    const item = raw as Record<string, unknown> | null;
    if (!item || typeof item !== "object") return null;
    const name = String(item.name ?? item.title ?? "").trim();
    if (!name) return null;

    const key = String(item.skillKey ?? "").trim();
    const uuid = String(item.templateUuid ?? item.skillUuid ?? "").trim();
    // id 用**完整 skillKey**（实测 1338 条全唯一）。不能只取 slug 段：不同技能会共用 slug
    // （`oriental-aesthetic-film-*` 有 3 个不同技能、`viral-video-replicator-*` 有 4 个），
    // 只取 slug 会让 1338 条挤成 1310 个 id ⇒ 卡片互相覆盖。
    // 兜底链每一步都必须真的产出非空值：`liblib-${"".slice(0,8)}` 会得到 "liblib-" 这种
    // 伪 id（非空 ⇒ 绕过后面的 !id 检查），所以只在 uuid 非空时才用它。
    const id = (key && slugifyChannelId(key)) || (uuid && (slugifyChannelId(uuid) || `liblib-${uuid.slice(0, 8)}`));
    // 既无 skillKey 也无 uuid ⇒ 无法给稳定 id，直接丢弃（否则多条会挤成同一个伪 id）。
    if (!id) return null;

    const author = String(item.ownerName ?? item.nickname ?? "").trim();
    const uses = formatUses(item.usePv);
    const medium = RESULT_TYPE_LABELS[Number(item.resultType)] ?? "文本";
    const scenario = String(item.useScenario ?? "").trim();
    const input = String(item.inputType ?? "").trim();
    const output = String(item.outputContent ?? "").trim();
    const version = String(item.version ?? "").trim();

    const tags = [medium, author ? `作者 ${author}` : "", uses !== "—" ? `${uses} 次使用` : ""].filter(Boolean).slice(0, 3);
    const features = [scenario && `适用：${scenario.slice(0, 120)}`, input && `输入：${input.slice(0, 100)}`, output && `产出：${output.slice(0, 100)}`].filter(Boolean) as string[];

    const meta: Record<string, string> = { 产出形态: medium, 来源: "LibTV 技能目录" };
    if (author) meta.作者 = author;
    if (uses !== "—") meta.使用量 = uses;
    if (version) meta.版本 = version;
    if (scenario) meta.适用场景 = scenario.slice(0, 200);

    return {
        id,
        kind: "skill",
        name,
        category: "自媒体",
        icon: ICON_BY_MEDIUM[medium] ?? "sparkles",
        description: String(item.description ?? scenario ?? "").trim(),
        tags,
        features,
        // 调用提示词要能直接投喂智能体：带上技能名、作者与适用场景，便于模型进入角色。
        callPrompt: `请使用【${name}】技能${author ? `（作者：${author}）` : ""}${scenario ? `，围绕「${scenario.slice(0, 80)}」` : ""}，帮我完成：`,
        meta,
        source: "catalog",
        origin: "LibTV 技能渠道",
    };
}

/** 渠道侧稳定的 id：slug 化，缺中文时用 uuid 兜底。 */
function slugifyChannelId(source: string) {
    const base = String(source || "")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return base;
}

/** 1338 → 1.3w，与站点展示一致。 */
function formatUses(pv: unknown) {
    const n = Number(pv);
    if (!Number.isFinite(n) || n <= 0) return "—";
    if (n >= 10000) return `${(n / 10000).toFixed(1)}w`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
    return String(n);
}

/** LibTV 的 resultType → 产出形态（与静态目录生成脚本的映射一致）。 */
const RESULT_TYPE_LABELS: Record<number, string> = { 1: "文本", 2: "图片", 3: "视频", 4: "音频" };

/** 产出形态 → 卡片图标（须在 icon-map 注册）。 */
const ICON_BY_MEDIUM: Record<string, string> = { 文本: "fileText", 图片: "image", 视频: "clapperboard", 音频: "music" };

/** 从响应里取出目录数组（兼容裸数组与常见包裹，含渠道显式指定的 listPath）。 */
export function extractChannelItems(payload: unknown, listPath?: string): LibraryItem[] {
    const list = Array.isArray(payload) ? payload : readWrappedList(payload, listPath);
    if (!list) throw new ChannelError("shape", "目录格式不对：应返回技能数组，或 { items: [...] }");
    // 归一：渠道字段体系各异（有的连 id 都没有），统一转成 LibraryItem；无法归一的丢弃。
    const items: LibraryItem[] = [];
    for (const raw of list) {
        const item = channelItemToLibraryItem(raw);
        if (item) items.push(item);
    }
    return items;
}

/** 原始列表长度（用于「有数据但全被过滤」的可行动报错）。 */
function rawListLength(payload: unknown, listPath?: string) {
    const list = Array.isArray(payload) ? payload : readWrappedList(payload, listPath);
    return Array.isArray(list) ? list.length : 0;
}

/** 按点路径（`data.list`）取数组；缺省按 items / data / data.list 依次尝试。 */
function readWrappedList(payload: unknown, listPath?: string): unknown[] | null {
    if (!payload || typeof payload !== "object") return null;
    if (listPath) {
        let cursor: unknown = payload;
        for (const key of listPath.split(".")) {
            if (!cursor || typeof cursor !== "object") return null;
            cursor = (cursor as Record<string, unknown>)[key];
        }
        return Array.isArray(cursor) ? cursor : null;
    }
    const record = payload as { items?: unknown; data?: unknown };
    if (Array.isArray(record.items)) return record.items;
    if (Array.isArray(record.data)) return record.data;
    if (record.data && typeof record.data === "object" && Array.isArray((record.data as { list?: unknown }).list)) {
        return (record.data as { list: unknown[] }).list;
    }
    return null;
}

/** 校验渠道地址：仅 http/https，拦掉 javascript: / data: / file: 等。 */
export function normalizeChannelUrl(input: string): string {
    const raw = String(input || "").trim();
    if (!raw) throw new ChannelError("bad-url", "请填写目录地址");
    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        throw new ChannelError("bad-url", "地址格式不对，需以 http:// 或 https:// 开头");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new ChannelError("bad-url", "只支持 http / https 地址");
    }
    return parsed.toString();
}

/** 单次请求：按渠道的 method 分派，返回原始 JSON。 */
async function requestOnce(channel: UpdateChannel, url: string, signal: AbortSignal): Promise<unknown> {
    const method = channel.method === "POST" ? "POST" : "GET";
    const init: RequestInit = { headers: { accept: "application/json" }, signal };
    if (method === "POST") {
        init.method = "POST";
        init.headers = { ...init.headers, "content-type": "application/json" };
        init.body = channel.body || "{}";
    }
    const response = await fetch(url, init);
    const text = await response.text();
    if (!response.ok) throw new ChannelError("http", `拉取失败（HTTP ${response.status}）`);
    // 拿到 HTML 说明用户填的是网页地址而不是 JSON 接口——这是最常见的误填，必须明确告知。
    const contentType = response.headers.get("content-type") || "";
    const looksHtml = /text\/html/i.test(contentType) || /^\s*<(!doctype|html)/i.test(text);
    if (looksHtml) {
        throw new ChannelError("html", "这个地址返回的是网页（HTML），不是技能目录 JSON。网页上的技能由页面脚本动态加载，请改用该站的数据接口地址；若只是想用 LibTV 技能，直接用内置的「LibTV 视频创作技能」渠道。");
    }
    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new ChannelError("shape", "该地址返回的不是合法 JSON，无法作为技能目录");
    }
}

/** 把渠道的 body 解析成对象；非法则视为空对象（由上层给出可行动错误）。 */
function parseBody(body: string | undefined): Record<string, unknown> {
    if (!body) return {};
    try {
        const parsed = JSON.parse(body) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
        throw new ChannelError("bad-url", "请求体不是合法 JSON，请检查渠道配置");
    }
}

export type ChannelFetchResult = { count: number; pages: number };

/** 拉取进度（用于「实时监控」：正在拉第几页、已得几条）。 */
export type PullProgress = { page: number; count: number };

/**
 * 拉取一个渠道的目录并合并进 store（整体覆盖该渠道的桶）。
 * 配了 `pageField` 的渠道（如 LibTV）会自动翻页到末页。
 */
export async function pullChannel(channel: UpdateChannel, onProgress?: (progress: PullProgress) => void): Promise<ChannelFetchResult> {
    const url = normalizeChannelUrl(channel.url || "");
    const paginated = Boolean(channel.pageField);
    const maxPages = paginated ? Math.max(1, Math.min(channel.maxPages || 20, 50)) : 1;
    const collected: LibraryItem[] = [];
    const seenIds = new Set<string>();
    let pages = 0;
    let rawSeen = 0; // 接口确实返回了多少条（用于区分「接口真空」与「全被过滤」）

    for (let page = 0; page < maxPages; page += 1) {
        const signal = AbortSignal.timeout(30_000);
        let payload: unknown;
        if (paginated) {
            // 每页都要带上新的页码：body 里既有 page 字段就替换，没有就整体重建
            const body = parseBody(channel.body);
            body[channel.pageField!] = (channel.pageStart ?? 1) + page;
            if (channel.pageSize) body.pageSize = channel.pageSize;
            const scoped: UpdateChannel = { ...channel, body: JSON.stringify(body) };
            payload = await requestOnce(scoped, url, signal);
        } else {
            payload = await requestOnce(channel, url, signal);
        }
        pages += 1;
        rawSeen += rawListLength(payload, channel.listPath);
        for (const item of extractChannelItems(payload, channel.listPath)) {
            if (seenIds.has(item.id)) continue; // 同一技能跨页重复时只留一条
            seenIds.add(item.id);
            collected.push(item);
        }
        // 实时进度：每页拉完就报一次，专区监控条据此显示「正在拉第 N 页 / 已得 N 条」
        onProgress?.({ page: pages, count: collected.length });
        // 翻页渠道：靠 hasMore 判断是否到底；单页渠道拉一次即止
        if (!paginated) break;
        const hasMore = readHasMore(payload);
        if (hasMore === false) break;
        if (hasMore === undefined && collected.length === 0) break;
    }

    if (!collected.length) {
        // 区分两种「空」：接口本身没数据 vs 有数据但字段对不上（归一后被全部丢弃）
        throw new ChannelError("empty", rawSeen > 0 ? `该渠道返回了 ${rawSeen} 条数据，但没有一条能识别成技能条目（字段与技能目录不匹配）。请确认该地址返回的是技能列表 JSON。` : "该渠道没有返回任何技能条目。");
    }
    const items = collected;
    const summary = `${items.length} 项`;
    useUserLibrary.getState().applyChannelItems(channel.id, items, summary);
    return { count: items.length, pages };
}

/** 读响应里的 hasMore（用于翻页终止）；没有该字段返回 undefined。 */
function readHasMore(payload: unknown): boolean | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as { hasMore?: unknown; data?: { hasMore?: unknown } };
    if (typeof record.hasMore === "boolean") return record.hasMore;
    if (record.data && typeof record.data.hasMore === "boolean") return record.data.hasMore;
    return undefined;
}

/** 把浏览器侧的跨域失败翻译成可行动提示（fetch 的 TypeError 分不清 CORS / 断网 / 证书）。 */
export function describeChannelError(error: unknown): string {
    if (error instanceof ChannelError) return error.message;
    if (error instanceof DOMException && error.name === "TimeoutError") return "拉取超时（30 秒）";
    if (error instanceof TypeError) {
        return "连不上该地址：可能是跨域被浏览器拦截（该站点未开放 CORS）、地址不通，或本机网络问题。自定义渠道需由对方站点开放 CORS 才能在浏览器里直连。";
    }
    return error instanceof Error ? error.message : String(error);
}
