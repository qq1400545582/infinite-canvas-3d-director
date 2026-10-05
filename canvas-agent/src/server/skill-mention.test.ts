import assert from "node:assert/strict";
import test from "node:test";

import type { CodexSkillMetadata } from "../agent/codex-protocol.js";
import { firstSkillMention, matchSkillByName } from "./skill-mention.js";

/** 构造最小可用的技能元数据。 */
function skill(name: string, skillPath: string, enabled = true): CodexSkillMetadata {
    return { name, path: skillPath, description: `${name} 测试技能`, scope: "project", enabled } as unknown as CodexSkillMetadata;
}

const catalog = [
    skill("hypit", "C:\\ws\\.agents\\skills\\hypit\\SKILL.md"),
    skill("pptx", "C:\\ws\\.agents\\skills\\pptx\\SKILL.md", false),
    skill("dupe", "C:\\a\\SKILL.md"),
    skill("dupe", "C:\\b\\SKILL.md"),
];

test("识别画布约定的【名称】技能提法", () => {
    assert.equal(firstSkillMention("请使用【hypit】技能，帮我完成：你能做什么"), "hypit");
    assert.equal(firstSkillMention("【 pptx 】帮我做一页"), "pptx");
    assert.equal(firstSkillMention("【hypit】和【pptx】都试试"), "hypit");
});

test("识别 Codex 约定的 $名称 提法", () => {
    assert.equal(firstSkillMention("$hypit 帮我拍一段短片"), "hypit");
    assert.equal(firstSkillMention("前缀-hypit 不算"), "");
    assert.equal(firstSkillMention("价格是 $100"), "100");
});

test("普通文本与带空格的【名称】不视为技能提法", () => {
    assert.equal(firstSkillMention("你好，能做什么"), "");
    assert.equal(firstSkillMention(""), "");
    assert.equal(firstSkillMention("请通过【24好玩 互动营销资料库】连接器帮我完成任务"), "");
});

test("matchSkillByName 只返回唯一且启用的技能", () => {
    assert.deepEqual(matchSkillByName(catalog, "hypit"), { name: "hypit", path: "C:\\ws\\.agents\\skills\\hypit\\SKILL.md" });
    assert.deepEqual(matchSkillByName(catalog, "HYPIT"), { name: "hypit", path: "C:\\ws\\.agents\\skills\\hypit\\SKILL.md" });
});

test("matchSkillByName 对停用/歧义/未登记的名称保持沉默", () => {
    assert.equal(matchSkillByName(catalog, "pptx"), undefined);
    assert.equal(matchSkillByName(catalog, "dupe"), undefined);
    assert.equal(matchSkillByName(catalog, "nope"), undefined);
    assert.equal(matchSkillByName(catalog, ""), undefined);
    assert.equal(matchSkillByName([], "hypit"), undefined);
});
