"use strict";
/**
 * 打包浏览器扩展分发包（一条命令完成全部分发布置）：
 *   node browser-extension/make-extension-zip.cjs
 *
 * 产出与落位：
 *   1. browser-extension/releases/send-to-infinite-canvas.zip（稳定名，每次覆盖为最新版）
 *   2. web/public/downloads/ + web/dist/downloads/ + desktop/resources/web-dist/downloads/
 *      + %APPDATA%\infinite-canvas-desktop\frontend-overlay\downloads\  → 桌面应用
 *      http://127.0.0.1:3000/downloads/send-to-infinite-canvas.zip 即时可下载；
 *      未来构建会从 web/public 自动携带，部署到公网后同路径可下载。
 *   3. desktop/resources/browser-extension/（解压版副本，随 electron-builder extraResources 进安装包）。
 *
 * 安全：bookmarklet.html 内嵌真实 token，严禁进任何分发产物（脚本内硬校验）。
 */
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, ".."); // 仓库根 infinite-canvas/
const EXT = path.join(__dirname);
const ZIP_NAME = "send-to-infinite-canvas.zip";
// 随分发包 ship 的文件清单（固定枚举，防止临时文件/密钥混入）
const SHIP = [
    "manifest.json",
    "background.js",
    "content.js",
    "content.css",
    "media.js",
    "popup.html",
    "popup.js",
    "options.html",
    "options.js",
    "show-agent-token.cjs",
    "make-bookmarklet.cjs",
    "bookmarklet-src.js",
    "README.md",
];

function copyFilesTo(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of files) fs.copyFileSync(path.join(EXT, f), path.join(dir, f));
}

function runPowershell(command) {
    return new Promise((resolve, reject) => {
        const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { windowsHide: true });
        let err = "";
        child.stderr.on("data", (d) => (err += String(d)));
        child.on("error", reject);
        child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`PowerShell 失败(${code}): ${err.trim()}`))));
    });
}

/**
 * 把 zip 里的 Windows 反斜杠路径改成正斜杠。
 *
 * 为什么必须改：Compress-Archive 在 Windows 上把条目名写成 `send-to-infinite-canvas\manifest.json`。
 * Windows 解压正常，但 macOS / Linux 的 unzip 会当成一个带反斜杠的**扁平文件名**，
 * 解出来是 `send-to-infinite-canvas\manifest.json` 一个文件，扩展直接装载失败 —— 而这个包
 * 恰恰是发给别人的（对方可能是 Mac）。
 *
 * 做法：只就地改写「文件名字段」里的 `\`（0x5C → 0x2F），两处都要改（本地头 + 中央目录），
 * 长度不变因此不用重算任何偏移量与 CRC；绝不做全字节替换（压缩数据里可能出现 0x5C）。
 */
function normalizeZipSeparators(zipPath) {
    const buffer = fs.readFileSync(zipPath);
    // 定位中央目录（EOCD）
    let eocd = -1;
    for (let i = buffer.length - 22; i >= 0; i -= 1) {
        if (buffer.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("zip 结构异常：找不到中央目录");
    const total = buffer.readUInt16LE(eocd + 10);
    let central = buffer.readUInt32LE(eocd + 16);
    let patched = 0;
    const localOffsets = [];
    for (let index = 0; index < total; index += 1) {
        if (buffer.readUInt32LE(central) !== 0x02014b50) throw new Error("zip 结构异常：中央目录条目损坏");
        const nameLength = buffer.readUInt16LE(central + 28);
        const extraLength = buffer.readUInt16LE(central + 30);
        const commentLength = buffer.readUInt16LE(central + 32);
        const nameStart = central + 46;
        const name = buffer.toString("utf8", nameStart, nameStart + nameLength);
        localOffsets.push({ name, nameStart, nameLength, local: buffer.readUInt32LE(central + 42) });
        if (name.includes("\\")) patched += 1;
        central += 46 + nameLength + extraLength + commentLength;
    }
    for (const entry of localOffsets) {
        for (const start of [entry.nameStart, entry.local + 30]) {
            const end = start + entry.nameLength;
            for (let i = start; i < end; i += 1) {
                if (buffer[i] === 0x5c) {
                    buffer[i] = 0x2f;
                }
            }
        }
    }
    if (patched) fs.writeFileSync(zipPath, buffer);
    return { entries: total, patched };
}

(async () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
    const version = manifest.version;
    if (SHIP.includes("bookmarklet.html")) throw new Error("bookmarklet.html 内嵌真实 token，禁止分发");

    // 1. staging（顶层带文件夹，解压即得干净目录）
    const stageRoot = path.join(ROOT, ".workbuddy", "tmp", "ext-zip-stage");
    const stageDir = path.join(stageRoot, "send-to-infinite-canvas");
    fs.rmSync(stageRoot, { recursive: true, force: true });
    copyFilesTo(stageDir, SHIP);

    // 2. zip
    const releasesDir = path.join(EXT, "releases");
    fs.mkdirSync(releasesDir, { recursive: true });
    const zipPath = path.join(releasesDir, ZIP_NAME);
    fs.rmSync(zipPath, { force: true });
    await runPowershell(`Compress-Archive -Path "${stageDir}" -DestinationPath "${zipPath}" -Force`);

    // 2.1 修正条目分隔符，保证 macOS / Linux 解压后目录结构正确（详见函数注释）
    const normalized = normalizeZipSeparators(zipPath);
    if (normalized.patched === 0 && normalized.entries > 0) {
        console.warn("提示：本次未发现反斜杠条目名，若换用其它压缩工具请复查跨平台解压效果");
    }

    // 3. 分发到下载位（web/public 是源，三层静态目录立即生效）
    const appData = process.env.APPDATA || path.join("C:", "Users", "Administrator", "AppData", "Roaming");
    const downloadDirs = [
        path.join(ROOT, "web", "public", "downloads"),
        path.join(ROOT, "web", "dist", "downloads"),
        path.join(ROOT, "desktop", "resources", "web-dist", "downloads"),
        path.join(appData, "infinite-canvas-desktop", "frontend-overlay", "downloads"),
    ];
    for (const dir of downloadDirs) {
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(zipPath, path.join(dir, ZIP_NAME));
    }

    // 4. 桌面端解压版副本（进安装包，装完即可「加载已解压的扩展程序」）
    const desktopExtDir = path.join(ROOT, "desktop", "resources", "browser-extension");
    fs.rmSync(desktopExtDir, { recursive: true, force: true });
    copyFilesTo(desktopExtDir, SHIP);

    const kb = Math.max(1, Math.round(fs.statSync(zipPath).size / 1024));
    console.log(`已打包 v${version} → ${zipPath} (${kb}KB，${normalized.entries} 个条目，分隔符已规范为正斜杠)`);
    for (const dir of downloadDirs) console.log("下载位:", path.join(dir, ZIP_NAME));
    console.log("解压版副本:", desktopExtDir);
    console.log("本机下载 URL: http://127.0.0.1:3000/downloads/" + ZIP_NAME);
})().catch((error) => {
    console.error("FAIL:", error.message);
    process.exit(1);
});
