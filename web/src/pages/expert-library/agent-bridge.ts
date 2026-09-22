import {
    createCodexSkill,
    discoverAgentConfig,
    fetchCodexSkills,
    type AgentSkillInput,
    type AgentSkillSummary,
} from "@/services/api/canvas-agent";
import { useAgentStore } from "@/stores/use-agent-store";

/**
 * 专家库 ↔ 本机 Canvas Agent 的桥接层。
 *
 * 「调用专家 / 技能 / 连接器」以及「导入 / 创建 / 从链接安装技能」都依赖本机运行的
 * Canvas Agent：前者需要它的对话能力，后者需要它的 SkillStore（把技能真正写入
 * `<工作空间>/.agents/skills`）。这里只复用画布已有的公开 API 与 store 方法，
 * 不改动任何其它模块。
 */

export const DEFAULT_AGENT_ENDPOINT = "http://127.0.0.1:17371";

export type AgentTarget = { endpoint: string; token: string };

function normalizeEndpoint(value: string) {
    return (value || DEFAULT_AGENT_ENDPOINT).trim().replace(/\/+$/, "") || DEFAULT_AGENT_ENDPOINT;
}

/** 当前画布智能体的连接目标（含已保存的 token，可能为空）。 */
export function agentTarget(): AgentTarget {
    const agent = useAgentStore.getState();
    return { endpoint: normalizeEndpoint(agent.url), token: agent.token.trim() };
}

/**
 * 确保拿到可用的 Agent 连接目标。
 *
 * 已保存 token 时直接返回；否则尝试通过免鉴权的 `/config` 发现本机 Agent，
 * 并把 Local URL 预填到连接面板（token 必须由用户手动粘贴，`/config` 不会返回它）。
 */
export async function ensureAgentTarget(): Promise<AgentTarget | null> {
    const initial = agentTarget();
    if (initial.token) return initial;
    try {
        const discovered = await discoverAgentConfig(initial.endpoint);
        if (discovered) {
            useAgentStore.getState().setAgentState({ url: normalizeEndpoint(discovered.url || initial.endpoint) });
        }
    } catch {
        /* 本机未运行 Agent：按未连接处理 */
    }
    return null;
}

/** 连接失败时把用户带到智能体的连接配置页。 */
export function focusAgentSetup() {
    const agent = useAgentStore.getState();
    agent.openPanel();
    agent.setAgentState({ activeTab: "setup" });
}

/** 读取本机 Agent 已注册的技能清单（连接不可用或失败时返回 null）。 */
export async function listAgentSkills(): Promise<AgentSkillSummary[] | null> {
    const target = await ensureAgentTarget();
    if (!target) return null;
    try {
        const response = await fetchCodexSkills(target.endpoint, target.token, true);
        return response.data || [];
    } catch {
        return null;
    }
}

/** 把一条技能写入本机 Agent 的 SkillStore（真正安装到本机）。 */
export async function installAgentSkill(target: AgentTarget, input: AgentSkillInput) {
    return await createCodexSkill(target.endpoint, target.token, input);
}

/** 在已加载的技能清单中按名称 / id 找到同名技能，用于「调用」时选中 `$skill` 标记。 */
export function findAgentSkill(skills: AgentSkillSummary[], itemId: string, itemName: string) {
    const candidates = new Set([itemId.trim().toLowerCase(), itemName.trim().toLowerCase()]);
    return (
        skills.find((skill) => candidates.has(skill.name.toLowerCase())) ||
        skills.find((skill) => skill.interface?.displayName && candidates.has(skill.interface.displayName.toLowerCase())) ||
        skills.find((skill) => skill.name.toLowerCase() === itemId.replace(/^my:/, "").toLowerCase()) ||
        null
    );
}
