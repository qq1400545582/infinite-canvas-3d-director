import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * 一键把本机 Agent 注册成各 MCP 工具的配置（client_mcp_setup 工具的实现）。
 *
 * 三个格式补丁都在这里落地：
 *  1. Codex CLI 用 ~/.codex/config.toml（TOML），只增改 [mcp_servers.infinite-canvas] 一节，其余内容逐字节保留；
 *  2. VS Code 用户级 mcp.json 用 "servers" 键（其余工具用 "mcpServers"）；
 *  3. Windows 上 npx 是 .cmd 脚本，不能被无 shell 的 spawn 直接拉起，
 *     统一包装成 cmd /c npx（无论客户端是否经 shell 启动都能工作）。
 *
 * 安全约束：JSON 解析失败时中止并不改原文件；所有写入前先做同目录备份；幂等（已是目标内容则跳过）。
 */

export const CANVAS_MCP_KEY = "infinite-canvas";
const MCP_PACKAGE = "@basketikun/canvas-agent";
const BACKUP_SUFFIX = ".canvas-agent-backup";

export type SetupClientId = "codex" | "claude-desktop" | "cursor" | "vscode" | "workbuddy" | "trae";
export type SetupAction = "status" | "install";

export type SetupOptions = { homeDir?: string; appDataDir?: string; platform?: NodeJS.Platform };

type ConfigKind = "toml" | "json-mcpServers" | "json-servers";

interface ClientSpec {
    id: SetupClientId;
    label: string;
    kind: ConfigKind;
    /** 候选配置文件路径：读取/安装取第一个存在者；都不存在但检测目录存在时安装到第一个候选。 */
    paths: string[];
    /** 客户端「已安装」的判定目录（配置文件不存在但目录存在 = 装了工具还没配过 MCP）。 */
    detectDirs: string[];
}

export type ClientStatus = {
    id: SetupClientId;
    label: string;
    detected: boolean;
    configured: boolean;
    upToDate: boolean;
    configPath: string | null;
};

export type SetupResultItem = {
    id: SetupClientId;
    label: string;
    status: "written" | "already" | "skipped" | "failed";
    reason?: string;
    configPath?: string;
    error?: string;
};

function homeOf(options: SetupOptions) {
    return path.resolve(options.homeDir || os.homedir());
}

function appDataOf(options: SetupOptions) {
    if (options.appDataDir) return path.resolve(options.appDataDir);
    if ((options.platform || process.platform) === "win32") return path.resolve(process.env.APPDATA || path.join(homeOf(options), "AppData", "Roaming"));
    return path.join(homeOf(options), ".config");
}

function configLibraryDir(options: SetupOptions) {
    return path.join(homeOf(options), "Library", "Application Support");
}

/** 各客户端配置文件候选路径（按平台）。 */
export function clientSpecs(options: SetupOptions = {}): ClientSpec[] {
    const home = homeOf(options);
    const platform = options.platform || process.platform;
    const appData = appDataOf(options);
    const macApp = configLibraryDir(options);
    const isMac = platform === "darwin";
    const desktopJsonDir = isMac ? macApp : platform === "win32" ? appData : path.join(home, ".config");
    return [
        { id: "codex", label: "Codex", kind: "toml", paths: [path.join(home, ".codex", "config.toml")], detectDirs: [path.join(home, ".codex")] },
        { id: "claude-desktop", label: "Claude Desktop", kind: "json-mcpServers", paths: [path.join(desktopJsonDir, "Claude", "claude_desktop_config.json")], detectDirs: [path.join(desktopJsonDir, "Claude")] },
        { id: "cursor", label: "Cursor", kind: "json-mcpServers", paths: [path.join(home, ".cursor", "mcp.json")], detectDirs: [path.join(home, ".cursor")] },
        { id: "vscode", label: "VS Code", kind: "json-servers", paths: [path.join(desktopJsonDir, "Code", "User", "mcp.json")], detectDirs: [path.join(desktopJsonDir, "Code", "User")] },
        { id: "workbuddy", label: "WorkBuddy", kind: "json-mcpServers", paths: [path.join(home, ".workbuddy", "mcp.json")], detectDirs: [path.join(home, ".workbuddy")] },
        {
            id: "trae",
            label: "Trae",
            kind: "json-mcpServers",
            paths: [path.join(desktopJsonDir, "Trae CN", "mcp.json"), path.join(desktopJsonDir, "Trae", "mcp.json"), path.join(home, ".trae", "mcp.json")],
            detectDirs: [path.join(desktopJsonDir, "Trae CN"), path.join(desktopJsonDir, "Trae"), path.join(home, ".trae")],
        },
    ];
}

