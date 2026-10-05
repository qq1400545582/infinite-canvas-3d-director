import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { listSkillResources, readResourceContents, resourceRoots, resourceTargetPath } from "./mcp.js";
import type { CanvasAgentConfig } from "../config.js";

test("resourceTargetPath 兼容 file:// URI 与模型直接传来的裸路径", () => {
    assert.equal(resourceTargetPath("file:///C:/Users/x/.agents/skills/hypit/SKILL.md"), "C:\\Users\\x\\.agents\\skills\\hypit\\SKILL.md");
    assert.equal(resourceTargetPath("C:/Users/Administrator/.infinite-canvas/codex-workspaces/site/.agents/skills/hypit/SKILL.md"), "C:\\Users\\Administrator\\.infinite-canvas\\codex-workspaces\\site\\.agents\\skills\\hypit\\SKILL.md");
    assert.equal(resourceTargetPath("C:\\Users\\Administrator\\a.md"), "C:\\Users\\Administrator\\a.md");
    assert.equal(resourceTargetPath("/C:/Users/x/a.md"), "C:\\Users\\x\\a.md");
    assert.equal(resourceTargetPath("file:///C:/Users/a%20b/c.md"), "C:\\Users\\a b\\c.md");
    assert.throws(() => resourceTargetPath(""), /URI 为空/);
});

test("readResourceContents 可读根目录内的文件，且 file:// 与裸路径等价", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-mcp-"));
    try {
        const file = path.join(root, "SKILL.md");
        await writeFile(file, "# Hypit\n你好", "utf8");
        const roots = [path.resolve(root)];
        const plain = await readResourceContents(file, roots);
        const viaUrl = await readResourceContents(`file:///${file.replace(/\\/g, "/")}`, roots);
        assert.equal(plain.text, "# Hypit\n你好");
        assert.deepEqual(viaUrl, plain);
        assert.match(plain.uri, /^file:\/\//);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("readResourceContents 拒绝根目录外路径、目录与缺失文件", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-mcp-"));
    const outside = await mkdtemp(path.join(os.tmpdir(), "canvas-out-"));
    try {
        await writeFile(path.join(outside, "secret.txt"), "outside", "utf8");
        await mkdir(path.join(root, "dir"), { recursive: true });
        const roots = [path.resolve(root)];
        await assert.rejects(readResourceContents(path.join(outside, "secret.txt"), roots), /允许读取的目录/);
        await assert.rejects(readResourceContents(path.join(root, "dir"), roots), /目录而非文件/);
        await assert.rejects(readResourceContents(path.join(root, "missing.md"), roots), /不存在/);
    } finally {
        await rm(root, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    }
});

test("readResourceContents 对超大文件截断到 1MB", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-mcp-"));
    try {
        const file = path.join(root, "big.md");
        await writeFile(file, "a".repeat(1024 * 1024 + 10), "utf8");
        const result = await readResourceContents(file, [path.resolve(root)]);
        assert.ok(result.text.endsWith("[文件超过 1MB，已截断]"));
        assert.ok(result.text.length <= 1024 * 1024 + 64);
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});

test("listSkillResources 只列出带 SKILL.md 的技能目录", async () => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "canvas-ws-"));
    try {
        await mkdir(path.join(workspace, ".agents", "skills", "hypit"), { recursive: true });
        await mkdir(path.join(workspace, ".agents", "skills", "empty"), { recursive: true });
        await writeFile(path.join(workspace, ".agents", "skills", "hypit", "SKILL.md"), "---\nname: hypit\n---\nbody", "utf8");
        await writeFile(path.join(workspace, ".agents", "skills", "loose.md"), "not a skill", "utf8");
        const resources = await listSkillResources(workspace);
        assert.equal(resources.length, 1);
        assert.equal(resources[0].name, "hypit");
        assert.match(resources[0].uri, /^file:\/\/\/[A-Za-z]:\/.+SKILL\.md$/);
        const contents = await readResourceContents(resources[0].uri, resourceRoots({ url: "", token: "", workspace: { workspacePath: workspace } } as CanvasAgentConfig));
        assert.equal(contents.text, "---\nname: hypit\n---\nbody");
    } finally {
        await rm(workspace, { recursive: true, force: true });
    }
});
