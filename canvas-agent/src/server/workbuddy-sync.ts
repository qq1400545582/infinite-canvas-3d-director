import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Express, Request, Response, NextFunction } from "express";

import { logger } from "../utils/logger.js";

/**
 * WorkBuddy 内容同步（专家 / 技能 / 连接器）——「立即拉取更新」端点。
 *
 * 背景：画布专家库的目录（experts.ts / skills.ts / connectors.ts）是构建期从
 * WorkBuddy 克隆的静态快照；WorkBuddy 侧内容更新后画布感知不到。本模块提供一个
 * **只增不改**的同步端点，把三类内容的最新状态拉进画布：
 *
 *   ① 技能   —— 扫描本机 WorkBuddy 技能目录（用户级 / 插件缓存 / 内置），
 *      把新增技能克隆进画布 SkillStore（`<workspace>/.agents/skills`）。
 *      纪律：目标已存在且非本通路创建的目录**一律不覆盖**（可能含用户编辑），
 *      只登记为冲突回报；只有带来源标记（.workbuddy-synced.json）的目录
 *      才允许在源内容变化时被整体更新。
 *   ② 专家   —— 拉取 WorkBuddy 专家市场目录（COS，公开读 + CORS 全开），
 *      与上次同步状态按 updatedAt 比对，新增/更新的专家提示词包体落盘
 *      `<workspace>/experts/<id>.md`（与既有 379 个包体同一目录同一形态）。
 *      首次接管：构建期已克隆、但状态文件里没记录的包体视为已就绪（不重下）。
 *   ③ 连接器 —— 读取本机 WorkBuddy 连接器市场缓存
 *     （`~/.workbuddy/connectors-marketplace/.codebuddy-connector/connectors.json`），
 *      按内容哈希比对后把新增/变更条目回传给前端做目录合并（纯目录，不落文件）。
 *
 * 同步状态持久化在 `<workspace>/.workbuddy-sync.json`，保证重复点击是增量且幂等的。
 */

/** WorkBuddy 专家市场（公开对象存储，CORS 全开）。 */
export const EXPERT_MARKET_BASE = "https://acc-1258344699.cos.accelerate.myqcloud.com/workbuddy/expert-marketplace";

