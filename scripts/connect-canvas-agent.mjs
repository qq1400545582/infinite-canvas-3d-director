#!/usr/bin/env node
/**
 * connect-canvas-agent.mjs
 *
 * 把 Infinite Canvas 一键接入各主流 AI 工具（统一走 MCP）。
 *
 * 背景：@basketikun/canvas-agent 自带一个标准 stdio MCP 服务端，暴露 34 个画布工具
 * （读/写节点、连线、四类生成、工作台、素材库、页面导航）。任何支持 MCP 的工具只要
 * 注册同一条命令即可获得全部画布能力，因此「接入」= 往各工具的配置文件里写一条 MCP 记录。
 *
 * 用法：
 *   node scripts/connect-canvas-agent.mjs                    # 查看状态（默认）
 *   node scripts/connect-canvas-agent.mjs status
 *   node scripts/connect-canvas-agent.mjs apply              # 写入全部（写前自动备份）
 *   node scripts/connect-canvas-agent.mjs apply --tool=workbuddy
 *   node scripts/connect-canvas-agent.mjs apply --dry-run    # 只预览不落盘
 *   node scripts/connect-canvas-agent.mjs revert --tool=trae # 从最近一次备份恢复
 *   node scripts/connect-canvas-agent.mjs open               # 起本机 agent 并打开画布
 *   node scripts/connect-canvas-agent.mjs open --canvas-url=https://你的站点
 *   node scripts/connect-canvas-agent.mjs open --url-only    # 只打印连接 URL
 *
 * 设计约束：
 *   - 只读写各工具自己的 MCP 配置文件，不触碰画布项目源码与运行时逻辑。
 *   - 幂等：已存在同名校验通过即跳过；任何写入前先备份为 <file>.bak-<时间戳>。
 *   - 解析失败的文件一律不写，只提示（避免破坏用户已有配置）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";

// ───────────────────────────── 常量 ─────────────────────────────

const SERVER_NAME = "infinite-canvas";
const NPM_PACKAGE = "@basketikun/canvas-agent";
const MCP_ARGS = ["-y", `${NPM_PACKAGE}@latest`, "mcp"];
const AGENT_PORT = Number(process.env.CANVAS_AGENT_PORT) || 17371;
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;

// CANVAS_CONNECT_HOME 仅用于隔离演练：指向临时目录即可在不动真实配置的前提下试跑全部写入/回滚。
const HOME = process.env.CANVAS_CONNECT_HOME || os.homedir();
const APPDATA = process.env.CANVAS_CONNECT_HOME
    ? path.join(HOME, "AppData", "Roaming")
    : process.env.APPDATA || path.join(HOME, "AppData", "Roaming");
const AGENT_CONFIG = path.join(HOME, ".infinite-canvas", "canvas-agent.json");
const CONNECT_CONFIG = path.join(HOME, ".infinite-canvas", "canvas-connect.json");

const C = { g: "\x1b[32m", y: "\x1b[33m", r: "\x1b[31m", d: "\x1b[90m", b: "\x1b[36m", x: "\x1b[0m" };
const ok = (s) => `${C.g}✓${C.x} ${s}`;
const no = (s) => `${C.d}·${C.x} ${s}`;
const warn = (s) => `${C.y}!${C.x} ${s}`;
const bad = (s) => `${C.r}✗${C.x} ${s}`;

// ───────────────────────────── 接入目标 ─────────────────────────────

/**
 * kind 说明：
 *   json        —— { "mcpServers": { ... } } 结构（WorkBuddy / Trae / Qwen / Cursor 系）
 *   codex-toml  —— ~/.codex/config.toml 的 [mcp_servers.xxx] 段
 *   dsh-patch   —— DSH 的 cordis.patch.yml（- insert: 语法）
 *   manual      —— 未确认配置文件位置，只给 UI 指引，不自动写入
 */
