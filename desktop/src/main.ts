import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
import { app, BrowserWindow, session, shell } from "electron";

import { createLocalServer } from "./server";
import { createAgentMiddleware } from "./agent-handler";
import { createLayerUpdateMiddleware } from "./updater";
import { initAutoUpdater } from "./auto-update";

// 固定端口：默认与 web 开发服务一致（127.0.0.1:3000），便于直接继承本地开发数据；
// 可用环境变量 CANVAS_DESKTOP_PORT 覆盖。注意必须用 127.0.0.1（不要用 localhost，
// 二者是不同源，差一个字符就要重迁数据）。
const PORT = Number(process.env.CANVAS_DESKTOP_PORT) || 3000;
const APP_ORIGIN = `http://127.0.0.1:${PORT}`;

function resolveBuiltinDist(): string {
    if (app.isPackaged) return path.join(process.resourcesPath, "web-dist");
    return path.resolve(process.cwd(), "../web/dist");
}

function createWindow(overlayDir: string, builtinDir: string) {
    const win = new BrowserWindow({
        width: 1440,
        height: 900,
        minWidth: 1024,
        minHeight: 640,
        backgroundColor: "#0c0a09",
        show: false,
        webPreferences: {
            preload: path.join(__dirname, "preload.js"),
            contextIsolation: true,
            nodeIntegration: false,
            // 不设置 COOP/COEP：保持 crossOriginIsolated === false，与现有 nginx 部署一致（openreel 维持单线程，非回归）。
        },
    });

    // 本机服务已接住 /__canvas-agent/* 与 /__layer-update/*；其它本机相对路径一律放行。
    win.webContents.setWindowOpenHandler(({ url }) => {
        if (url.startsWith(APP_ORIGIN)) return { action: "allow" };
        void shell.openExternal(url);
        return { action: "deny" };
    });
    win.webContents.on("will-navigate", (event, url) => {
        if (url.startsWith(APP_ORIGIN) || url.startsWith("about:") || url.startsWith("data:")) return;
        event.preventDefault();
        void shell.openExternal(url);
    });

    win.once("ready-to-show", () => win.show());
    void win.loadURL(APP_ORIGIN + "/");

    return win;
}

function setupDownloadHandling() {
    // 文件导出（file-saver 的 saveAs / canvas-export）走系统下载；默认保存到系统下载目录。
    session.defaultSession.on("will-download", (_event, item) => {
        const filename = item.getFilename();
        console.log(`[desktop] download: ${filename}`);
        item.on("updated", (_e, state) => {
            if (state === "interrupted") console.warn(`[desktop] download interrupted: ${filename}`);
        });
        item.on("done", (_e, state) => {
            if (state === "completed") console.log(`[desktop] download finished: ${filename}`);
            else console.warn(`[desktop] download failed (${state}): ${filename}`);
        });
    });
}

app.whenReady().then(async () => {
    const overlayDir = path.join(app.getPath("userData"), "frontend-overlay");
    const builtinDir = resolveBuiltinDist();
    if (!existsSync(builtinDir)) {
        console.error(`[desktop] builtin dist not found: ${builtinDir}（请先运行 npm run build:web）`);
    }
    mkdirSync(overlayDir, { recursive: true });

    setupDownloadHandling();

    // 本机中间件：画布后端启动（复用 web/ 中间件）+ 三层更新（P3）。顺序无关。
    const middlewares = [...createAgentMiddleware(), ...createLayerUpdateMiddleware(overlayDir, builtinDir, app.getPath("userData"))];

    initAutoUpdater();

    await createLocalServer({ port: PORT, overlayDir, builtinDir, middlewares });

    createWindow(overlayDir, builtinDir);

    app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow(overlayDir, builtinDir);
    });
});

app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
});

// 阻止多开（可选）：第二个实例聚焦第一个窗口。
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
    app.quit();
} else {
    app.on("second-instance", () => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
            if (win.isMinimized()) win.restore();
            win.focus();
        }
    });
}