/** 技能目录克隆时的剪枝与限额（与 clone-wb-skills 纪律一致）。 */
const PRUNE_DIRS = new Set(["venv", ".venv", "node_modules", ".git", "__pycache__", ".pytest_cache", ".idea", ".vscode", ".workbuddy-test", ".ruff_cache", ".mypy_cache"]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** 同步状态文件与技能来源标记文件名。 */
const STATE_FILE = ".workbuddy-sync.json";
const SOURCE_MARKER = ".workbuddy-synced.json";
const EXPERT_BODY_CONCURRENCY = 4;

export type WorkbuddySyncDeps = {
    /** 站点工作空间根目录（experts/ 与 .agents/skills/ 的父目录）。 */
    workspacePath: () => string;
    /** 向全部网页广播（技能变化后让前端刷新技能清单）。 */
    emitAll: (type: string, payload: unknown) => void;
};

type SyncState = {
    experts?: { lastUpdated?: string; bodies?: Record<string, string> };
    connectors?: Record<string, string>;
};

export type CatalogChange = {
    id: string;
    name: string;
    profession: string;
    description: string;
    categoryId: string;
    expertType: string;
    promptFile: string;
    updatedAt: string;
    hasBody: boolean;
    /** 仅连接器条目使用：从市场缓存 mcp.json 还原的真实接入方式（形如 `http https://…` / `stdio npx …`）。 */
    access: string;
    /** 头像绝对地址（专家市场 COS），用于卡片展示；缺省时前端用名称首字占位。 */
    avatar?: string;
    /** 出品方 / 作者（WorkBuddy author）。 */
    author?: string;
    /** 运营徽标（WorkBuddy operationalTag，如「特邀专家」）。 */
    badge?: string;
    /** WorkBuddy 原始标签（卡片取前 3 个）。 */
    tags?: string[];
};

export type WorkbuddySyncResult = {
    skills: { added: Array<{ name: string; description: string }>; unchanged: number; conflicts: Array<{ name: string; reason: string }>; failed: Array<{ source: string; error: string }> };
    experts: { lastUpdated: string; total: number; added: CatalogChange[]; updated: CatalogChange[]; removed: string[]; adopted: number; unchanged: number; bodiesFailed: Array<{ id: string; error: string }> };
    connectors: { total: number; added: CatalogChange[]; updated: CatalogChange[]; removed: string[]; unchanged: number; source: string };
    at: string;
};

/* ------------------------------------------------------------------ *
 * 路由注册（只增不改：仅新增一个端点，不触碰既有路由）
 * ------------------------------------------------------------------ */

let syncBusy = false;

export function registerWorkbuddySync(app: Express, deps: WorkbuddySyncDeps) {
    app.post("/agent/codex/workbuddy-sync", async (req: Request, res: Response, next: NextFunction) => {
        if (syncBusy) return res.status(409).json({ ok: false, code: "SYNC_BUSY", error: "上一次拉取尚未完成，请稍后重试" });
        syncBusy = true;
        try {
            const parts = (req.body?.parts && typeof req.body.parts === "object" ? req.body.parts : {}) as Record<string, unknown>;
            const want = (key: string) => parts[key] !== false;
            const workspacePath = deps.workspacePath();
            const state = await readSyncState(workspacePath);
            const result: WorkbuddySyncResult = {
                skills: { added: [], unchanged: 0, conflicts: [], failed: [] },
                experts: { lastUpdated: "", total: 0, added: [], updated: [], removed: [], adopted: 0, unchanged: 0, bodiesFailed: [] },
                connectors: { total: 0, added: [], updated: [], removed: [], unchanged: 0, source: "" },
                at: new Date().toISOString(),
            };
            const nextBodies: Record<string, string> = { ...(state.experts?.bodies ?? {}) };
            const nextConnectorHashes: Record<string, string> = { ...(state.connectors ?? {}) };
            if (want("skills")) result.skills = await syncSkills(workspacePath);
            if (want("experts")) {
                result.experts = await syncExperts(workspacePath, state.experts ?? {}, nextBodies);
            }
            if (want("connectors")) {
                result.connectors = await syncConnectors(state.connectors ?? {}, nextConnectorHashes);
            }
            if (result.skills.added.length) deps.emitAll("skills_changed", { forceReload: true });
            await writeSyncState(workspacePath, {
                experts: { lastUpdated: result.experts.lastUpdated, bodies: nextBodies },
                connectors: nextConnectorHashes,
            });
            logger.info("workbuddy-sync done", {
                skillsAdded: result.skills.added.length,
                skillsConflicts: result.skills.conflicts.length,
                expertsAdded: result.experts.added.length,
                expertsUpdated: result.experts.updated.length,
                connectorsAdded: result.connectors.added.length,
                connectorsUpdated: result.connectors.updated.length,
            });
            res.json({ ok: true, data: result });
        } catch (error) {
            next(error);
        } finally {
            syncBusy = false;
        }
    });
}

/* ------------------------------------------------------------------ *
 * ① 技能：本机 WorkBuddy → 画布 SkillStore
 * ------------------------------------------------------------------ */

/** 本机 WorkBuddy 技能的可能位置（存在才参与扫描；WORKBUDDY_HOME / WORKBUDDY_RESOURCES 可覆盖，供测试与自定义安装位使用）。 */
export function workbuddySkillSources(): Array<{ label: string; root: string; depth: number }> {
    const workbuddyHome = process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
    const sources = [
        { label: "user", root: path.join(workbuddyHome, "skills"), depth: 1 },
        { label: "cache", root: path.join(workbuddyHome, "plugins", "cache"), depth: 7 },
    ];
    const builtinCandidates = process.env.WORKBUDDY_RESOURCES
        ? [process.env.WORKBUDDY_RESOURCES]
        : [
              "F:/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills",
              "C:/Program Files/WorkBuddy/resources/app.asar.unpacked/resources/plugins/workbuddy-builtin/skills",
          ];
    for (const candidate of builtinCandidates) sources.push({ label: "builtin", root: candidate, depth: 1 });
    return sources;
}

async function syncSkills(workspacePath: string): Promise<WorkbuddySyncResult["skills"]> {
    const result: WorkbuddySyncResult["skills"] = { added: [], unchanged: 0, conflicts: [], failed: [] };
    const skillsRoot = path.join(workspacePath, ".agents", "skills");
    await fs.mkdir(skillsRoot, { recursive: true });
    const seen = new Set<string>();
    for (const source of workbuddySkillSources()) {
        for (const dir of await findSkillDirs(source.root, source.depth)) {
            try {
                const parsed = parseFrontmatter(await fs.readFile(path.join(dir, "SKILL.md"), "utf8"));
                const name = parsed.name;
                if (!name || !SKILL_NAME_PATTERN.test(name) || name.length > 64) {
                    result.failed.push({ source: dir, error: "SKILL.md 的 name 不合法" });
                    continue;
                }
                if (seen.has(name)) continue; // 多来源同名：先到先得（user > cache > builtin 的扫描顺序）
                seen.add(name);
                const dest = path.join(skillsRoot, name);
                const sourceHash = await treeHash(dir);
                const existing = await lstatOptional(dest);
                if (!existing) {
                    await copyPruned(dir, dest);
                    await writeSourceMarker(dest, sourceHash);
                    result.added.push({ name, description: parsed.description });
                    continue;
                }
                const marker = await readSourceMarker(dest);
                if (!marker) {
                    result.conflicts.push({ name, reason: "本机已存在同名技能且非本同步通路创建，未覆盖" });
                    continue;
                }
                if (marker.sourceHash === sourceHash) {
                    result.unchanged += 1;
                    continue;
                }
                await fs.rm(dest, { recursive: true, force: true });
                await copyPruned(dir, dest);
                await writeSourceMarker(dest, sourceHash);
                result.added.push({ name, description: parsed.description }); // 更新对前端而言与新增同形（刷新安装记录）
            } catch (error) {
                result.failed.push({ source: dir, error: error instanceof Error ? error.message : String(error) });
            }
        }
    }
    return result;
}

async function findSkillDirs(root: string, maxDepth: number): Promise<string[]> {
    const found: string[] = [];
    const walk = async (dir: string, depth: number): Promise<void> => {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (await exists(path.join(full, "SKILL.md"))) {
                found.push(full);
                continue;
            }
            if (depth < maxDepth) await walk(full, depth + 1);
        }
    };
    await walk(root, 1);
    return found;
}

