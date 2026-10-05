import { create } from "zustand";

import { INSTALLED_CATEGORY, MY_CONNECTORS_CATEGORY } from "../data/types";
import type { ConnectorConfig, LibraryItem, LibraryKind, ParsedSkill, SkillInstallRecord } from "../data/types";

/**
 * 专家库用户数据（「我的专家」+「已安装技能」记录 +「我的连接器」）。
 *
 * 该 store 只服务于专家库模块：把用户通过 AI / 手工创建的专属专家、从
 * SKILL.md、zip、GitHub / Gitee 仓库导入安装的技能记录，以及自定义连接器
 * （MCP 风格的服务配置）持久化到 localStorage，使它们在刷新后仍可见、可调用，
 * 并可注册为画布节点。
 *
 * 说明：技能正文真正落盘在本机 Canvas Agent 的 `.agents/skills`，这里只保存
 * 展示与调用所需的轻量记录；自定义连接器同理只保存配置，不在浏览器里建立
 * 长连接，避免与其它模块的 Agent 生命周期耦合。
 */

const STORAGE_KEY = "expert-library:user-library";

/**
 * 「已隐藏」清单：用户从列表里移除的**目录条目** id（专家 / 技能 / 连接器各一份）。
 *
 * 为什么需要它：目录条目来自静态常量（data/*.ts）与「立即拉取」覆盖层，直接从数组里
 * 删掉的话，刷新页面它们就会原样回来。用户的「我的专家 / 已安装技能 / 自定义连接器」
 * 是自己创建的数据，走真删；目录条目则记在这里过滤，语义上等于「从我的列表移除」。
 */
export type RemovedLists = {
    experts: string[];
    skills: string[];
    connectors: string[];
};

/**
 * 更新渠道：点「更新」时从哪里拉目录。
 *
 * 三类来源：
 *   · `workbuddy` —— 走本机 Canvas Agent 的同步端点（技能真落盘可执行）；
 *   · `json`      —— 直接 fetch 一个 JSON 目录地址（GET 或 POST）；
 *   · `libtv`     —— LibTV 技能接口（POST + JSON body + 翻页），内置免手填。
 *
 * 自定义 JSON 渠道的响应须含 `LibraryItem[]`（或 `{items:[]}` / `{data:[]}`），
 * 合并进列表时同 id 覆盖，且同样可删除、可恢复。
 */
export type UpdateChannel = {
    /** 渠道 id（稳定标识） */
    id: string;
    /** 展示名（用户可读） */
    name: string;
    /** 来源类型：workbuddy 走 Agent 同步；json 直接 fetch；libtv 走内置技能接口 */
    kind: "workbuddy" | "json" | "libtv";
    /** 目录地址 */
    url?: string;
    /** 请求方式；缺省视为 GET（旧数据兼容） */
    method?: "GET" | "POST";
    /** POST 时的 JSON 请求体（字符串，原样发送） */
    body?: string;
    /** 响应里取列表的字段路径（缺省自动识别 list/items/data/裸数组） */
    listPath?: string;
    /** 翻页：每次请求在此 body 上叠加的页码字段与起始页（1 起） */
    pageField?: string;
    pageStart?: number;
    /** 每页条数（翻页时用） */
    pageSize?: number;
    /** 翻页上限（防止接口异常导致死循环） */
    maxPages?: number;
    /** 最近一次更新结果摘要（展示用） */
    lastAt?: number;
    lastSummary?: string;
};

/** 内置渠道 id：WorkBuddy 官方目录（行为与既有「立即拉取」完全一致）。 */
export const WORKBUDDY_CHANNEL_ID = "workbuddy";

/** 内置渠道 id：LibTV 技能（免手填，用户不必知道接口与参数）。 */
export const LIBTV_CHANNEL_ID = "libtv";

/**
 * LibTV 技能接口（POST）。
 *
 * 为什么必须 POST：实测 `GET`（含把 page/pageSize 放 query）一律 404 —— 该接口
 * 只接受 JSON 请求体。它的响应头 `access-control-allow-origin` 会回显 Origin，
 * 因此浏览器里可以直连（这是与 liblib.tv 页面地址的关键区别：后者无 CORS 头）。
 */