const TARGETS = [
    {
        key: "workbuddy",
        label: "WorkBuddy",
        kind: "json",
        file: () => path.join(HOME, ".workbuddy", "mcp.json"),
        entry: { type: "stdio", command: "npx", args: MCP_ARGS },
        note: "写好后需在「连接器管理 → 自定义连接器」里点『信任』该服务才生效",
    },
    {
        key: "codex",
        label: "Codex CLI",
        kind: "codex-toml",
        file: () => path.join(HOME, ".codex", "config.toml"),
        note: "也可用命令：codex mcp add infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp",
    },
    {
        key: "trae",
        label: "Trae CN",
        kind: "json",
        file: () => path.join(APPDATA, "Trae CN", "User", "mcp.json"),
        entry: { command: "npx", args: MCP_ARGS },
        note: "写入后重启 Trae CN；若界面未识别，改在 AI 侧栏「设置 → MCP」里手动添加同一条命令",
    },
    {
        key: "qwen",
        label: "Qwen Code（千问）",
        kind: "json",
        file: () => path.join(HOME, ".qwen", "settings.json"),
        entry: { type: "stdio", command: "npx", args: MCP_ARGS },
        note: "也可用命令：qwen mcp add --scope user --transport stdio infinite-canvas -- npx -y @basketikun/canvas-agent@latest mcp",
    },
    {
        key: "dsh",
        label: "DeepSeek Harness",
        kind: "dsh-patch",
        file: () => path.join(HOME, ".dsh", "profiles", "web", "cordis.patch.yml"),
        note: "写入后重启 dsh；验证：dsh web --dump-config | grep -A3 mcp",
    },
    {
        key: "agnescode",
        label: "AgnesCode",
        kind: "manual",
        hint: [
            "AgnesCode 通过 MCP 扩展接入，但未在本机找到其 MCP 配置文件（需先在 UI 里添加过一次才会生成）。",
            "做法：在 AgnesCode 设置里找到 MCP / Extensions（扩展）入口，新增一个 stdio 服务，",
            `命令填 npx，参数填 -y ${NPM_PACKAGE}@latest mcp，名称填 ${SERVER_NAME}。`,
            "若其支持直接粘贴 JSON，用下面这段：",
            `  { "mcpServers": { "${SERVER_NAME}": { "command": "npx", "args": ${JSON.stringify(MCP_ARGS)} } } }`,
        ],
        note: "以 UI 添加为准（未在本机实测）",
    },
];

const findTarget = (key) => TARGETS.find((t) => t.key === key);

// ───────────────────────────── 工具函数 ─────────────────────────────

function readJson(file) {
    if (!fs.existsSync(file)) return { exists: false, data: {} };
    const raw = fs.readFileSync(file, "utf8");
    if (!raw.trim()) return { exists: true, data: {} };
    try {
        return { exists: true, data: JSON.parse(raw) };
    } catch (e) {
        return { exists: true, data: null, error: e.message, raw };
    }
}

const stampNow = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/**
 * 写入前留退路：
 *  - 文件已存在 → 复制一份 <file>.bak-<时间戳>，回滚即覆盖回来；
 *  - 文件不存在 → 留一个空标记 <file>.new-<时间戳>，回滚即删除该文件（否则回滚不完整）。
 */
function backup(file) {
    const stamp = stampNow();
    if (!fs.existsSync(file)) {
        ensureDir(file);
        const marker = `${file}.new-${stamp}`;
        fs.writeFileSync(marker, "", "utf8");
        return { created: true, marker };
    }
    const dst = `${file}.bak-${stamp}`;
    fs.copyFileSync(file, dst);
    return { created: false, restore: dst };
}

function ensureDir(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
}

function writeFileSafe(file, content) {
    ensureDir(file);
    fs.writeFileSync(file, content, "utf8");
}

/** 判断某配置是否已包含画布 MCP。 */
function isInstalled(target) {
    const file = target.file();
    if (!fs.existsSync(file)) return false;
    const raw = fs.readFileSync(file, "utf8");
    if (target.kind === "json") {
        const { data } = readJson(file);
        return Boolean(data?.mcpServers?.[SERVER_NAME]);
    }
    if (target.kind === "codex-toml") return /\[mcp_servers\.infinite-canvas\]/.test(raw);
    if (target.kind === "dsh-patch") return raw.includes("mcp-infinite-canvas");
    return false;
}