/** 解析 SKILL.md 极简 frontmatter（name / description 两个标量）。 */
export function parseFrontmatter(raw: string): { name: string; description: string } {
    const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) return { name: "", description: "" };
    const end = normalized.indexOf("\n---", 3);
    if (end === -1) return { name: "", description: "" };
    const head = normalized.slice(4, end);
    const pick = (key: string) => {
        const match = new RegExp(`^${key}:\\s*["']?([^"'\\n\\r]+)["']?\\s*$`, "m").exec(head);
        return match ? match[1].trim() : "";
    };
    return { name: pick("name"), description: pick("description") };
}

async function copyPruned(src: string, dest: string): Promise<void> {
    await fs.mkdir(dest, { recursive: true });
    for (const entry of await fs.readdir(src, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) continue;
        const from = path.join(src, entry.name);
        const to = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            if (PRUNE_DIRS.has(entry.name)) continue;
            await copyPruned(from, to);
            continue;
        }
        if (!entry.isFile()) continue;
        const stat = await fs.stat(from);
        if (stat.size > MAX_FILE_BYTES) continue;
        await fs.copyFile(from, to);
    }
}

async function treeHash(root: string): Promise<string> {
    const hash = crypto.createHash("sha256");
    const files = await listFiles(root);
    for (const file of files.sort()) {
        hash.update(path.relative(root, file).replace(/\\/g, "/"));
        hash.update("\0");
        hash.update(await fs.readFile(file));
        hash.update("\0");
    }
    return hash.digest("hex");
}

async function listFiles(root: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (dir: string): Promise<void> => {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) out.push(full);
        }
    };
    await walk(root);
    return out;
}

async function writeSourceMarker(skillDir: string, sourceHash: string) {
    await fs.writeFile(path.join(skillDir, SOURCE_MARKER), JSON.stringify({ source: "workbuddy-sync", sourceHash, at: new Date().toISOString() }, null, 2), "utf8");
}

async function readSourceMarker(skillDir: string): Promise<{ sourceHash: string } | null> {
    try {
        const parsed = JSON.parse(await fs.readFile(path.join(skillDir, SOURCE_MARKER), "utf8")) as { sourceHash?: string };
        return typeof parsed.sourceHash === "string" ? { sourceHash: parsed.sourceHash } : null;
    } catch {
        return null;
    }
}

/* ------------------------------------------------------------------ *
 * ② 专家：COS 市场目录 → workspace experts/ 包体
 * ------------------------------------------------------------------ */

