#!/usr/bin/env node
/**
 * 自建插件 registry 生成器（P1a）
 *
 * 产出 `official-plugins.json`，供「官方插件」频道（画布插件面板里的「官方」分类）使用。
 * 与默认指向上游的 `basketikun/infinite-canvas@plugins-dist` 不同，这里是**自托管**频道：
 *   - 同源部署（把 registry 与 bundle 一起放到 CF Pages / R2 同站）→ 直接可用，不依赖任何 CDN；
 *   - 推送到本仓库 `plugins-dist` 孤儿分支经 jsDelivr 分发 → `entry` 相对 registry URL 解析，
 *     同样可用，且不依赖上游（上游缺 director-desk / clipshot，且大陆网络下 jsDelivr 时通时断）。
 *
 * 元数据以本文件下方的 `SELF_HOSTED_PLUGINS` 为权威来源，须与各插件
 * `plugins/canvas/<id>/src/index.tsx` 里的 `definePlugin({ id, name, version, description })` 保持一致。
 * （bundle 经压缩后 `id` 会被提升到重命名变量，无法可靠自动提取，故采用可维护的显式映射。）
 *
 * 用法：
 *   node scripts/generate-plugin-registry.mjs [--out <json 输出路径>] [--copy <文件拷贝目录>]
 * 不传参时仅把 JSON 打印到 stdout，供 CI / 调试使用。
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pluginsDir = resolve(repoRoot, "web/public/plugins");

/** 自研插件的权威元数据。bundle 文件名 = 目录名；id 须与 definePlugin 的注册 id 完全一致。 */
const SELF_HOSTED_PLUGINS = [
    {
        file: "clipshot.js",
        id: "clipshot-run",
        name: "分镜工作台",
        version: "1.1.0",
        description: "分镜工作台：内置 cinematic-storyboard-design Skill（clipshot），把剧本拆成可自定义格数（默认九宫格）的制作型分镜与逐格提示词，并可连接下游「分镜出图」节点按分镜序列自动出图",
        icon: "🎬",
    },
    {
        file: "director-desk.js",
        id: "director-desk",
        name: "白模预演台",
        version: "1.1.0",
        description: "白模预演台：导入 glTF/GLB 模型、布置机位与灯光、实时预览，并可将预演视频导出为画布节点",
        icon: "🏗️",
    },
    {
        file: "jlmlh-3d-director.js",
        id: "jlmlh-3d-director",
        name: "3D 导演台节点",
        version: "1.0.0",
        description: "三维导演台：上游背景同步、机位与时间线、截图自动输出及一键导出画布",
        icon: "3D",
    },
    {
        file: "openreel-video.js",
        id: "openreel-video",
        name: "OpenReel 视频编辑器",
        version: "1.1.0",
        description: "在画布内嵌 OpenReel 浏览器端专业视频编辑器：时间线剪辑、转场、滤镜、字幕、ffmpeg 导出",
        icon: "🎬",
    },
];

function parseArg(name) {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : null;
}

const outFile = parseArg("--out");
const copyDir = parseArg("--copy");

function buildRegistry() {
    const present = new Set(
        existsSync(pluginsDir) ? readdirSync(pluginsDir).filter((f) => f.endsWith(".js")) : [],
    );
    const plugins = SELF_HOSTED_PLUGINS.filter((p) => present.has(p.file)).map((p) => ({
        id: p.id,
        name: p.name,
        version: p.version,
        description: p.description,
        icon: p.icon,
        entry: `/plugins/${p.file}`,
    }));
    if (!plugins.length) {
        throw new Error(`未在 ${pluginsDir} 发现任何自研插件 bundle。请先构建插件或将 bundle 提交到 web/public/plugins。`);
    }
    return {
        generatedAt: new Date().toISOString(),
        source: "self-hosted",
        plugins,
    };
}

const registry = buildRegistry();

if (copyDir) {
    mkdirSync(copyDir, { recursive: true });
    for (const p of registry.plugins) {
        const src = resolve(pluginsDir, basename(p.entry));
        if (existsSync(src)) copyFileSync(src, resolve(copyDir, basename(p.entry)));
    }
    writeFileSync(resolve(copyDir, "official-plugins.json"), JSON.stringify(registry, null, 2) + "\n", "utf8");
    console.log(`[registry] 已写出 ${registry.plugins.length} 个插件到 ${copyDir}/official-plugins.json`);
}

const json = JSON.stringify(registry, null, 2);
if (outFile) {
    mkdirSync(dirname(outFile), { recursive: true });
    writeFileSync(outFile, json + "\n", "utf8");
    console.log(`[registry] 已写出 ${outFile}`);
} else {
    process.stdout.write(json + "\n");
}
