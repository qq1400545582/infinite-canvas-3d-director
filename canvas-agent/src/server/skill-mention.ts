import type { CodexSkillMetadata, CodexSkillSelector } from "../agent/codex-protocol.js";

/**
 * 从提示词中识别技能提法。
 *
 * 画布的「请使用【hypit】技能，帮我完成…」是自由文本，不带原生 Skill 选择器；
 * 此前模型只能自行读取 SKILL.md，而 Codex 的技能资源读取通路（read_mcp_resource）
 * 会报 MCP server not ready / -32601 Method not found。这里把画布与客户端两种
 * 既有提法收敛出来，供 turn 入口自动挂载原生 Skill：
 * - 画布约定：全角【名称】（专家/连接器调用语同样使用该约定，最终以技能列表精确匹配兜底）
 * - Codex 约定：$名称
 * 识别不到返回空串。
 */
export function firstSkillMention(prompt: string): string {
    const text = String(prompt || "");
    const bracket = text.match(/【\s*([^【】\s]{1,64}?)\s*】/);
    if (bracket?.[1]) return bracket[1];
    const dollar = text.match(/\$([A-Za-z0-9_-]{1,64})(?![A-Za-z0-9_-])/);
    return dollar?.[1] || "";
}

/**
 * 按名称在原生技能列表中查找唯一「已启用」的技能。
 * 找不到、已停用或同名歧义时返回 undefined——保持原有行为（让模型按老路径自行处理），
 * 不把识别失败升级成新的报错。
 */
export function matchSkillByName(skills: CodexSkillMetadata[], mention: string): CodexSkillSelector | undefined {
    const name = String(mention || "").trim().toLowerCase();
    if (!name) return undefined;
    const matches = skills.filter((skill) => skill.enabled && String(skill.name || "").toLowerCase() === name);
    return matches.length === 1 ? { name: matches[0].name, path: matches[0].path } : undefined;
}