async function syncExperts(workspacePath: string, prevState: NonNullable<SyncState["experts"]>, nextBodies: Record<string, string>): Promise<WorkbuddySyncResult["experts"]> {
    const result: WorkbuddySyncResult["experts"] = { lastUpdated: "", total: 0, added: [], updated: [], removed: [], adopted: 0, unchanged: 0, bodiesFailed: [] };
    const catalog = await fetchJson(`${EXPERT_MARKET_BASE}/expert_center.json`);
    const items = extractItems(catalog);
    result.total = items.length;
    result.lastUpdated = typeof (catalog as { lastUpdated?: unknown }).lastUpdated === "string" ? String((catalog as { lastUpdated?: string }).lastUpdated) : "";
    const expertsDir = path.join(workspacePath, "experts");
    await fs.mkdir(expertsDir, { recursive: true });
    const prevBodies = prevState.bodies ?? {};
    const seen = new Set<string>();
    // 包体下载并发 4（首启可能有几十个缺口；开满容易被对象存储限流）。
    const queue = items.slice();
    const worker = async (): Promise<void> => {
        for (;;) {
            const item = queue.shift();
            if (!item) return;
            const id = String(item.id || "");
            if (!id || seen.has(id)) continue;
            seen.add(id);
            const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : "";
            const prevUpdatedAt = prevBodies[id] ?? "";
            const bodyFile = path.join(expertsDir, `${sanitizeId(id)}.md`);
            const hasBody = await exists(bodyFile);
            if (prevUpdatedAt && prevUpdatedAt === updatedAt && hasBody) {
                nextBodies[id] = updatedAt;
                result.unchanged += 1;
                continue;
            }
            if (!prevUpdatedAt && hasBody) {
                // 首次接管：包体是构建期克隆的，内容视为已就绪，只补记状态不重下。
                nextBodies[id] = updatedAt;
                result.adopted += 1;
                continue;
            }
            const promptFile = typeof item.promptFile === "string" ? item.promptFile : "";
            let fetched = false;
            if (promptFile) {
                try {
                    const body = await fetchText(`${EXPERT_MARKET_BASE}${promptFile}`);
                    if (!body.trim()) throw new Error("包体为空");
                    await fs.writeFile(bodyFile, body, "utf8");
                    fetched = true;
                } catch (error) {
                    result.bodiesFailed.push({ id, error: error instanceof Error ? error.message : String(error) });
                }
            }
            if (!fetched && !hasBody) continue; // 新专家且包体拉失败 → 不进 added（避免出现调不动的条目）
            nextBodies[id] = updatedAt;
            const change = catalogChange(item, hasBody || fetched);
            if (prevUpdatedAt) result.updated.push(change);
            else result.added.push(change);
        }
    };
    await Promise.all(Array.from({ length: EXPERT_BODY_CONCURRENCY }, worker));
    // 目录里已消失的 id：从状态剔除并回报（包体文件保留，不删用户数据）。
    for (const id of Object.keys(prevBodies)) if (!seen.has(id)) result.removed.push(id);
    return result;
}