/** 生成 MCP 服务条目；Windows 用 cmd /c npx 包装（见文件头注释 3）。 */
export function mcpServerEntry(kind: ConfigKind, platform: NodeJS.Platform = process.platform) {
    const base =
        platform === "win32"
            ? { command: "cmd", args: ["/c", "npx", "-y", MCP_PACKAGE, "mcp"] }
            : { command: "npx", args: ["-y", MCP_PACKAGE, "mcp"] };
    return kind === "json-servers" ? { type: "stdio", ...base } : base;
}

/** Codex TOML 里 infinite-canvas 一节的期望行。 */
export function codexSectionLines(platform: NodeJS.Platform = process.platform) {
    const entry = mcpServerEntry("json-mcpServers", platform);
    return [`[mcp_servers.${CANVAS_MCP_KEY}]`, `command = "${entry.command}"`, `args = [${entry.args.map((arg) => JSON.stringify(arg)).join(", ")}]`];
}

const SECTION_HEADER_RE = new RegExp(`^\\s*\\[mcp_servers\\.${CANVAS_MCP_KEY}\\]\\s*(?:#.*)?$`);
const NEXT_TABLE_RE = /^\s*\[/;

/** 在 Codex config.toml 里增改 [mcp_servers.infinite-canvas] 一节，其余内容逐字节保留。 */
export function upsertCodexMcpSection(content: string, platform: NodeJS.Platform = process.platform): { text: string; changed: boolean } {
    const body = codexSectionLines(platform);
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => SECTION_HEADER_RE.test(line));
    if (start === -1) {
        const trimmed = [...lines];
        while (trimmed.length && trimmed[trimmed.length - 1].trim() === "") trimmed.pop();
        return { text: [...trimmed, "", ...body].join("\n") + "\n", changed: true };
    }
    let end = lines.length;
    for (let index = start + 1; index < lines.length; index++) {
        if (NEXT_TABLE_RE.test(lines[index])) {
            end = index;
            break;
        }
    }
    const next = [...lines.slice(0, start), ...body, ...lines.slice(end)];
    return { text: next.join("\n"), changed: true };
}

/** 判断 TOML 中已有一节是否与期望完全一致（逐行匹配）。 */
export function codexSectionUpToDate(content: string, platform: NodeJS.Platform = process.platform) {
    const body = codexSectionLines(platform);
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex((line) => SECTION_HEADER_RE.test(line));
    if (start === -1) return false;
    for (let offset = 1; offset < body.length; offset++) {
        if ((lines[start + offset] ?? "").trim() !== body[offset]) return false;
    }
    return true;
}

function jsonContainerKey(kind: ConfigKind) {
    return kind === "json-servers" ? "servers" : "mcpServers";
}

/** 判断 JSON 配置里 infinite-canvas 条目是否已与期望一致。 */
export function jsonEntryUpToDate(root: Record<string, unknown>, kind: ConfigKind, platform: NodeJS.Platform = process.platform) {
    const container = root[jsonContainerKey(kind)];
    if (!container || typeof container !== "object" || Array.isArray(container)) return false;
    const current = (container as Record<string, unknown>)[CANVAS_MCP_KEY];
    return JSON.stringify(current ?? null) === JSON.stringify(mcpServerEntry(kind, platform));
}

async function pathExists(candidate: string) {
    try {
        await stat(candidate);
        return true;
    } catch {
        return false;
    }
}

async function backupFile(filePath: string) {
    try {
        await copyFile(filePath, filePath + BACKUP_SUFFIX);
    } catch {
        // 原文件不存在（新建配置）时无需备份
    }
}

async function firstExisting(paths: string[]) {
    for (const candidate of paths) {
        if (await pathExists(candidate)) return candidate;
    }
    return null;
}

/** 目录存在性探测：stat 成功且 isDirectory 才算「客户端已安装」。 */
async function detectClientDir(dirs: string[]) {
    for (const dir of dirs) {
        try {
            const info = await stat(dir);
            if (info.isDirectory()) return true;
        } catch {
            // 目录不存在，继续看下一个候选
        }
    }
    return false;
}

