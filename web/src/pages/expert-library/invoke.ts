import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { ensureAgentTarget, findAgentSkill, listAgentSkills } from "./agent-bridge";
import type { LibraryItem } from "./data/types";

export type InvokeResult = "connected" | "no-agent";

/**
 * 在画布系统中「调用」某个专家 / 技能 / 连接器。
 *
 * 复用画布已有的智能体面板（常驻 UserLayout），通过智能体 store 的公开 API
 * 预填调用提示词并展开面板；同时自动发现并连接本机运行的 Canvas Agent，
 * 让面板真正可用（可上传图片 / 输入提示词 / 设置权限 / 发送）。
 *
 * 对于技能，还会额外把同名的、已经安装到本机 Agent 的 Skill 选中，
 * 使输入框带上 `$skill-name` 标记，等价于在智能体里手动选择技能。
 */
export async function invokeInCanvas(item: LibraryItem): Promise<InvokeResult> {
    const initial = useAgentStore.getState();
    initial.openPanel();
    initial.setAgentState({ prompt: item.callPrompt, activeTab: "chat" });

    const target = await ensureAgentTarget();
    if (!target) {
        // 没有可用的 Agent token：引导用户到连接配置页启动 / 接入 Canvas Agent。
        useAgentStore.getState().setAgentState({ activeTab: "setup" });
        return "no-agent";
    }

    if (item.kind === "skill") void selectInstalledSkill(item);

    useAgentStore.getState().connectAgent({ silent: true });
    return "connected";
}

/** 若本机 Agent 中存在同名技能，则选中它（写入 `$skill` 标记）。 */
async function selectInstalledSkill(item: LibraryItem) {
    try {
        let skills = useAgentSkillStore.getState().skills;
        if (!skills.length) {
            const listed = await listAgentSkills();
            if (listed) skills = listed;
        }
        const match = findAgentSkill(skills, item.id, item.name);
        if (!match || !match.enabled) return;
        useAgentSkillStore.getState().selectSkill(match, item.callPrompt);
    } catch {
        /* 选中失败时保留预填提示词，不影响调用 */
    }
}