function catalogChange(item: Record<string, unknown>, hasBody: boolean, access = ""): CatalogChange {
    const avatar = typeof item.avatar === "string" ? item.avatar.trim() : "";
    const tags = Array.isArray(item.tags) ? item.tags.map((tag) => localized(tag)).filter(Boolean).slice(0, 4) : [];
    return {
        id: typeof item.id === "string" ? item.id : "",
        name: localized(item.displayName) || localized(item.name) || (typeof item.id === "string" ? item.id : ""),
        profession: localized(item.profession),
        description: localized(item.description) || localized(item.description_zh) || localized(item.description_en),
        categoryId: typeof item.categoryId === "string" ? item.categoryId : "",
        expertType: typeof item.expertType === "string" ? item.expertType : typeof item.type === "string" ? item.type : "",
        promptFile: typeof item.promptFile === "string" ? item.promptFile : "",
        updatedAt: typeof item.updatedAt === "string" ? item.updatedAt : "",
        hasBody,
        access,
        // 卡片展示字段（与 WorkBuddy 专家中心一致）：头像解析成绝对地址，徽标取运营标原文。
        avatar: avatar ? (/^https?:\/\//i.test(avatar) ? avatar : EXPERT_MARKET_BASE + avatar) : "",
        author: localized(item.author),
        badge: localized(item.operationalTag).trim(),
        tags,
    };
}

function localized(value: unknown): string {
    if (typeof value === "string") return value;
    if (isRecord(value)) {
        for (const key of ["zh", "en"]) {
            if (typeof value[key] === "string" && value[key]) return String(value[key]);
        }
    }
    return "";
}

function sanitizeId(id: string) {
    return id.replace(/[^\w.-]/g, "_");
}

function extractItems(catalog: unknown): Array<Record<string, unknown>> {
    if (Array.isArray(catalog)) return catalog.filter(isRecord);
    if (isRecord(catalog)) {
        for (const key of ["experts", "items", "catalog", "connectors"]) {
            if (Array.isArray(catalog[key])) return (catalog[key] as unknown[]).filter(isRecord);
        }
    }
    return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

/* ------------------------------------------------------------------ *
 * ③ 连接器：本机 WorkBuddy 市场缓存 → 目录 diff
 * ------------------------------------------------------------------ */

export function connectorMarketSources(): string[] {
    const workbuddyHome = process.env.WORKBUDDY_HOME || path.join(os.homedir(), ".workbuddy");
    return [
        path.join(workbuddyHome, "connectors-marketplace", ".codebuddy-connector", "connectors.json"),
        path.join(workbuddyHome, "connectors", "marketplace-meta", "workbuddy-connector-plugins-official.json"),
    ];
}

async function syncConnectors(prevState: Record<string, string>, nextHashes: Record<string, string>): Promise<WorkbuddySyncResult["connectors"]> {
    const result: WorkbuddySyncResult["connectors"] = { total: 0, added: [], updated: [], removed: [], unchanged: 0, source: "" };
    for (const source of connectorMarketSources()) {
        const raw = await readFileOptional(source);
        if (!raw) continue;
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            continue;
        }
        const items = extractItems(parsed).filter((item) => typeof item.id === "string" && item.id);
        if (!items.length) continue;
        result.source = source;
        result.total = items.length;
        // 每个连接器的真实接入参数在同级 connectors/<id>/mcp.json（与 connectoers.json 同一缓存根）。
        const packagesRoot = path.join(path.dirname(path.dirname(source)), "connectors");
        const ids = new Set<string>();
        for (const item of items) {
            const id = String(item.id);
            ids.add(id);
            const access = await connectorAccess(path.join(packagesRoot, sanitizeId(id)));
            const hash = contentHash(JSON.stringify([item.name, item.name_en, item.description, item.description_zh, item.source, item.type, access]));
            nextHashes[id] = hash;
            const prev = prevState[id];
            const change = catalogChange(item, false, access);
            if (!prev) result.added.push(change);
            else if (prev !== hash) result.updated.push(change);
            else result.unchanged += 1;
        }
        for (const id of Object.keys(prevState)) if (!ids.has(id)) result.removed.push(id);
        break; // 第一个可用的来源生效
    }
    return result;
}

/** 从连接器包目录还原接入方式（首个 mcpServer；streamable-http 归一为 http）。 */
async function connectorAccess(packageDir: string): Promise<string> {
    const raw = await readFileOptional(path.join(packageDir, "mcp.json"));
    if (!raw) return "";
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return "";
    }
    const servers = isRecord(parsed) && isRecord(parsed.mcpServers) ? parsed.mcpServers : {};
    const first = Object.values(servers)[0];
    if (!isRecord(first)) return "";
    const type = typeof first.type === "string" && first.type ? (first.type === "streamable-http" ? "http" : first.type) : "stdio";
    const endpoint = typeof first.url === "string" && first.url ? first.url : typeof first.command === "string" && first.command ? [first.command, ...(Array.isArray(first.args) ? first.args.map(String) : [])].join(" ") : "";
    return endpoint ? `${type} ${endpoint}` : type;
}

function contentHash(text: string) {
    return crypto.createHash("sha256").update(text).digest("hex");
}

/* ------------------------------------------------------------------ *
 * 状态与小工具
 * ------------------------------------------------------------------ */

export async function readSyncState(workspacePath: string): Promise<SyncState> {
    try {
        const parsed = JSON.parse(await fs.readFile(path.join(workspacePath, STATE_FILE), "utf8"));
        return isRecord(parsed) ? (parsed as SyncState) : {};
    } catch {
        return {};
    }
}

export async function writeSyncState(workspacePath: string, state: SyncState): Promise<void> {
    try {
        await fs.writeFile(path.join(workspacePath, STATE_FILE), JSON.stringify(state, null, 2), "utf8");
    } catch (error) {
        logger.warn("workbuddy-sync state write failed", { error: error instanceof Error ? error.message : String(error) });
    }
}

async function fetchJson(url: string): Promise<unknown> {
    return JSON.parse(await fetchText(url));
}

async function fetchText(url: string): Promise<string> {
    const response = await fetch(url, { signal: AbortSignal.timeout(40_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
}

async function readFileOptional(filePath: string): Promise<string | null> {
    try {
        return await fs.readFile(filePath, "utf8");
    } catch {
        return null;
    }
}

async function exists(filePath: string): Promise<boolean> {
    try {
        await fs.stat(filePath);
        return true;
    } catch {
        return false;
    }
}

async function lstatOptional(filePath: string) {
    try {
        return await fs.lstat(filePath);
    } catch {
        return undefined;
    }
}
