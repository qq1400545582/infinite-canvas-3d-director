import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import express from "express";

import {
    connectorMarketSources,
    parseFrontmatter,
    readSyncState,
    registerWorkbuddySync,
    workbuddySkillSources,
    writeSyncState,
} from "./workbuddy-sync.js";

test("parseFrontmatter 解析 SKILL.md 的 name/description 标量", () => {
    const parsed = parseFrontmatter("---\nname: web-design-layout\ndescription: \"网站设计与排版美化技能\"\n---\n\n正文内容");
    assert.equal(parsed.name, "web-design-layout");
    assert.equal(parsed.description, "网站设计与排版美化技能");
    // 无 frontmatter / 字段缺失时安全返回空串（调用方据此跳过该目录）
    assert.deepEqual(parseFrontmatter("没有 frontmatter 的文本"), { name: "", description: "" });
    assert.deepEqual(parseFrontmatter("---\ntitle: x\n---\nbody"), { name: "", description: "" });
});

test("workbuddySkillSources / connectorMarketSources 返回候选且不抛错", () => {
    const skillSources = workbuddySkillSources();
    assert.ok(skillSources.length >= 2);
    assert.ok(skillSources.some((source) => source.root.includes(path.join(".workbuddy", "skills"))));
    assert.ok(skillSources.every((source) => source.depth >= 1));
    const connectorSources = connectorMarketSources();
    assert.ok(connectorSources.length >= 1);
    assert.ok(connectorSources[0].includes("connectors-marketplace"));
});

test("同步状态 readSyncState / writeSyncState 往返与容错", async (context) => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wb-sync-state-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    // 无状态文件 → 空对象
    assert.deepEqual(await readSyncState(workspace), {});
    await writeSyncState(workspace, { experts: { lastUpdated: "2026-09-29T00:00:00Z", bodies: { Foo: "a1" } }, connectors: { bar: "h2" } });
    const state = await readSyncState(workspace);
    assert.equal(state.experts?.lastUpdated, "2026-09-29T00:00:00Z");
    assert.equal(state.experts?.bodies?.Foo, "a1");
    assert.equal(state.connectors?.bar, "h2");
    // 坏 JSON → 空对象（不抛错）
    await fs.writeFile(path.join(workspace, ".workbuddy-sync.json"), "{broken", "utf8");
    assert.deepEqual(await readSyncState(workspace), {});
});

test("workbuddy-sync 端点：注册后可访问、workspace 隔离、空来源时为空结果", async (context) => {
    // 来源隔离：WORKBUDDY_HOME / WORKBUDDY_RESOURCES 指向空临时目录，测试不依赖真机 WorkBuddy
    const fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "wb-sync-home-"));
    context.after(() => fs.rm(fakeHome, { recursive: true, force: true }));
    process.env.WORKBUDDY_HOME = fakeHome;
    process.env.WORKBUDDY_RESOURCES = path.join(fakeHome, "resources");
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "wb-sync-endpoint-"));
    context.after(() => fs.rm(workspace, { recursive: true, force: true }));
    const app = express();
    app.use(express.json());
    let emitted = 0;
    registerWorkbuddySync(app, {
        workspacePath: () => workspace,
        emitAll: () => {
            emitted += 1;
        },
    });
    const server = app.listen(0, "127.0.0.1");
    context.after(() => server.close());
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    // connectors: false / experts: false —— 只跑技能部分且指向空来源目录（无 WorkBuddy 的机器上也成立）
    const response = await fetch(`http://127.0.0.1:${port}/agent/codex/workbuddy-sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ parts: { skills: true, experts: false, connectors: false } }),
    });
    assert.equal(response.status, 200);
    const payload = (await response.json()) as { ok: boolean; data: { skills: { added: unknown[]; conflicts: unknown[] }; experts: { total: number }; connectors: { total: number }; at: string } };
    assert.equal(payload.ok, true);
    assert.deepEqual(payload.data.skills.added, []);
    assert.equal(payload.data.experts.total, 0);
    assert.equal(payload.data.connectors.total, 0);
    assert.ok(payload.data.at);
    // 状态文件落盘（空同步也应有结构）
    const state = await readSyncState(workspace);
    assert.ok(state.experts && state.connectors);
});