export const LIBTV_CHANNEL: UpdateChannel = {
    id: LIBTV_CHANNEL_ID,
    name: "LibTV 视频创作技能",
    kind: "libtv",
    url: "https://api.liblib.tv/api/community/skill/template/feed/stream",
    method: "POST",
    body: JSON.stringify({ query: "", page: 1, pageSize: 100 }),
    listPath: "data.list",
    pageField: "page",
    pageStart: 1,
    pageSize: 100,
    maxPages: 20,
};

/** 内置渠道 id → 定义（保证「更新」永远至少有两个可用渠道，且都不可删）。 */
export const BUILTIN_CHANNEL_LIST: UpdateChannel[] = [{ id: WORKBUDDY_CHANNEL_ID, name: "WorkBuddy 官方目录", kind: "workbuddy" }, LIBTV_CHANNEL];

/**
 * 是否内置渠道（不可删除、不可覆盖）。
 *
 * 判定**以 BUILTIN_CHANNEL_LIST 为唯一来源**——不要在 UI 或 action 里各写一份
 * `kind === "json"` / `id === ...` 的判断，否则新增内置渠道时必漏一处。
 */
export function isBuiltinChannelId(id: string) {
    return BUILTIN_CHANNEL_LIST.some((channel) => channel.id === id);
}

/** 是否自定义渠道（可增删改）。 */
export function isCustomChannel(channel: UpdateChannel) {
    return channel.kind === "json" && !isBuiltinChannelId(channel.id);
}

/** 新建渠道的稳定 id（按 URL slug，便于同名去重）。 */
export function channelIdFromUrl(url: string) {
    const slug = String(url || "")
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `channel:${slug || `custom-${Date.now().toString(36)}`}`;
}

/** 「立即拉取 WorkBuddy 更新」得到的目录覆盖层：同 id 覆盖静态目录、新 id 追加。 */
export type CatalogOverlay = {
    /** 最近一次拉取时间戳（0 = 从未拉取）。 */
    at: number;
    experts: LibraryItem[];
    connectors: LibraryItem[];
};

type PersistedState = {
    experts: LibraryItem[];
    installs: SkillInstallRecord[];
    connectors: ConnectorConfig[];
    catalog: CatalogOverlay;
    removed: RemovedLists;
    channels: UpdateChannel[];
    /** 自定义渠道拉来的技能目录（按渠道 id 分桶，同 id 条目覆盖旧值）。 */
    channelItems: Record<string, LibraryItem[]>;
};

const EMPTY_REMOVED: RemovedLists = { experts: [], skills: [], connectors: [] };

const EMPTY: PersistedState = {
    experts: [],
    installs: [],
    connectors: [],
    catalog: { at: 0, experts: [], connectors: [] },
    removed: EMPTY_REMOVED,
    channels: BUILTIN_CHANNEL_LIST,
    channelItems: {},
};

/**
 * 渠道白名单校验：坏数据直接丢弃。
 * 持久化里只可能出现自定义渠道（内置渠道每次读档都重新拼在前面），
 * 因此这里只接受 `json`，并要求有 url。
 */
function isUpdateChannel(value: unknown): value is UpdateChannel {
    const channel = value as Partial<UpdateChannel> | null;
    if (!channel || typeof channel.id !== "string" || typeof channel.name !== "string") return false;
    if (channel.kind !== "json") return false;
    if (typeof channel.url !== "string") return false;
    if (channel.method !== undefined && channel.method !== "GET" && channel.method !== "POST") return false;
    if (channel.body !== undefined && typeof channel.body !== "string") return false;
    return true;
}

/** 自定义渠道（不含内置渠道）。 */
function readChannels(value: unknown): UpdateChannel[] {
    if (!Array.isArray(value)) return BUILTIN_CHANNEL_LIST;
    const custom = value.filter(isUpdateChannel).filter((channel) => channel.kind === "json");
    return [...BUILTIN_CHANNEL_LIST, ...custom];
}

