import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Middleware } from "./server";
import { readShellUpdateFlag, quitAndInstallShellUpdate } from "./auto-update";

/**
 * 三层更新契约 · 桌面端侧（P3）
 *
 * 层级：
 *   ① 插件 bundle —— 同源 /plugins/*.js，刷新即最新（与网页版一致）。
 *   ② 前端 bundle —— 拉取远程 build-manifest.json，对变更文件做 sha256 增量覆盖到
 *      userData/frontend-overlay/，下次启动生效（离线回退内置 dist）。
 *   ③ 桌面壳 —— 由 electron-updater 从 GitHub Release / R2 更新（见 auto-updater 段）。
 *
 * 本模块只负责 ②：实现 /__layer-update/* 与 /__online-update/*（兼容现有面板）的同源 HTTP 接口。
 * 远程 manifest 地址由环境变量 CANVAS_UPDATE_MANIFEST_URL 指定（例如你的 CF Pages 站 build-manifest.json）。
 */

/** 环境变量兜底（优先级最高）。常规用法是在界面「更新源」里填一次，落盘到 userData/update-config.json。 */
const MANIFEST_ENV = process.env.CANVAS_UPDATE_MANIFEST_URL || "";
const OPENREEL_SW_CACHE_PREFIX = "openreel-v2";

type ManifestFile = { path: string; hash: string; size: number };
type BuildManifest = { version: string; generatedAt?: string; files: ManifestFile[] };

type LayerState = {
    running: boolean;
    mode: "check" | "apply" | null;
    configured: boolean;
    builtinVersion: string | null;
    overlayVersion: string | null;
    remoteVersion: string | null;
    remoteBaseUrl: string | null;
    changed: number;
    error: string | null;
    finishedAt: number;
};

function readLocalManifest(dir: string): BuildManifest | null {
    try {
        const raw = readFileSync(path.join(dir, "build-manifest.json"), "utf8");
        const m = JSON.parse(raw) as BuildManifest;
        if (m && Array.isArray(m.files)) return m;
    } catch {
        /* 无 manifest（例如内置 dist 未产出） */
    }
    return null;
}

function loadOverlayManifest(overlayDir: string): BuildManifest | null {
    return readLocalManifest(overlayDir);
}

function sha256File(filePath: string): string | null {
    try {
        const buf = readFileSync(filePath);
        return createHash("sha256").update(buf).digest("hex");
    } catch {
        return null;
    }
}

/** 计算 overlay（优先）相对 remote 的待下载差异。 */
function computeDiff(remote: BuildManifest, currentDir: string): ManifestFile[] {
    return remote.files.filter((f) => {
        const localPath = path.join(currentDir, f.path);
        if (!existsSync(localPath)) return true;
        const hash = sha256File(localPath);
        return hash !== f.hash;
    });
}

function recursiveList(dir: string, base = dir): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) out.push(...recursiveList(full, base));
        else out.push(path.relative(base, full).split(path.sep).join("/"));
    }
    return out;
}

