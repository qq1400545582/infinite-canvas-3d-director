#!/usr/bin/env node
/**
 * connect-canvas-agent.mjs 的隔离回归测试。
 *
 * 全程在一个临时 HOME 里预置「用户已有配置」，验证：
 *   - 追加接入条目时不会破坏原有内容
 *   - 重复执行是幂等的
 *   - revert 能完整还原（含「原本不存在、由脚本新建」的文件）
 *   - 危险输入（DSH 已有自定义内容、JSON 已损坏）会被拒绝而不是覆盖
 *
 * 跑法：node scripts/connect-canvas-agent.test.mjs
 * 不会触碰真实的用户配置。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(REPO, "scripts", "connect-canvas-agent.mjs");
const TMP = path.join(os.tmpdir(), `canvas-connect-test-${process.pid}`);

fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const sha = (p) => (fs.existsSync(p) ? crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex").slice(0, 12) : "MISSING");
const w = (p, s) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s, "utf8"); };
const r = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : "<MISSING>");

const F = {
    codex: path.join(TMP, ".codex", "config.toml"),
    workbuddy: path.join(TMP, ".workbuddy", "mcp.json"),
    qwen: path.join(TMP, ".qwen", "settings.json"),
    dsh: path.join(TMP, ".dsh", "profiles", "web", "cordis.patch.yml"),
    trae: path.join(TMP, "AppData", "Roaming", "Trae CN", "User", "mcp.json"),
};

// ── 预置「用户已有配置」 ──
w(F.codex, `model_provider = "custom"\nmodel = "agnes-2.5-pro"\n\n[model_providers.custom]\nbase_url = "https://api.agnes-ai.cn/v1"\n`);
w(F.workbuddy, JSON.stringify({ mcpServers: { existing: { command: "node", args: ["x.js"] } } }, null, 2) + "\n");
w(F.qwen, JSON.stringify({ theme: "dark", mcpServers: { old: { command: "node", args: ["o.js"] } } }, null, 2) + "\n");
w(F.dsh, "# 由 DSH Desktop 生成：web profile 的用户补丁层。\n# 若此前因第三方插件写入而损坏，应用会在启动时自动重建为下面这个安全状态。\n[]\n");

const before = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, sha(p)]));
const run = (args) => spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: REPO, encoding: "utf8", env: { ...process.env, CANVAS_CONNECT_HOME: TMP },
});

const checks = [];
console.log("=== apply（全部工具）===");
console.log(run(["apply"]).stdout);

const cfg = r(F.codex);
checks.push(["codex 保留原有 model_providers", cfg.includes("api.agnes-ai.cn") && cfg.includes('model = "agnes-2.5-pro"')]);
checks.push(["codex 新增 [mcp_servers.infinite-canvas]", /\[mcp_servers\.infinite-canvas\]/.test(cfg) && cfg.includes("canvas-agent")]);

const wb = JSON.parse(r(F.workbuddy));
checks.push(["workbuddy 保留原有 existing 服务", Boolean(wb.mcpServers?.existing)]);
checks.push(["workbuddy 新增 infinite-canvas", wb.mcpServers?.["infinite-canvas"]?.command === "npx"]);

const qw = JSON.parse(r(F.qwen));
checks.push(["qwen 保留 theme 与原有 old 服务", qw.theme === "dark" && Boolean(qw.mcpServers?.old)]);
checks.push(["qwen 新增 infinite-canvas", Boolean(qw.mcpServers?.["infinite-canvas"])]);

checks.push(["dsh 空数组→insert 块", /- insert:/.test(r(F.dsh)) && r(F.dsh).includes("dsh-mcp-client")]);

const trae = JSON.parse(r(F.trae));
checks.push(["trae 新建文件并含条目", trae.mcpServers?.["infinite-canvas"]?.command === "npx"]);

// ── 幂等 ──
console.log("=== 再次 apply（幂等检查）===");
const a2 = run(["apply"]);
const skipped = (a2.stdout.match(/已接入，跳过/g) || []).length;
console.log(a2.stdout.split("\n").filter((l) => /已接入|已写入/.test(l)).join("\n"));
checks.push([`幂等：第二次 apply 全部跳过（跳过数=${skipped}）`, skipped >= 5]);

// ── 回滚 ──
console.log("\n=== revert（全部）===");
console.log(run(["revert"]).stdout);
const after = Object.fromEntries(Object.entries(F).map(([k, p]) => [k, sha(p)]));

for (const k of ["codex", "workbuddy", "qwen", "dsh"]) {
    checks.push([`revert 字节级还原 ${k}`, after[k] === before[k]]);
}
checks.push(["revert 删除了 trae 新建的 mcp.json", !fs.existsSync(F.trae)]);

// ── 边界：不覆盖危险输入 ──
console.log("=== 边界：DSH patch 非空时应拒绝写入 ===");
w(F.dsh, "- insert:\n    - id: user-own-plugin\n      name: 'some-pkg'\n");
const a3 = run(["apply", "--tool=dsh"]);
console.log(a3.stdout.split("\n").filter((l) => l.trim()).join("\n"));
checks.push(["DSH 有自定义内容时不写入，提示手动", /需手动|已有自定义内容/.test(a3.stdout) && !/canvas-agent/.test(r(F.dsh))]);

console.log("\n=== 边界：JSON 损坏时应跳过而非覆盖 ===");
w(F.workbuddy, "{ 这不是合法 JSON ,,,");
const a4 = run(["apply", "--tool=workbuddy"]);
console.log(a4.stdout.split("\n").filter((l) => l.trim()).join("\n"));
checks.push(["损坏 JSON 被跳过且文件未被覆盖", /跳过/.test(a4.stdout) && r(F.workbuddy).startsWith("{ 这不是合法 JSON")]);

// ── 汇总 ──
console.log("\n================ 结果 ================");
let pass = 0;
for (const [name, okv] of checks) {
    console.log(`  ${okv ? "PASS" : "FAIL"}  ${name}`);
    if (okv) pass++;
}
console.log(`\n${pass}/${checks.length} 通过`);

fs.rmSync(TMP, { recursive: true, force: true });
process.exit(pass === checks.length ? 0 : 1);