// ───────────────────────────── 各 kind 的写入实现 ─────────────────────────────

function applyJson(target, dryRun) {
    const file = target.file();
    const { exists, data, error, raw } = readJson(file);
    if (data === null) {
        return { status: "skip", reason: `文件不是合法 JSON（${error}），已跳过以免破坏原有配置` };
    }
    const next = { ...(data || {}) };
    next.mcpServers = { ...(next.mcpServers || {}) };
    if (next.mcpServers[SERVER_NAME]) {
        return { status: "exists", reason: "已存在同名校验通过", file };
    }
    next.mcpServers[SERVER_NAME] = target.entry;
    const content = JSON.stringify(next, null, 2) + "\n";
    if (dryRun) return { status: "dry", reason: `将新增 mcpServers.${SERVER_NAME}`, file, content };
    const bak = backup(file);
    writeFileSafe(file, content);
    return { status: "written", file, backup: bak, created: !exists };
}

function applyCodexToml(target, dryRun) {
    const file = target.file();
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (/\[mcp_servers\.infinite-canvas\]/.test(raw)) {
        return { status: "exists", reason: "已存在 [mcp_servers.infinite-canvas]", file };
    }
    const block = [
        raw && !raw.endsWith("\n") ? "\n" : "",
        `[mcp_servers.${SERVER_NAME}]`,
        `command = "npx"`,
        `args = ${JSON.stringify(MCP_ARGS)}`,
        `default_tools_approval_mode = "approve"`,
        "",
    ].join("\n");
    const content = raw + block;
    if (dryRun) return { status: "dry", reason: `将追加 [mcp_servers.${SERVER_NAME}]`, file, content };
    const bak = backup(file);
    writeFileSafe(file, content);
    return { status: "written", file, backup: bak };
}

function applyDshPatch(target, dryRun) {
    const file = target.file();
    const raw = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (raw.includes("mcp-infinite-canvas")) {
        return { status: "exists", reason: "已存在 mcp-infinite-canvas", file };
    }
    // DSH 对 patch 文件有格式校验，写坏会被自动重建；只允许在「空数组」状态下替换。
    const body = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim();
    if (body !== "[]" && body !== "") {
        return { status: "manual", reason: "cordis.patch.yml 已有自定义内容，请手动追加（见输出末尾的片段）", file };
    }
    const content = [
        "# Infinite Canvas MCP（由 connect-canvas-agent.mjs 追加）",
        "- insert:",
        `    - id: mcp-${SERVER_NAME}`,
        "      name: '@deepseek-ai/dsh-mcp-client'",
        "      config:",
        `        serverName: ${SERVER_NAME}`,
        "        transport: stdio",
        "        command: npx",
        `        args: ${JSON.stringify(MCP_ARGS)}`,
        "",
    ].join("\n");
    if (dryRun) return { status: "dry", reason: "将把空数组替换为 insert 块", file, content };
    const bak = backup(file);
    writeFileSafe(file, content);
    return { status: "written", file, backup: bak };
}

function applyTarget(target, { dryRun }) {
    if (target.kind === "json") return applyJson(target, dryRun);
    if (target.kind === "codex-toml") return applyCodexToml(target, dryRun);
    if (target.kind === "dsh-patch") return applyDshPatch(target, dryRun);
    return { status: "manual", reason: "该工具需在界面里添加（未确认配置文件位置）", file: null };
}

// ───────────────────────────── agent 运行时探测 ─────────────────────────────

function httpJson(url, timeout = 4000) {
    return new Promise((resolve) => {
        const req = http.get(url, { timeout }, (res) => {
            let d = "";
            res.on("data", (c) => (d += c));
            res.on("end", () => {
                try { resolve(JSON.parse(d)); } catch { resolve({ ok: false, raw: d.slice(0, 200) }); }
            });
        });
        req.on("error", (e) => resolve({ ok: false, error: e.code }));
        req.on("timeout", () => { req.destroy(); resolve({ ok: false, error: "TIMEOUT" }); });
    });
}