export function createLayerUpdateMiddleware(overlayDir: string, builtinDir: string, userDataDir: string, shellVersion = "0.1.0"): Middleware[] {
    const configFile = path.join(userDataDir, "update-config.json");

    /** 读取用户配置的更新源（env 优先，其次配置文件）。 */
    function readManifestUrl(): string {
        if (MANIFEST_ENV) return MANIFEST_ENV;
        try {
            const raw = JSON.parse(readFileSync(configFile, "utf8")) as { manifestUrl?: string };
            return typeof raw.manifestUrl === "string" ? raw.manifestUrl.trim() : "";
        } catch {
            return "";
        }
    }

    function writeManifestUrl(url: string): void {
        mkdirSync(path.dirname(configFile), { recursive: true });
        writeFileSync(configFile, JSON.stringify({ manifestUrl: url, updatedAt: new Date().toISOString() }, null, 2));
    }

    const state: LayerState = {
        running: false,
        mode: null,
        configured: Boolean(readManifestUrl()),
        builtinVersion: readLocalManifest(builtinDir)?.version ?? null,
        overlayVersion: loadOverlayManifest(overlayDir)?.version ?? null,
        remoteVersion: null,
        remoteBaseUrl: null,
        changed: 0,
        error: null,
        finishedAt: 0,
    };

    let pendingDiff: ManifestFile[] = [];
    let pendingRemote: BuildManifest | null = null;

    const sendJson = (res: Parameters<Middleware>[1], status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(JSON.stringify(body));
    };

    /** 读取请求体（限 64KB，避免异常请求把内存撑爆）。 */
    function readJsonBody(req: Parameters<Middleware>[0]): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            let size = 0;
            const chunks: Buffer[] = [];
            req.on("data", (chunk: Buffer) => {
                size += chunk.length;
                if (size > 64 * 1024) {
                    reject(new Error("请求体过大"));
                    req.destroy();
                    return;
                }
                chunks.push(chunk);
            });
            req.on("end", () => {
                try {
                    const text = Buffer.concat(chunks).toString("utf8").trim();
                    resolve(text ? (JSON.parse(text) as Record<string, unknown>) : {});
                } catch (error) {
                    reject(error as Error);
                }
            });
            req.on("error", reject);
        });
    }

    /** 原子写入：先写到 .tmp，校验 sha256 后再 rename，避免半截文件。 */
    async function downloadAndPlace(baseUrl: string, file: ManifestFile): Promise<void> {
        const res = await fetch(baseUrl + file.path);
        if (!res.ok) throw new Error(`下载失败 ${file.path}: ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (createHash("sha256").update(buf).digest("hex") !== file.hash) {
            throw new Error(`sha256 校验失败：${file.path}`);
        }
        let content = buf;
        // openreel 的 SW 是 cache-first 且 CACHE_NAME 固定，覆盖 /openreel-video/* 后必须 bump 缓存名，否则仍命中旧缓存。
        if (file.path.endsWith("/openreel-video/sw.js") || file.path === "openreel-video/sw.js") {
            const text = buf.toString("utf8").replace(new RegExp(OPENREEL_SW_CACHE_PREFIX, "g"), `${OPENREEL_SW_CACHE_PREFIX}-overlay-${pendingRemote?.version ?? "v"}`);
            content = Buffer.from(text, "utf8");
        }
        // 防御：远程 manifest 的 path 是不可信输入，必须拦住 ../ 之类的路径穿越，
        // 否则一个配错（或恶意）的 manifest 就能往 overlayDir 之外写文件。
        const target = path.resolve(overlayDir, file.path);
        const overlayResolved = path.resolve(overlayDir);
        if (target !== overlayResolved && !target.startsWith(overlayResolved + path.sep)) {
            throw new Error(`manifest 路径非法：${file.path}`);
        }
        mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}`;
        writeFileSync(tmp, content);
        renameSync(tmp, target);
    }

    async function doCheck(): Promise<void> {
        const manifestUrl = readManifestUrl();
        if (!manifestUrl) {
            state.error = "未配置更新源";
            state.changed = 0;
            return;
        }
        const res = await fetch(manifestUrl);
        if (!res.ok) throw new Error(`拉取 manifest 失败：${res.status}`);
        const remote = (await res.json()) as BuildManifest;
        if (!remote || !Array.isArray(remote.files)) throw new Error("manifest 格式不正确（缺少 files 数组）");
        // 远程 manifest 是**不可信输入**：先在解析阶段就把非法 path 拦掉（fail fast，避免先下载再拒绝），
        // 否则一个配错或恶意的 manifest 就能往 overlayDir 之外写文件。
        const overlayResolved = path.resolve(overlayDir);
        for (const file of remote.files) {
            if (!file || typeof file.path !== "string" || !file.path.trim()) {
                throw new Error("manifest 含非法条目（path 缺失）");
            }
            const resolved = path.resolve(overlayResolved, file.path);
            if (resolved !== overlayResolved && !resolved.startsWith(overlayResolved + path.sep)) {
                throw new Error(`manifest 路径非法：${file.path}`);
            }
        }
        const baseUrl = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
        pendingRemote = remote;
        state.remoteBaseUrl = baseUrl;
        state.remoteVersion = remote.version;
        // 以 overlay 优先、回退 builtin 的「当前生效」目录做差异
        const currentDir = loadOverlayManifest(overlayDir) ? overlayDir : builtinDir;
        pendingDiff = computeDiff(remote, currentDir);
        state.changed = pendingDiff.length;
    }

    async function doApply(): Promise<void> {
        await doCheck();
        if (pendingDiff.length === 0) {
            state.changed = 0;
            return;
        }
        if (!state.remoteBaseUrl || !pendingRemote) throw new Error("请先执行 check");
        // 先备份当前 overlay（若有），便于回滚
        if (existsSync(overlayDir) && recursiveList(overlayDir).length > 0) {
            const backup = `${overlayDir}.bak-${Date.now()}`;
            mkdirSync(backup, { recursive: true });
            for (const rel of recursiveList(overlayDir)) {
                const from = path.join(overlayDir, rel);
                const to = path.join(backup, rel);
                mkdirSync(path.dirname(to), { recursive: true });
                writeFileSync(to, readFileSync(from));
            }
        }
        for (const file of pendingDiff) {
            await downloadAndPlace(state.remoteBaseUrl!, file);
        }
        // 写入 overlay 的 manifest（标记新前端版本）
        writeFileSync(path.join(overlayDir, "build-manifest.json"), JSON.stringify({ ...pendingRemote, appliedAt: new Date().toISOString() }, null, 2));
        state.overlayVersion = pendingRemote!.version;
        // 清理过期备份（保留最近 2 个）
        cleanupBackups(overlayDir);
        state.changed = 0;
    }

    function cleanupBackups(dir: string) {
        try {
            const parent = path.dirname(dir);
            const name = path.basename(dir);
            const backs = readdirSync(parent)
                .filter((e) => e.startsWith(`${name}.bak-`))
                .sort()
                .reverse();
            for (const b of backs.slice(2)) rmSync(path.join(parent, b), { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }

    async function runTask(mode: "check" | "apply") {
        if (state.running) return false;
        state.running = true;
        state.mode = mode;
        state.error = null;
        state.finishedAt = 0;
        try {
            if (mode === "check") await doCheck();
            else await doApply();
        } catch (error) {
            state.error = (error as Error).message;
        } finally {
            state.running = false;
            state.mode = null;
            state.finishedAt = Date.now();
        }
        return true;
    }

    const handler: Middleware = (req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (!url.startsWith("/__layer-update/") && !url.startsWith("/__online-update/")) return next();

        // /__online-update/* 兼容现有面板：桌面端返回 supported:false + desktop:true，
        // 现有面板据此展示「桌面端请用版本面板的三层更新」（见 web 端 guarded 分支）。
        // ⚠️ 必须同时带上 localVersion/baseVersion/protectedPaths/task 这些**非可选**字段的占位：
        // 老前端（已发布/已安装的构建）会直接读 status.task.running，缺字段会抛
        // "Cannot read properties of undefined (reading 'running')" 连带整个应用崩掉。这里是纵深防御。
        if (url.startsWith("/__online-update/")) {
            if (url === "/__online-update/status" && req.method === "GET") {
                return sendJson(res, 200, {
                    ok: true,
                    supported: false,
                    desktop: true,
                    localVersion: state.overlayVersion || state.builtinVersion,
                    baseVersion: null,
                    protectedPaths: [],
                    task: { running: false, mode: null, finishedAt: 0, error: null, result: null, lines: [] },
                });
            }
            if (req.method === "POST") {
                return sendJson(res, 200, { ok: false, error: "desktop-update-handled-by-layer" });
            }
            return sendJson(res, 404, { ok: false, error: "unknown online-update endpoint" });
        }

        // /__layer-update/*
        if (url === "/__layer-update/status" && req.method === "GET") {
            const shellUpdate = readShellUpdateFlag();
            const manifestUrl = readManifestUrl();
            return sendJson(res, 200, {
                ok: true,
                configured: Boolean(manifestUrl),
                manifestUrl,
                manifestFromEnv: Boolean(MANIFEST_ENV),
                shell: { version: shellVersion, update: shellUpdate },
                frontend: { builtinVersion: state.builtinVersion, overlayVersion: state.overlayVersion },
                remote: { version: state.remoteVersion, baseUrl: state.remoteBaseUrl, changed: state.changed },
                task: { running: state.running, mode: state.mode, error: state.error, finishedAt: state.finishedAt },
            });
        }
        // 更新源配置：GET 读、POST 写（写空字符串 = 清除）。落盘 userData/update-config.json。
        if (url === "/__layer-update/config" && req.method === "GET") {
            return sendJson(res, 200, { ok: true, manifestUrl: readManifestUrl(), fromEnv: Boolean(MANIFEST_ENV) });
        }
        if (url === "/__layer-update/config" && req.method === "POST") {
            if (MANIFEST_ENV) return sendJson(res, 409, { ok: false, error: "更新源由环境变量 CANVAS_UPDATE_MANIFEST_URL 指定，请改环境变量" });
            void readJsonBody(req)
                .then((body) => {
                    const raw = typeof body.manifestUrl === "string" ? body.manifestUrl.trim() : "";
                    if (raw && !/^https?:\/\//i.test(raw)) {
                        return sendJson(res, 400, { ok: false, error: "invalid-url" });
                    }
                    writeManifestUrl(raw);
                    // 换源后之前的远端信息与差异全部作废
                    state.configured = Boolean(raw);
                    state.remoteVersion = null;
                    state.remoteBaseUrl = null;
                    state.changed = 0;
                    state.error = null;
                    pendingDiff = [];
                    pendingRemote = null;
                    return sendJson(res, 200, { ok: true, manifestUrl: raw, configured: Boolean(raw) });
                })
                .catch((error: Error) => sendJson(res, 400, { ok: false, error: error.message }));
            return;
        }
        if (url === "/__layer-update/check" && req.method === "POST") {
            if (!readManifestUrl()) {
                return sendJson(res, 400, { ok: false, error: "not-configured" });
            }
            void runTask("check").then((started) => sendJson(res, started ? 200 : 409, { ok: started, error: started ? undefined : "task running" }));
            return;
        }
        if (url === "/__layer-update/apply" && req.method === "POST") {
            if (!readManifestUrl()) {
                return sendJson(res, 400, { ok: false, error: "not-configured" });
            }
            void runTask("apply").then((started) => sendJson(res, started ? 200 : 409, { ok: started, error: started ? undefined : "task running" }));
            return;
        }
        if (url === "/__layer-update/install-shell" && req.method === "POST") {
            try {
                quitAndInstallShellUpdate();
                return sendJson(res, 200, { ok: true });
            } catch (error) {
                return sendJson(res, 500, { ok: false, error: (error as Error).message });
            }
        }
        return sendJson(res, 404, { ok: false, error: "unknown layer-update endpoint" });
    };

    return [handler];
}