async function readJsonRoot(filePath: string): Promise<Record<string, unknown>> {
    const raw = await readFile(filePath, "utf8");
    let root: unknown;
    try {
        root = JSON.parse(raw);
    } catch {
        throw new Error(`配置文件不是有效 JSON，已中止写入且未修改原文件：${filePath}`);
    }
    if (!root || typeof root !== "object" || Array.isArray(root)) throw new Error(`配置文件顶层不是对象，已中止写入且未修改原文件：${filePath}`);
    return root as Record<string, unknown>;
}

/** 检测单个客户端（是否安装、是否已配置、配置是否已是目标内容）。 */
export async function inspectClient(spec: ClientSpec, options: SetupOptions = {}): Promise<ClientStatus> {
    const platform = options.platform || process.platform;
    const configPath = await firstExisting(spec.paths);
    const detected = Boolean(configPath) || (await detectClientDir(spec.detectDirs));
    let configured = false;
    let upToDate = false;
    if (configPath) {
        if (spec.kind === "toml") {
            const content = await readFile(configPath, "utf8");
            configured = new RegExp(`mcp_servers\\.${CANVAS_MCP_KEY}`).test(content);
            upToDate = configured && codexSectionUpToDate(content, platform);
        } else {
            try {
                const root = await readJsonRoot(configPath);
                configured = jsonEntryUpToDate(root, spec.kind, platform);
                upToDate = configured;
            } catch {
                // JSON 损坏时保持未配置状态，安装时会因同样错误失败并保护原文件
            }
        }
    }
    return { id: spec.id, label: spec.label, detected, configured, upToDate, configPath };
}

async function installClient(spec: ClientSpec, options: SetupOptions): Promise<SetupResultItem> {
    const platform = options.platform || process.platform;
    const status = await inspectClient(spec, options);
    if (!status.detected) return { id: spec.id, label: spec.label, status: "skipped", reason: "client_not_detected" };
    if (status.upToDate && status.configPath) return { id: spec.id, label: spec.label, status: "already", configPath: status.configPath };
    const target = status.configPath || spec.paths[0];
    await mkdir(path.dirname(target), { recursive: true });
    await backupFile(target);
    if (spec.kind === "toml") {
        const raw = await readFile(target, "utf8").catch(() => "");
        const { text } = upsertCodexMcpSection(raw, platform);
        await writeFile(target, text, "utf8");
    } else {
        // 已有配置文件时必须先通过 JSON 校验（损坏即中止保护原文件）；全新文件从空对象开始。
        const root: Record<string, unknown> = status.configPath ? await readJsonRoot(target) : {};
        const containerKey = jsonContainerKey(spec.kind);
        const container = root[containerKey];
        root[containerKey] = container && typeof container === "object" && !Array.isArray(container) ? container : {};
        (root[containerKey] as Record<string, unknown>)[CANVAS_MCP_KEY] = mcpServerEntry(spec.kind, platform);
        await writeFile(target, `${JSON.stringify(root, null, 2)}\n`, "utf8");
    }
    return { id: spec.id, label: spec.label, status: "written", configPath: target };
}

/** client_mcp_setup 工具入口：action=status 检测，action=install 写入。 */
export async function runClientMcpSetup(input: { action?: unknown; clients?: unknown }, options: SetupOptions = {}): Promise<Record<string, unknown>> {
    const action: SetupAction = input.action === "install" ? "install" : "status";
    const specs = clientSpecs(options);
    let requested = specs;
    if (Array.isArray(input.clients) && input.clients.length) {
        const ids = new Set(input.clients.map(String));
        requested = specs.filter((spec) => ids.has(spec.id));
        const unknown = [...ids].filter((id) => !specs.some((spec) => spec.id === id));
        if (unknown.length) throw new Error(`未知客户端：${unknown.join(", ")}`);
    }
    if (action === "status") {
        const clients = await Promise.all(requested.map((spec) => inspectClient(spec, options)));
        return { action, clients };
    }
    const results: SetupResultItem[] = [];
    for (const spec of requested) {
        try {
            results.push(await installClient(spec, options));
        } catch (error) {
            results.push({ id: spec.id, label: spec.label, status: "failed", error: error instanceof Error ? error.message : String(error) });
        }
    }
    return { action, results };
}
