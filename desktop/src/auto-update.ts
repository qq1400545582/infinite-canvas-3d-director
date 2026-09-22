import path from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { app } from "electron";
import { autoUpdater } from "electron-updater";

/**
 * 桌面壳自动更新（三层更新的第 ③ 层）：由 electron-updater 从 GitHub Release 拉取新壳。
 * 仅打包后生效（dev 不检查）。发现可用更新写入 userData/shell-update.json，
 * 供 /__layer-update/status 汇总展示；下载完成后提示用户重启生效。
 */
export function initAutoUpdater() {
    if (!app.isPackaged) {
        console.log("[desktop] auto-update skipped (dev)");
        return;
    }
    const flagFile = path.join(app.getPath("userData"), "shell-update.json");

    const writeFlag = (data: object) => {
        mkdirSync(path.dirname(flagFile), { recursive: true });
        writeFileSync(flagFile, JSON.stringify({ ...data, checkedAt: new Date().toISOString() }, null, 2));
    };

    autoUpdater.autoDownload = false; // 先仅检查，用户确认后再下载（下载较大）
    autoUpdater.on("update-available", (info) => {
        console.log("[desktop] shell update available:", info.version);
        writeFlag({ available: true, downloaded: false, version: info.version });
    });
    autoUpdater.on("update-not-available", () => {
        writeFlag({ available: false, downloaded: false, version: null });
    });
    autoUpdater.on("update-downloaded", (info) => {
        console.log("[desktop] shell update downloaded:", info.version);
        writeFlag({ available: true, downloaded: true, version: info.version });
    });
    autoUpdater.on("error", (err) => {
        console.error("[desktop] auto-updater error:", err?.message || err);
    });

    // 启动后 30s 与之后每 6 小时检查一次
    setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 30_000);
    setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), 6 * 60 * 60 * 1000);
}

export function readShellUpdateFlag(): { available: boolean; downloaded: boolean; version: string | null } | null {
    try {
        const flagFile = path.join(app.getPath("userData"), "shell-update.json");
        if (!existsSync(flagFile)) return null;
        return JSON.parse(readFileSync(flagFile, "utf8")) as { available: boolean; downloaded: boolean; version: string | null };
    } catch {
        return null;
    }
}

export function quitAndInstallShellUpdate() {
    if (app.isPackaged) autoUpdater.quitAndInstall(false, true);
}
