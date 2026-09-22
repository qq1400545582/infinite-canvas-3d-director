#!/usr/bin/env node
/**
 * 为桌面端构建 web 前端：在 web/ 下 install + build，再把 dist 拷贝到 desktop/resources/web-dist。
 * 构建后顺带生成 build-manifest.json（逐文件 sha256 + 版本号），供桌面端三层更新使用。
 *
 * 默认用 bun；可用环境变量 WEB_PKG_MANAGER 覆盖（例如 npm / pnpm）。
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const webDir = path.join(repoRoot, "web");
const outDir = path.resolve(here, "..", "resources", "web-dist");
const pkgManager = process.env.WEB_PKG_MANAGER || "bun";

function run(cmd, args, cwd) {
    const r = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: cmd === "bun" ? false : process.platform === "win32" });
    if (r.status !== 0) process.exit(r.status ?? 1);
}

console.log(`[build-web] install (${pkgManager})`);
run(pkgManager, ["install"], webDir);

console.log("[build-web] build web");
run(pkgManager, ["run", "build"], webDir);

console.log("[build-web] generate build-manifest");
run("node", [path.join(repoRoot, "scripts", "build-manifest.mjs"), "--out", path.join(webDir, "dist", "build-manifest.json")], repoRoot);

console.log("[build-web] copy dist -> resources/web-dist");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(path.dirname(outDir), { recursive: true });
cpSync(path.join(webDir, "dist"), outDir, { recursive: true });
console.log(`[build-web] done -> ${outDir}`);
