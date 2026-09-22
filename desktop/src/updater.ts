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

export function createLayerUpdateMiddleware(overlayDir: string, builtinDir: string, userDataDir: string): Middleware[] {
    const state: LayerState = {
        running: false,
        mode: null,
        configured: Boolean(MANIFEST_ENV),
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
        const target = path.join(overlayDir, file.path);
        mkdirSync(path.dirname(target), { recursive: true });
        const tmp = `${target}.tmp-${process.pid}`;
        writeFileSync(tmp, content);
        renameSync(tmp, target);
    }

    async function doCheck(): Promise<void> {
        if (!MANIFEST_ENV) {
            state.error = "未配置 CANVAS_UPDATE_MANIFEST_URL";
            return;
        }
        const res = await fetch(MANIFEST_ENV);
        if (!res.ok) throw new Error(`拉取 manifest 失败：${res.status}`);
        const remote = (await res.json()) as BuildManifest;
        const baseUrl = MANIFEST_ENV.slice(0, MANIFEST_ENV.lastIndexOf("/") + 1);
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
        if (url.startsWith("/__online-update/")) {
            if (url === "/__online-update/status" && req.method === "GET") {
                return sendJson(res, 200, { ok: true, supported: false, desktop: true });
            }
            if (req.method === "POST") {
                return sendJson(res, 200, { ok: false, error: "desktop-update-handled-by-layer" });
            }
            return sendJson(res, 404, { ok: false, error: "unknown online-update endpoint" });
        }

        // /__layer-update/*
        if (url === "/__layer-update/status" && req.method === "GET") {
            const shellUpdate = readShellUpdateFlag();
            return sendJson(res, 200, {
                ok: true,
                configured: state.configured,
                shell: { version: process.env.npm_package_version || "0.1.0", update: shellUpdate },
                frontend: { builtinVersion: state.builtinVersion, overlayVersion: state.overlayVersion },
                remote: { version: state.remoteVersion, baseUrl: state.remoteBaseUrl, changed: state.changed },
                task: { running: state.running, mode: state.mode, error: state.error, finishedAt: state.finishedAt },
            });
        }
        if (url === "/__layer-update/check" && req.method === "POST") {
            void runTask("check").then((started) => sendJson(res, started ? 200 : 409, { ok: started, error: started ? undefined : "task running" }));
            return;
        }
        if (url === "/__layer-update/apply" && req.method === "POST") {
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