/** 渠道目录桶：逐桶逐条做 isLibraryItem 校验，坏数据丢弃。 */
function readChannelItems(value: unknown): Record<string, LibraryItem[]> {
    if (!value || typeof value !== "object") return {};
    const out: Record<string, LibraryItem[]> = {};
    for (const [channelId, list] of Object.entries(value as Record<string, unknown>)) {
        if (!Array.isArray(list)) continue;
        out[channelId] = list.filter(isLibraryItem);
    }
    return out;
}

/** LibraryKind → 隐藏清单字段（专家/技能/连接器各一份）。 */
const HIDDEN_LIST_KEY: Record<LibraryKind, keyof RemovedLists> = {
    expert: "experts",
    skill: "skills",
    connector: "connectors",
};

/** 旧版本落盘的数据没有 removed 字段，读出来补空清单（向后兼容，不能丢已有数据）。 */
function readRemoved(value: unknown): RemovedLists {
    const raw = value as Partial<RemovedLists> | null;
    if (!raw || typeof raw !== "object") return EMPTY_REMOVED;
    const pick = (list: unknown) => (Array.isArray(list) ? list.filter((id): id is string => typeof id === "string") : []);
    return { experts: pick(raw.experts), skills: pick(raw.skills), connectors: pick(raw.connectors) };
}

function readPersisted(): PersistedState {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return EMPTY;
        const parsed = JSON.parse(raw) as Partial<PersistedState> | null;
        const catalog = parsed?.catalog && typeof parsed.catalog === "object" ? parsed.catalog : null;
        return {
            experts: Array.isArray(parsed?.experts) ? parsed.experts.filter(isLibraryItem) : [],
            installs: Array.isArray(parsed?.installs) ? parsed.installs.filter(isInstallRecord) : [],
            connectors: Array.isArray(parsed?.connectors) ? parsed.connectors.filter(isConnectorConfig) : [],
            catalog: {
                at: catalog && typeof catalog.at === "number" ? catalog.at : 0,
                experts: catalog && Array.isArray(catalog.experts) ? catalog.experts.filter(isLibraryItem) : [],
                connectors: catalog && Array.isArray(catalog.connectors) ? catalog.connectors.filter(isLibraryItem) : [],
            },
            removed: readRemoved(parsed?.removed),
            channels: readChannels(parsed?.channels),
            channelItems: readChannelItems(parsed?.channelItems),
        };
    } catch {
        return EMPTY;
    }
}

function isLibraryItem(value: unknown): value is LibraryItem {
    const item = value as Partial<LibraryItem> | null;
    return Boolean(item && typeof item.id === "string" && typeof item.name === "string" && typeof item.callPrompt === "string");
}

function isInstallRecord(value: unknown): value is SkillInstallRecord {
    const record = value as Partial<SkillInstallRecord> | null;
    return Boolean(record && typeof record.name === "string" && typeof record.at === "number");
}

function isConnectorConfig(value: unknown): value is ConnectorConfig {
    const config = value as Partial<ConnectorConfig> | null;
    return Boolean(config && typeof config.name === "string" && typeof config.transport === "string");
}

function persist(state: PersistedState) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        /* 隐私模式或配额不足时静默降级：内存态仍然可用 */
    }
}

type UserLibraryState = PersistedState & {
    addExpert: (item: LibraryItem) => void;
    updateExpert: (id: string, patch: Partial<LibraryItem>) => void;
    removeExpert: (id: string) => void;
    recordInstalls: (skills: ParsedSkill[]) => void;
    removeInstalls: (names: string[]) => void;
    addConnector: (config: ConnectorConfig) => void;
    updateConnector: (name: string, patch: Partial<ConnectorConfig>) => void;
    removeConnector: (name: string) => void;
    setConnectorEnabled: (name: string, enabled: boolean) => void;
    /** 把目录条目从我的列表里移除（记入隐藏清单，可恢复）。 */
    hideItem: (kind: LibraryKind, id: string) => void;
    /** 恢复单个被隐藏的目录条目。 */
    restoreItem: (kind: LibraryKind, id: string) => void;
    /** 恢复全部被隐藏的目录条目。 */
    restoreAll: () => void;
    /** 新增 / 覆盖一个自定义更新渠道（同 id 视为覆盖）。 */
    saveChannel: (channel: UpdateChannel) => void;
    /** 删除自定义渠道（内置 WorkBuddy 渠道不可删）。 */
    removeChannel: (id: string) => void;
    /** 记录某渠道最近一次更新结果（展示用）。 */
    markChannelUpdated: (id: string, summary: string) => void;
    /** 用「立即拉取」的增量覆盖目录（同 id 覆盖、新 id 追加；整体快照落盘）。 */
    applyCatalogOverlay: (experts: LibraryItem[], connectors: LibraryItem[]) => void;
    /** 合并来自自定义渠道的目录条目（技能）。 */
    applyChannelItems: (channelId: string, items: LibraryItem[], summary: string) => void;
};

