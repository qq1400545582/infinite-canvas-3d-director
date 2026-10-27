import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { app } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * 桌面壳自动更新（三层更新的第 ③ 层）：由 electron-updater 从 GitHub Release 拉取新壳。
 * 仅打包后生效（dev 不检查）。发现可用更新写入 userData/shell-update.json，
 * 供 /__layer-update/status 汇总展示；下载完成后提示用户重启生效。
 *
 * ⚠️ autoDownload = false（安装包约 100MB，不能在用户不知情时下载），因此必须由面板上的
 * 「下载桌面壳更新」按钮触发 downloadShellUpdate()。
 * 历史坑：早前只做了「检查」和「已下载才显示重启按钮」，没有下载入口，面板就永远停在
 * available=true / downloaded=false —— 只有一行黄字、没有任何可点的按钮，用户完全没法更新。
 */

export type ShellUpdateFlag = {
    available: boolean;
    downloaded: boolean;
    version: string | null;
    /** 正在下载。前端据此轮询进度并禁用重复点击。 */
    downloading?: boolean;
    /** 下载进度 0-100。 */
    percent?: number;
    /** 最近一次下载失败的原因，重新下载时清空。 */
    error?: string | null;
};

const EMPTY_FLAG: ShellUpdateFlag = { available: false, downloaded: false, version: null, downloading: false, percent: 0, error: null };

/** 进程内状态：写文件时以它为基线做合并（避免局部 patch 把其它字段冲掉）。 */
let current: ShellUpdateFlag | null = null;
let downloading = false;
let lastProgressWrite = 0;

function flagFilePath(): string {
    return path.join(app.getPath("userData"), "shell-update.json");
}

/** 读取落盘的壳更新状态；文件缺失/损坏一律返回 null（调用方按「无更新」处理）。 */
export function readShellUpdateFlag(): ShellUpdateFlag | null {
    try {
        const file = flagFilePath();
        if (!existsSync(file)) return null;
        const raw = JSON.parse(readFileSync(file, "utf8")) as Partial<ShellUpdateFlag>;
        return {
            available: Boolean(raw.available),
            downloaded: Boolean(raw.downloaded),
            version: typeof raw.version === "string" ? raw.version : null,
            downloading: Boolean(raw.downloading),
            percent: typeof raw.percent === "number" ? raw.percent : 0,
            error: typeof raw.error === "string" ? raw.error : null,
        };
    } catch {
        return null;
    }
}

/** 合并写入 flag；写盘失败不影响更新流程本身（面板只是少了一个状态展示）。 */
function writeFlag(patch: Partial<ShellUpdateFlag>): ShellUpdateFlag {
    if (!current) current = readShellUpdateFlag() ?? { ...EMPTY_FLAG };
    current = { ...current, ...patch };
    try {
        const file = flagFilePath();
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify({ ...current, checkedAt: new Date().toISOString() }, null, 2));
    } catch (error) {
        console.error("[desktop] write shell-update.json failed:", (error as Error)?.message || error);
    }
    return current;
}

export function initAutoUpdater() {
    if (!app.isPackaged) {
        console.log("[desktop] auto-update skipped (dev)");
        return;
    }

    current = readShellUpdateFlag() ?? { ...EMPTY_FLAG };
    // 上个进程在下载途中退出时，文件里会残留 downloading=true，
    // 若不清掉，前端会一直显示「下载中」且按钮永久禁用。
    if (current.downloading) current = writeFlag({ downloading: false, percent: 0 });

    autoUpdater.autoDownload = false; // 仅检查，用户点「下载」才真正下载
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("update-available", (info) => {
        console.log("[desktop] shell update available:", info.version);
        // 同一版本的安装包可能已经下载过，重复检查时不要把它重置成未下载。
        const alreadyDownloaded = Boolean(current?.downloaded) && current?.version === info.version;
        writeFlag({ available: true, downloaded: alreadyDownloaded, version: info.version, error: null });
    });
    autoUpdater.on("update-not-available", () => {
        writeFlag({ available: false, downloaded: false, version: null, error: null });
    });
    autoUpdater.on("download-progress", (progress) => {
        const now = Date.now();
        // 节流：最多每 800ms 写一次盘；接近完成时放行，保证 100% 能落盘。
        if (progress.percent < 99.5 && now - lastProgressWrite < 800) return;
        lastProgressWrite = now;
        const percent = Math.max(0, Math.min(100, Math.round(progress.percent)));
        writeFlag({ downloading: true, percent });
    });
    autoUpdater.on("update-downloaded", (info) => {
        console.log("[desktop] shell update downloaded:", info.version);
        writeFlag({ available: true, downloaded: true, version: info.version, downloading: false, percent: 100, error: null });
    });
    autoUpdater.on("error", (err) => {
        const message = (err as Error)?.message || String(err);
        console.error("[desktop] auto-updater error:", message);
        // 只有用户主动发起的下载失败才回显到面板；后台定时检查的偶发失败不打扰用户。
        if (downloading) writeFlag({ downloading: false, percent: 0, error: message });
    });

    // 启动后 30s 与之后每 6 小时检查一次
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 30_000);
    setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

/**
 * 下载桌面壳安装包。幂等：下载中重复调用直接返回当前状态；已下载则直接返回。
 * 失败原因会写入 flag.error（面板可见）并向上抛出，便于 HTTP 层记录日志。
 */
export async function downloadShellUpdate(): Promise<ShellUpdateFlag> {
    if (!app.isPackaged) throw new Error("桌面壳更新仅在安装版可用（开发模式不支持）");
    if (downloading) return current ?? { ...EMPTY_FLAG };

    const snapshot = current ?? readShellUpdateFlag();
    if (snapshot?.downloaded) return snapshot;

    downloading = true;
    lastProgressWrite = 0;
    writeFlag({ downloading: true, percent: 0, error: null });
    try {
        // downloadUpdate() 依赖上一次 checkForUpdates() 的结果，没有结果时会抛
        // "Please check update first"；所以未检查过就先补一次检查。
        if (!snapshot?.available) await autoUpdater.checkForUpdates();
        await autoUpdater.downloadUpdate();
    } catch (error) {
        const message = (error as Error)?.message || String(error);
        writeFlag({ downloading: false, percent: 0, error: message });
        throw error;
    } finally {
        downloading = false;
        // downloadUpdate 正常返回但 update-downloaded 未及时回调时，别把面板卡在「下载中」。
        if (current?.downloading) writeFlag({ downloading: false });
    }
    return current ?? { ...EMPTY_FLAG };
}

/** 重启并安装已下载的壳更新。返回 false 表示当前没有可安装的安装包（未下载完成）。 */
export function quitAndInstallShellUpdate(): boolean {
    if (!app.isPackaged) return false;
    const flag = current ?? readShellUpdateFlag();
    if (!flag?.downloaded) return false;
    autoUpdater.quitAndInstall(false, true);
    return true;
}
