#!/usr/bin/env node
/**
 * build-manifest 生成器（P3a）
 *
 * 对 web/dist 逐文件计算 sha256，产出 build-manifest.json（版本号 + 文件清单）。
 * 桌面端三层更新用它对「前端 bundle」做增量覆盖；CF Pages 部署时也一并发布，
 * 使网页版与桌面端共用同一份产物、版本永不漂移。
 *
 * 用法：
 *   node scripts/build-manifest.mjs [--dist <web/dist 路径>] [--out <输出 json 路径>] [--version <版本>]
 * 不传参时默认：dist = web/dist，out = web/dist/build-manifest.json，version = ../VERSION。
 */
import { createHash } from "node:crypto";
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, relative, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function parseArg(name, fallback) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : fallback;
}

function walk(dir, base = dir, out = []) {
    for (const entry of readdirSync(dir)) {
        const full = resolve(dir, entry);
        if (statSync(full).isDirectory()) walk(full, base, out);
        else out.push(relative(base, full).split("\\").join("/"));
    }
    return out;
}

export function generateManifest(distDir, version) {
    const files = walk(distDir)
        .filter((p) => p !== "build-manifest.json")
        .sort()
        .map((p) => {
            const buf = readFileSync(resolve(distDir, p));
            return { path: p, hash: createHash("sha256").update(buf).digest("hex"), size: buf.length };
        });
    return { version, generatedAt: new Date().toISOString(), files };
}

// CLI 入口
const isMain = pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
    const distDir = resolve(repoRoot, parseArg("--dist", "web/dist"));
    const outFile = resolve(repoRoot, parseArg("--out", "web/dist/build-manifest.json"));
    let version = parseArg("--version", "");
    if (!version) {
        try {
            version = readFileSync(resolve(repoRoot, "VERSION"), "utf8").trim() || "dev";
        } catch {
            version = "dev";
        }
    }
    if (!existsSync(distDir)) {
        console.error(`[manifest] dist 目录不存在：${distDir}`);
        process.exit(1);
    }
    const manifest = generateManifest(distDir, version);
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    console.log(`[manifest] ${manifest.files.length} 个文件，版本 ${version} -> ${outFile}`);
}