export const useUserLibrary = create<UserLibraryState>((set, get) => {
    /** 任意一次写入都以完整快照落盘，避免各 action 各写一份导致字段丢失。 */
    const commit = (patch: Partial<PersistedState>) => {
        const next: PersistedState = {
            experts: patch.experts ?? get().experts,
            installs: patch.installs ?? get().installs,
            connectors: patch.connectors ?? get().connectors,
            catalog: patch.catalog ?? get().catalog,
            removed: patch.removed ?? get().removed,
            channels: patch.channels ?? get().channels,
            channelItems: patch.channelItems ?? get().channelItems,
        };
        set(next);
        persist(next);
    };

    return {
        ...readPersisted(),
        addExpert: (item) => {
            commit({ experts: [normalizeExpert(item), ...get().experts.filter((entry) => entry.id !== item.id)] });
        },
        updateExpert: (id, patch) => {
            commit({ experts: get().experts.map((entry) => (entry.id === id ? normalizeExpert({ ...entry, ...patch }) : entry)) });
        },
        removeExpert: (id) => {
            commit({ experts: get().experts.filter((entry) => entry.id !== id) });
        },
        recordInstalls: (skills) => {
            const now = Date.now();
            const incoming = skills.map((skill): SkillInstallRecord => ({
                name: skill.name,
                ...(skill.interface?.displayName ? { displayName: skill.interface.displayName } : {}),
                description: skill.description,
                origin: skill.origin,
                at: now,
            }));
            const names = new Set(incoming.map((record) => record.name));
            commit({ installs: [...incoming, ...get().installs.filter((record) => !names.has(record.name))] });
        },
        removeInstalls: (names) => {
            const removing = new Set(names);
            commit({ installs: get().installs.filter((record) => !removing.has(record.name)) });
        },
        // 同名连接器视为同一条记录：再次保存即覆盖，避免列表里出现重复服务。
        addConnector: (config) => {
            commit({ connectors: [config, ...get().connectors.filter((entry) => entry.name !== config.name)] });
        },
        updateConnector: (name, patch) => {
            commit({ connectors: get().connectors.map((entry) => (entry.name === name ? { ...entry, ...patch } : entry)) });
        },
        removeConnector: (name) => {
            commit({ connectors: get().connectors.filter((entry) => entry.name !== name) });
        },
        setConnectorEnabled: (name, enabled) => {
            commit({ connectors: get().connectors.map((entry) => (entry.name === name ? { ...entry, enabled } : entry)) });
        },
        hideItem: (kind, id) => {
            const current = get().removed;
            // 技能目录的条目 id 与安装记录 name 同名（installToLibraryItem 用 name 当 id），这里统一按 id 记。
            const key = HIDDEN_LIST_KEY[kind];
            if (current[key].includes(id)) return;
            commit({ removed: { ...current, [key]: [...current[key], id] } });
        },
        restoreItem: (kind, id) => {
            const current = get().removed;
            const key = HIDDEN_LIST_KEY[kind];
            if (!current[key].includes(id)) return;
            commit({ removed: { ...current, [key]: current[key].filter((entry) => entry !== id) } });
        },
        restoreAll: () => {
            const current = get().removed;
            if (!current.experts.length && !current.skills.length && !current.connectors.length) return;
            commit({ removed: { experts: [], skills: [], connectors: [] } });
        },
        saveChannel: (channel) => {
            if (channel.kind !== "json" || isBuiltinChannelId(channel.id)) return; // 内置渠道不可覆盖
            commit({ channels: [channel, ...get().channels.filter((entry) => entry.id !== channel.id)] });
        },
        removeChannel: (id) => {
            if (isBuiltinChannelId(id)) return; // 内置渠道保证「更新」永远有路可走
            const items = { ...get().channelItems };
            delete items[id];
            commit({ channels: get().channels.filter((entry) => entry.id !== id), channelItems: items });
        },
        markChannelUpdated: (id, summary) => {
            const at = Date.now();
            commit({ channels: get().channels.map((entry) => (entry.id === id ? { ...entry, lastAt: at, lastSummary: summary } : entry)) });
        },
        applyChannelItems: (channelId, items, summary) => {
            // 整体覆盖该渠道的桶：渠道源删掉某个条目后，下次更新能真正消失。
            const at = Date.now();
            commit({
                channelItems: { ...get().channelItems, [channelId]: items },
                channels: get().channels.map((entry) => (entry.id === channelId ? { ...entry, lastAt: at, lastSummary: summary } : entry)),
            });
        },
        applyCatalogOverlay: (experts, connectors) => {
            commit({ catalog: { at: Date.now(), experts, connectors } });
        },
    };
});

