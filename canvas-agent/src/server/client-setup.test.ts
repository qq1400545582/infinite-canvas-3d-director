import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CANVAS_MCP_KEY, codexSectionUpToDate, jsonEntryUpToDate, mcpServerEntry, runClientMcpSetup, upsertCodexMcpSection, type SetupOptions } from "./client-setup.js";

const WIN: SetupOptions = { platform: "win32" };
const UNIX: SetupOptions = { platform: "linux" };

async function tempOptions(): Promise<{ options: SetupOptions; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "canvas-setup-"));
    return { options: { homeDir: root, appDataDir: path.join(root, "appdata"), platform: "win32" }, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("mcpServerEntry 在 Windows 用 cmd /c npx 包装，其它平台直接 npx", () => {
    assert.deepEqual(mcpServerEntry("json-mcpServers", "win32"), { command: "cmd", args: ["/c", "npx", "-y", "@basketikun/canvas-agent", "mcp"] });
    assert.deepEqual(mcpServerEntry("json-mcpServers", "linux"), { command: "npx", args: ["-y", "@basketikun/canvas-agent", "mcp"] });
    assert.deepEqual(mcpServerEntry("json-servers", "win32"), { type: "stdio", command: "cmd", args: ["/c", "npx", "-y", "@basketikun/canvas-agent", "mcp"] });
});

test("upsertCodexMcpSection 无该节时追加且保留原内容，已有该节时原位替换", () => {
    const original = ['model = "gpt-5"', "", "[profiles.production]", 'name = "prod"'].join("\n");
    const appended = upsertCodexMcpSection(original, "win32");
    assert.ok(appended.changed);
    assert.ok(appended.text.startsWith(original));
    assert.ok(appended.text.includes('[mcp_servers.infinite-canvas]'));
    assert.ok(appended.text.includes('command = "cmd"'));
    assert.ok(appended.text.includes('args = ["/c", "npx", "-y", "@basketikun/canvas-agent", "mcp"]'));
    assert.ok(codexSectionUpToDate(appended.text, "win32"));
    assert.ok(!codexSectionUpToDate(appended.text, "linux"));

    const replaced = upsertCodexMcpSection(appended.text, "linux");
    assert.ok(replaced.changed);
    assert.ok(replaced.text.includes('command = "npx"'));
    assert.ok(!replaced.text.includes('command = "cmd"'));
    assert.ok(replaced.text.includes('name = "prod"'));
    assert.ok(codexSectionUpToDate(replaced.text, "linux"));
    assert.ok(!codexSectionUpToDate(replaced.text, "win32"));
});

test("status 未安装客户端时 detected=false，安装时跳过", async () => {
    const { options, cleanup } = await tempOptions();
    try {
        const status = await runClientMcpSetup({ action: "status" }, options);
        const clients = status.clients as Array<{ id: string; detected: boolean }>;
        assert.equal(clients.length, 6);
        assert.ok(clients.every((client) => !client.detected));
        const install = await runClientMcpSetup({ action: "install" }, options);
        const results = install.results as Array<{ status: string; reason?: string }>;
        assert.ok(results.every((item) => item.status === "skipped" && item.reason === "client_not_detected"));
    } finally {
        await cleanup();
    }
});

test("install 给 Cursor 写 mcpServers（cmd /c npx），幂等重跑返回 already，写入前有备份", async () => {
    const { options, cleanup } = await tempOptions();
    try {
        const cursorDir = path.join(options.homeDir!, ".cursor");
        await mkdir(cursorDir, { recursive: true });
        const configPath = path.join(cursorDir, "mcp.json");
        await writeFile(configPath, JSON.stringify({ mcpServers: {} }, null, 2), "utf8"); // 预置配置，验证写入前有备份
        const first = await runClientMcpSetup({ action: "install", clients: ["cursor"] }, options);
        const item = (first.results as Array<{ status: string; configPath?: string }>)[0];
        assert.equal(item.status, "written");
        assert.equal(item.configPath, configPath);
        const parsed = JSON.parse(await readFile(configPath, "utf8"));
        assert.deepEqual(parsed.mcpServers[CANVAS_MCP_KEY], mcpServerEntry("json-mcpServers", "win32"));
        const backup = await stat(configPath + ".canvas-agent-backup");
        assert.ok(backup.isFile());

        const again = await runClientMcpSetup({ action: "install", clients: ["cursor"] }, options);
        assert.equal((again.results as Array<{ status: string }>)[0].status, "already");

        const status = await runClientMcpSetup({ action: "status", clients: ["cursor"] }, options);
        const client = (status.clients as Array<{ detected: boolean; configured: boolean; upToDate: boolean }>)[0];
        assert.equal(client.detected, true);
        assert.equal(client.configured, true);
        assert.equal(client.upToDate, true);
    } finally {
        await cleanup();
    }
});

test("install 保留既有 mcpServers 其它条目，损坏 JSON 中止且不改原文件", async () => {
    const { options, cleanup } = await tempOptions();
    try {
        const workbuddyDir = path.join(options.homeDir!, ".workbuddy");
        await mkdir(workbuddyDir, { recursive: true });
        const configPath = path.join(workbuddyDir, "mcp.json");
        const original = JSON.stringify({ mcpServers: { other: { command: "uvx", args: ["x"] } } }, null, 2);
        await writeFile(configPath, original, "utf8");
        const result = await runClientMcpSetup({ action: "install", clients: ["workbuddy"] }, options);
        assert.equal((result.results as Array<{ status: string }>)[0].status, "written");
        const parsed = JSON.parse(await readFile(configPath, "utf8"));
        assert.deepEqual(parsed.mcpServers.other, { command: "uvx", args: ["x"] });
        assert.ok(parsed.mcpServers[CANVAS_MCP_KEY]);

        await writeFile(configPath, "{ this is not json", "utf8");
        const broken = await runClientMcpSetup({ action: "install", clients: ["workbuddy"] }, options);
        const item = (broken.results as Array<{ status: string; error?: string }>)[0];
        assert.equal(item.status, "failed");
        assert.match(item.error || "", /不是有效 JSON/);
        assert.equal(await readFile(configPath, "utf8"), "{ this is not json");
    } finally {
        await cleanup();
    }
});

test("VS Code 走 servers 键并带 type:stdio；jsonEntryUpToDate 对缺失键返回 false", async () => {
    const { options, cleanup } = await tempOptions();
    try {
        const userDir = path.join(options.appDataDir!, "Code", "User");
        await mkdir(userDir, { recursive: true });
        await writeFile(path.join(userDir, "settings.json"), "{}", "utf8");
        const result = await runClientMcpSetup({ action: "install", clients: ["vscode"] }, options);
        assert.equal((result.results as Array<{ status: string }>)[0].status, "written");
        const parsed = JSON.parse(await readFile(path.join(userDir, "mcp.json"), "utf8"));
        assert.deepEqual(parsed.servers[CANVAS_MCP_KEY], mcpServerEntry("json-servers", "win32"));
        assert.equal(jsonEntryUpToDate(parsed, "json-mcpServers"), false);
        assert.equal(jsonEntryUpToDate(parsed, "json-servers"), true);
    } finally {
        await cleanup();
    }
});

test("Codex：TOML 原有节被原位替换且其它节保留；未知客户端名报错", async () => {
    const { options, cleanup } = await tempOptions();
    try {
        const codexDir = path.join(options.homeDir!, ".codex");
        await mkdir(codexDir, { recursive: true });
        const configPath = path.join(codexDir, "config.toml");
        await writeFile(
            configPath,
            ['model_provider = "custom"', "", "[mcp_servers.old]", 'command = "legacy"', "", "[profiles.x]", 'name = "x"', ""].join("\n"),
            "utf8",
        );
        const result = await runClientMcpSetup({ action: "install", clients: ["codex"] }, options);
        assert.equal((result.results as Array<{ status: string }>)[0].status, "written");
        const text = await readFile(configPath, "utf8");
        assert.ok(text.includes('model_provider = "custom"'));
        assert.ok(text.includes("[profiles.x]"));
        assert.ok(text.includes("[mcp_servers.old]"), "其它 mcp_servers 节必须原样保留");
        assert.ok(codexSectionUpToDate(text, "win32"));
        await assert.rejects(runClientMcpSetup({ action: "status", clients: ["not-a-client"] }, options), /未知客户端/);
    } finally {
        await cleanup();
    }
});
