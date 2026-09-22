import { create } from "zustand";

import { INSTALLED_CATEGORY, MY_CONNECTORS_CATEGORY } from "../data/types";
import type { ConnectorConfig, LibraryItem, ParsedSkill, SkillInstallRecord } from "../data/types";

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

type PersistedState = {
    experts: LibraryItem[];
    installs: SkillInstallRecord[];
    connectors: ConnectorConfig[];
};

const EMPTY: PersistedState = { experts: [], installs: [], connectors: [] };

function readPersisted(): PersistedState {
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return EMPTY;
        const parsed = JSON.parse(raw) as Partial<PersistedState> | null;
        return {
            experts: Array.isArray(parsed?.experts) ? parsed.experts.filter(isLibraryItem) : [],
            installs: Array.isArray(parsed?.installs) ? parsed.installs.filter(isInstallRecord) : [],
            connectors: Array.isArray(parsed?.connectors) ? parsed.connectors.filter(isConnectorConfig) : [],
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
};

export const useUserLibrary = create<UserLibraryState>((set, get) => {
    /** 任意一次写入都以完整快照落盘，避免各 action 各写一份导致字段丢失。 */
    const commit = (patch: Partial<PersistedState>) => {
        const next: PersistedState = {
            experts: patch.experts ?? get().experts,
            installs: patch.installs ?? get().installs,
            connectors: patch.connectors ?? get().connectors,
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