function readAgentConfig() {
    const { data } = readJson(AGENT_CONFIG);
    if (!data?.token) return null;
    return { url: data.url || AGENT_URL, token: data.token };
}

async function readConnectConfig() {
    const { data } = readJson(CONNECT_CONFIG);
    return data || {};
}

async function saveConnectConfig(patch) {
    const cur = await readConnectConfig();
    const next = { ...cur, ...patch };
    ensureDir(CONNECT_CONFIG);
    fs.writeFileSync(CONNECT_CONFIG, JSON.stringify(next, null, 2) + "\n", "utf8");
    return next;
}

async function checkAgent() {
    const health = await httpJson(`${AGENT_URL}/health`);
    return health;
}

/** 在候选端口里猜一个画布站点地址。 */
async function guessCanvasUrl(explicit) {
    if (explicit) return explicit.replace(/\/$/, "").replace(/\/canvas$/, "");
    const saved = (await readConnectConfig()).canvasUrl;
    if (saved) return saved.replace(/\/$/, "");
    for (const port of [3000, 5173, 4173, 8080]) {
        const r = await httpJson(`http://127.0.0.1:${port}/plugins/index.json`);
        if (Array.isArray(r)) return `http://127.0.0.1:${port}`;
    }
    return null;
}

function buildCanvasLink(canvasUrl, agent, token) {
    const q = `agentUrl=${encodeURIComponent(agent)}&agentToken=${token}`;
    return `${canvasUrl}/canvas?mode=new#${q}`;
}