/** 用户自建专家统一补齐字段，保证卡片 / 抽屉 / 节点渲染不会出现空值。 */
export function normalizeExpert(item: LibraryItem): LibraryItem {
    return {
        ...item,
        kind: "expert",
        source: "user",
        category: item.category || "我的专家",
        icon: item.icon || "userPlus",
        tags: item.tags?.length ? item.tags : ["我的专家"],
        features: item.features?.length ? item.features : [],
        meta: { 来源: "我的专家", ...(item.meta || {}) },
    };
}

/** 生成「我的专家」稳定 id（同一名称重复创建时覆盖）。 */
export function expertIdFromName(name: string) {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `my:${slug || `expert-${Date.now().toString(36)}`}`;
}

/** 已安装技能分类名（与目录分类并列展示）。 */
export { INSTALLED_CATEGORY };

/** 自定义连接器分类名。 */
export { MY_CONNECTORS_CATEGORY };

/** 生成「我的连接器」稳定 id（同名重复保存时覆盖）。 */
export function connectorIdFromName(name: string) {
    const slug = name
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return `my-connector:${slug || `connector-${Date.now().toString(36)}`}`;
}

const TRANSPORT_LABELS: Record<ConnectorConfig["transport"], string> = {
    stdio: "本地命令",
    sse: "SSE",
    http: "HTTP",
};

/** 用「命令 + 参数」或「URL」概括连接器的接入方式，供卡片与详情抽屉展示。 */
export function connectorEndpoint(config: ConnectorConfig) {
    if (config.transport === "stdio") {
        const args = config.args?.length ? ` ${config.args.join(" ")}` : "";
        return `${config.command || ""}${args}`.trim();
    }
    return config.url || "";
}

/** 把自定义连接器配置转换成可渲染、可调用、可注册为节点的连接器条目。 */
export function connectorToLibraryItem(config: ConnectorConfig): LibraryItem {
    const endpoint = connectorEndpoint(config);
    const transportLabel = TRANSPORT_LABELS[config.transport];
    const credentialCount = Object.keys(config.env || {}).length;
    const meta: Record<string, string> = {
        类型: "自定义连接器",
        传输方式: transportLabel,
    };
    if (endpoint) meta[config.transport === "stdio" ? "启动命令" : "服务地址"] = endpoint;
    if (credentialCount) meta[config.transport === "stdio" ? "环境变量" : "请求头"] = `${credentialCount} 项`;
    meta["状态"] = config.enabled ? "已启用" : "已停用";
    if (config.source) meta["导入来源"] = config.source;

    const features: string[] = [`传输方式：${transportLabel}`];
    if (config.transport === "stdio") {
        if (config.command) features.push(`启动命令：${config.command}`);
        if (config.args?.length) features.push(`启动参数：${config.args.join(" ")}`);
        if (credentialCount) features.push(`环境变量：${Object.keys(config.env!).join("、")}`);
    } else {
        if (config.url) features.push(`服务地址：${config.url}`);
        if (credentialCount) features.push(`请求头：${Object.keys(config.env!).join("、")}`);
    }

    return {
        id: connectorIdFromName(config.name),
        kind: "connector",
        name: config.name,
        category: MY_CONNECTORS_CATEGORY,
        icon: "plug",
        description: config.description || `${transportLabel} 自定义连接器${endpoint ? `：${endpoint}` : ""}`,
        tags: ["自定义", transportLabel],
        features,
        callPrompt: `请接入并使用我配置的自定义连接器【${config.name}】（${transportLabel}${endpoint ? ` · ${endpoint}` : ""}），帮我完成：`,
        meta,
        source: "user",
        origin: config.source || "手工配置",
        installedAt: config.at,
        connector: config,
    };
}

