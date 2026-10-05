import { expertItemFromCatalog, connectorItemFromCatalog, type CatalogChangePayload } from "./data/catalog-mapping";
import { useUserLibrary } from "./state/user-library";

/**
 * 「立即拉取 WorkBuddy 更新」的编排层。
 *
 * 调用本机 Canvas Agent 的 `POST /agent/codex/workbuddy-sync`（只增不改的同步端点）：
 *   · 技能   —— Agent 把本机 WorkBuddy 的新技能克隆进 SkillStore（真实落盘可执行）；
 *   · 专家   —— Agent 拉取 WorkBuddy 专家市场目录，新增/更新的提示词包体落盘
 *     工作区 experts/（与静态目录同形态），回传目录变更给本层合并；
 *   · 连接器 —— Agent 读取本机 WorkBuddy 连接器市场缓存（含 mcp.json 接入参数），
 *     回传目录变更给本层合并。
 *
 * 目录变更以「覆盖层」合并进专家库（同 id 覆盖静态目录、新 id 追加），持久化在
 * localStorage；新增技能同时写入「已安装」记录，保证卡片可见、可调用。
 */

export type PullSummary = {
    at: string;
    skills: { added: Array<{ name: string; description: string }>; unchanged: number; conflicts: Array<{ name: string; reason: string }>; failed: Array<{ source: string; error: string }> };
    experts: { total: number; added: number; updated: number; adopted: number; unchanged: number; removed: number; bodiesFailed: Array<{ id: string; error: string }>; lastUpdated: string };
    connectors: { total: number; added: number; updated: number; removed: number; unchanged: number };
};

/** 拉取失败的可行动错误（message 为中文，可直接展示）。 */
export class PullError extends Error {
    constructor(readonly code: "no-agent" | "busy" | "http" | "network" | string, message: string) {
        super(message);
        this.name = "PullError";
    }
}

export async function pullWorkbuddyUpdates(): Promise<PullSummary> {
    const { ensureAgentTarget } = await import("./agent-bridge");
    const target = await ensureAgentTarget();
    if (!target?.token) throw new PullError("no-agent", "尚未连接本机 Canvas Agent");
    let payload: { ok?: boolean; error?: string; data?: unknown };
    try {
        // 首次拉取可能要下载几十个专家包体，超时放宽到 5 分钟；agent 端点对并发拉取返回 409。
        const response = await fetch(`${target.endpoint}/agent/codex/workbuddy-sync?token=${encodeURIComponent(target.token)}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(300_000),
        });
        if (response.status === 409) throw new PullError("busy", "上一次拉取尚未完成，请稍后重试");
        if (!response.ok) throw new PullError("http", `拉取请求失败（HTTP ${response.status}）`);
        payload = (await response.json()) as typeof payload;
    } catch (error) {
        if (error instanceof PullError) throw error;
        throw new PullError("network", "连不上本机 Canvas Agent：请确认智能体面板已连接（或点「一键启动 Canvas Agent」）");
    }
    if (!payload.ok || !payload.data || typeof payload.data !== "object") throw new PullError("http", payload.error || "拉取失败：Agent 返回了意外内容");
    const data = payload.data as PullRaw;
    const summary = summarize(data);

    // 目录覆盖层合并：以 id 为键累加（新的覆盖旧的），WorkBuddy 已下线的条目从覆盖层移除。
    const store = useUserLibrary.getState();
    const prev = store.catalog;
    const expertMap = new Map(prev.experts.map((item) => [item.id, item]));
    for (const change of [...data.experts.added, ...data.experts.updated]) expertMap.set(change.id, expertItemFromCatalog(change));
    for (const id of data.experts.removed) expertMap.delete(id);
    const connectorMap = new Map(prev.connectors.map((item) => [item.id, item]));
    for (const change of [...data.connectors.added, ...data.connectors.updated]) connectorMap.set(change.id, connectorItemFromCatalog(change));
    for (const id of data.connectors.removed) connectorMap.delete(id);
    store.applyCatalogOverlay([...expertMap.values()], [...connectorMap.values()]);

    // 新增/更新的技能已由 Agent 落盘到 SkillStore——写入「已安装」记录让它们在专家库可见、可调用。
    if (data.skills.added.length) {
        store.recordInstalls(
            data.skills.added.map((skill) => ({
                name: skill.name,
                description: skill.description || "WorkBuddy 同步技能",
                instructions: "",
                origin: "WorkBuddy 拉取更新",
                risky: false,
                riskReasons: [],
            })),
        );
    }
    return summary;
}

type PullRaw = {
    at: string;
    skills: PullSummary["skills"];
    experts: { lastUpdated: string; total: number; added: CatalogChangePayload[]; updated: CatalogChangePayload[]; removed: string[]; adopted: number; unchanged: number; bodiesFailed: Array<{ id: string; error: string }> };
    connectors: { total: number; added: CatalogChangePayload[]; updated: CatalogChangePayload[]; removed: string[]; unchanged: number; source: string };
};

function summarize(data: PullRaw): PullSummary {
    return {
        at: data.at,
        skills: data.skills,
        experts: {
            total: data.experts.total,
            added: data.experts.added.length,
            updated: data.experts.updated.length,
            adopted: data.experts.adopted,
            unchanged: data.experts.unchanged,
            removed: data.experts.removed.length,
            bodiesFailed: data.experts.bodiesFailed,
            lastUpdated: data.experts.lastUpdated,
        },
        connectors: {
            total: data.connectors.total,
            added: data.connectors.added.length,
            updated: data.connectors.updated.length,
            removed: data.connectors.removed.length,
            unchanged: data.connectors.unchanged,
        },
    };
}