function openInBrowser(url) {
    if (process.platform === "win32") {
        spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else if (process.platform === "darwin") {
        spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else {
        spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
    }
}

// ───────────────────────────── 子命令 ─────────────────────────────

function parseArgs(argv) {
    const args = { _: [] };
    for (const a of argv) {
        const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
        if (m) args[m[1]] = m[2] === undefined ? true : m[2];
        else args._.push(a);
    }
    return args;
}

async function cmdStatus() {
    console.log(`${C.b}╭─ Infinite Canvas MCP 接入状态 ─────────────────${C.x}\n`);

    const health = await checkAgent();
    if (health?.ok) {
        const canvas = health.hasCanvas ? ok(`画布已连接（clients=${health.clients}）`) : warn("agent 在运行，但当前没有画布连上来");
        console.log(`  本机 Canvas Agent : ${ok(`运行中 ${AGENT_URL}`)}`);
        console.log(`  画布连接          : ${canvas}`);
    } else {
        console.log(`  本机 Canvas Agent : ${bad(`未运行（${health?.error || "无响应"}）`)}`);
        console.log(`  ${C.d}→ 运行「node scripts/connect-canvas-agent.mjs open」可自动拉起并打开画布${C.x}`);
    }

    const cfg = readAgentConfig();
    console.log(`  连接凭据          : ${cfg ? ok("已就绪（~/.infinite-canvas/canvas-agent.json）") : warn("尚未生成，首次启动 agent 时自动创建")}`);

    console.log(`\n${C.b}├─ 各工具接入 ───────────────────────────────────${C.x}`);
    for (const t of TARGETS) {
        if (t.kind === "manual" || typeof t.file !== "function") {
            console.log(`  ${t.label.padEnd(18)} ${warn("需在界面添加")}  ${C.d}${t.note}${C.x}`);
            continue;
        }
        const file = t.file();
        const exists = fs.existsSync(file);
        const installed = isInstalled(t);
        const mark = installed ? ok("已接入") : no("未接入");
        const state = exists ? `${C.d}${file}${C.x}` : `${C.d}${file} ${C.y}(文件不存在)${C.x}`;
        console.log(`  ${t.label.padEnd(18)} ${mark}  ${state}`);
    }
    console.log(`${C.b}╰────────────────────────────────────────────────${C.x}`);
    console.log(`\n${C.d}提示：接入只写入各工具自己的 MCP 配置，不影响画布项目本身。${C.x}`);
}

async function cmdApply(args) {
    const dryRun = Boolean(args["dry-run"]);
    const only = args.tool && args.tool !== "all" ? String(args.tool) : null;
    if (only && !findTarget(only)) {
        console.log(bad(`未知工具：${only}；可选：${TARGETS.map((t) => t.key).join(" / ")}`));
        process.exit(1);
    }
    const list = only ? [findTarget(only)] : TARGETS;

    console.log(`${C.b}接入 Infinite Canvas MCP${dryRun ? "（预览模式，不落盘）" : ""}${C.x}\n`);
    console.log(`  命令：npx ${MCP_ARGS.join(" ")}\n`);

    for (const t of list) {
        const r = applyTarget(t, { dryRun });
        const head = `  ${t.label.padEnd(18)}`;
        if (r.status === "written") {
            console.log(`${head} ${ok("已写入")} ${C.d}${r.file}${C.x}`);
            if (r.backup?.restore) console.log(`${" ".repeat(21)}${C.d}备份 → ${r.backup.restore}${C.x}`);
            else if (r.backup?.marker) console.log(`${" ".repeat(21)}${C.d}该文件为新建，回滚时会删除它${C.x}`);
        } else if (r.status === "exists") {
            console.log(`${head} ${ok("已接入，跳过")} ${C.d}${r.reason}${C.x}`);
        } else if (r.status === "dry") {
            console.log(`${head} ${warn("将写入")} ${C.d}${r.reason}${C.x}`);
        } else if (r.status === "manual") {
            console.log(`${head} ${warn("需手动")} ${C.d}${r.reason}${C.x}`);
        } else {
            console.log(`${head} ${bad("跳过")} ${C.d}${r.reason}${C.x}`);
        }
        if (t.kind === "manual" && (r.status === "manual" || r.status === "dry")) {
            t.hint.forEach((h) => console.log(`${" ".repeat(21)}${C.d}${h}${C.x}`));
        } else if (t.note && r.status !== "exists") {
            console.log(`${" ".repeat(21)}${C.d}${t.note}${C.x}`);
        }
    }

    if (!dryRun && !only) {
        console.log(`\n${C.d}下一步：重启对应工具使其重新加载 MCP；然后用「status」确认。${C.x}`);
        console.log(`${C.d}如果某工具启动异常，用 revert 从备份恢复：node scripts/connect-canvas-agent.mjs revert --tool=<key>${C.x}`);
    }
}

async function cmdRevert(args) {
    const only = args.tool ? String(args.tool) : null;
    const list = only ? [findTarget(only)] : TARGETS;
    if (only && !list[0]) { console.log(bad(`未知工具：${only}`)); process.exit(1); }

    let done = 0;
    for (const t of list) {
        if (!t.file) continue;
        const file = t.file();
        const dir = path.dirname(file);
        const base = path.basename(file);
        if (!fs.existsSync(dir)) { console.log(`  ${t.label.padEnd(18)} ${no("无目录")}`); continue; }
        const baks = fs.readdirSync(dir).filter((n) => n.startsWith(base + ".bak-")).sort();
        const news = fs.readdirSync(dir).filter((n) => n.startsWith(base + ".new-")).sort();
        if (baks.length) {
            const latest = path.join(dir, baks[baks.length - 1]);
            fs.copyFileSync(latest, file);
            console.log(`  ${t.label.padEnd(18)} ${ok("已恢复")} ${C.d}${latest} → ${file}${C.x}`);
            done++;
        } else if (news.length) {
            // 该文件是本脚本新建的：回滚 = 删除它以及留下的标记
            if (fs.existsSync(file)) fs.unlinkSync(file);
            news.forEach((n) => fs.unlinkSync(path.join(dir, n)));
            console.log(`  ${t.label.padEnd(18)} ${ok("已删除该文件（原本不存在）")} ${C.d}${file}${C.x}`);
            done++;
        } else {
            console.log(`  ${t.label.padEnd(18)} ${no("没有备份")}`);
        }
    }
    console.log(`\n${done ? ok(`恢复完成（${done} 个）`) : warn("没有可恢复的目标")}`);
}

async function cmdOpen(args) {
    const urlOnly = Boolean(args["url-only"]);
    let health = await checkAgent();

    if (!health?.ok) {
        console.log(`${warn("Canvas Agent 未运行，正在后台启动…")}`);
        if (process.platform === "win32") {
            spawn("cmd", ["/c", "start", "", "cmd", "/c", `npx -y ${NPM_PACKAGE}@latest`], { detached: true, stdio: "ignore", windowsHide: true }).unref();
        } else {
            spawn("npx", ["-y", `${NPM_PACKAGE}@latest`], { detached: true, stdio: "ignore" }).unref();
        }
        for (let i = 0; i < 30; i++) {
            await new Promise((r) => setTimeout(r, 1000));
            health = await checkAgent();
            if (health?.ok) { console.log(`  ${ok(`${i + 1}s 后已就绪`)}`); break; }
        }
    }
    if (!health?.ok) {
        console.log(bad("启动失败。请手动执行：npx -y @basketikun/canvas-agent@latest"));
        process.exit(1);
    }

    const cfg = readAgentConfig();
    const agent = cfg?.url || AGENT_URL;
    const token = cfg?.token;
    if (!token) { console.log(bad("读不到连接 token，请先手动启动一次 agent")); process.exit(1); }

    const canvasUrl = await guessCanvasUrl(args["canvas-url"]);
    if (!canvasUrl) {
        console.log(bad("猜不出画布站点地址，请显式指定：--canvas-url=https://你的画布站点"));
        process.exit(1);
    }
    if (args["canvas-url"]) await saveConnectConfig({ canvasUrl });

    const link = buildCanvasLink(canvasUrl, agent, token);
    console.log(`${C.b}画布连接信息${C.x}`);
    console.log(`  Canvas Agent : ${agent}`);
    console.log(`  画布站点     : ${canvasUrl}`);
    console.log(`  token        : ${token.slice(0, 6)}…（已省略）`);
    console.log(`\n${C.b}打开地址${C.x}（整行复制到浏览器）\n  ${link}\n`);

    if (urlOnly) return;
    openInBrowser(link);
    console.log(ok("已调用系统浏览器打开；连接成功后左侧「Agent」应显示已连接。"));
    console.log(`${C.d}之后再运行 status 可确认 hasCanvas 变为 true。${C.x}`);
}

function usage() {
    console.log(`用法：node scripts/connect-canvas-agent.mjs <命令> [选项]

命令：
  status                     查看 agent 与各工具接入状态（默认）
  apply                      写入接入配置（全部工具）
  revert                     从最近一次备份恢复
  open                       启动本机 Canvas Agent 并打开画布

选项：
  --tool=<key>              仅针对某个工具：${TARGETS.map((t) => t.key).join(" | ")}
  --dry-run                 apply 时只预览不落盘
  --canvas-url=<url>        open 时指定画布站点（会记住）
  --url-only                open 时只打印连接地址，不打开浏览器`);
}

// ───────────────────────────── 入口 ─────────────────────────────

const argv = parseArgs(process.argv.slice(2));
const cmd = argv._[0] || "status";

try {
    if (cmd === "status") await cmdStatus();
    else if (cmd === "apply") await cmdApply(argv);
    else if (cmd === "revert") await cmdRevert(argv);
    else if (cmd === "open") await cmdOpen(argv);
    else if (cmd === "help" || cmd === "--help" || cmd === "-h") usage();
    else { console.log(bad(`未知命令：${cmd}\n`)); usage(); process.exit(1); }
} catch (e) {
    console.log(bad(`执行失败：${e?.message || e}`));
    process.exit(1);
}