/** 把安装记录转换成可渲染、可调用、可注册为节点的技能条目。 */
export function installToLibraryItem(record: SkillInstallRecord): LibraryItem {
    const displayName = record.displayName || record.name;
    return {
        id: record.name,
        kind: "skill",
        name: displayName,
        category: INSTALLED_CATEGORY,
        icon: "sparkles",
        description: record.description,
        tags: [record.origin.split("·")[0].trim() || "已安装"],
        features: [],
        callPrompt: `请使用【${displayName}】技能，帮我完成：`,
        meta: { 位置: "agent", 来源: record.origin, 安装时间: new Date(record.at).toLocaleString() },
        source: "user",
        origin: record.origin,
        installedAt: record.at,
    };
}

/** 当前用户数据快照，供非 React 场景（画布节点注册）读取。 */
export function userLibrarySnapshot() {
    return useUserLibrary.getState();
}

/**
 * 渠道目录条目的**兜底**补齐（第二道防线）。
 *
 * 正常路径上 `channel-source.ts` 的 `channelItemToLibraryItem` 已把渠道原始字段
 * 归一成完整 LibraryItem；这里只防御「字段仍缺失」的异常数据（卡片/详情/节点
 * 都直接读这些字段，缺一个就可能空值甚至崩）。已有字段一律不覆盖。
 *
 * 来源标记为 `catalog` 而非 `user`：删除走**隐藏清单**而非真删，
 * 否则会误删同名安装记录，且渠道下次更新时条目又会原样回来。
 */
export function normalizeChannelItem(item: LibraryItem): LibraryItem {
    const name = String(item.name || item.id || "未命名技能");
    return {
        ...item,
        kind: "skill",
        name,
        category: item.category || "自定义渠道",
        icon: item.icon || "sparkles",
        description: item.description || "",
        tags: Array.isArray(item.tags) ? item.tags : [],
        features: Array.isArray(item.features) ? item.features : [],
        callPrompt: item.callPrompt || `请使用【${name}】技能，帮我完成：`,
        source: "catalog",
        origin: item.origin || "自定义渠道",
    };
}

/**
 * 删除一个库条目（列表页与详情抽屉共用）。
 *
 * 分两条路径，**不硬编码具体条目**：
 * - 用户自建 / 本地安装（`source === "user"`）→ 真删，条目不会再出现；
 * - 目录条目（`catalog`，含「立即拉取」覆盖层与自定义渠道）→ 记入隐藏清单，效果一样是从列表消失，
 *   但可以在顶部「恢复」里找回来（静态目录是常量，直接删会被刷新还原）。
 *
 * 技能目录条目与安装记录同名（`installToLibraryItem` 用 name 当 id），因此技能删除
 * 同时清掉同名安装记录，避免「移出列表后又被安装记录重新显示出来」。
 */
export function removeLibraryItem(item: LibraryItem) {
    const store = useUserLibrary.getState();
    if (item.source === "user") {
        if (item.kind === "expert") store.removeExpert(item.id);
        if (item.kind === "skill") store.removeInstalls([item.id]);
        if (item.kind === "connector") {
            const config = item.connector ?? store.connectors.find((entry) => connectorIdFromName(entry.name) === item.id);
            if (config) store.removeConnector(config.name);
        }
        return;
    }
    store.hideItem(item.kind, item.id);
}
