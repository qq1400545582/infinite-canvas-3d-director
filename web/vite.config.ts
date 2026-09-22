import { readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";
import { onlineUpdate } from "./vite-plugins/online-update";
import { canvasAgentLauncher } from "./vite-plugins/canvas-agent-launcher";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

// 构建产物清单（P3a）：对本次构建的每个 asset 计算 sha256，产出 build-manifest.json。
// 桌面端三层更新据此做前端增量覆盖；CF Pages 部署时一并发布，网页版与桌面端共用同一份产物。
function buildManifest(): Plugin {
    return {
        name: "build-manifest",
        apply: "build",
        generateBundle(_options, bundle) {
            const files = Object.entries(bundle)
                .filter(([name, chunk]) => chunk.type === "asset")
                .map(([name, chunk]) => {
                    const src = (chunk as { source: string | Uint8Array }).source;
                    const buf = Buffer.isBuffer(src) ? src : Buffer.from(src as string);
                    return { path: name, hash: createHash("sha256").update(buf).digest("hex"), size: buf.length };
                })
                .filter((f) => f.path !== "build-manifest.json")
                .sort((a, b) => a.path.localeCompare(b.path));
            const manifest = { version: localVersion, generatedAt: new Date().toISOString(), files };
            this.emitFile({ type: "asset", fileName: "build-manifest.json", source: JSON.stringify(manifest, null, 2) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), onlineUpdate({ repoRoot: resolve(webDir, "..") }), canvasAgentLauncher(), buildManifest()],
    optimizeDeps: {
        // public/ 下的 vendored 产物（OpenReel / 3D 导演台自带 index.html）会被静态原样拷贝、
        // 并不属于应用模块图。但 Vite 默认会把所有 html 当入口扫描，顺 script 找到 OpenReel
        // 的打包产物后命中未安装的 @emotion/is-prop-valid，导致依赖扫描失败、
        // 预构建被整体跳过 → 浏览器请求全部挂起（一直转圈）。故只扫应用入口。
        entries: ["index.html"],
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});
