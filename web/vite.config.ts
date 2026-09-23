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

/**
 * 监听端口：环境变量优先（CANVAS_WEB_PORT，其次平台常用的 PORT），默认 3000。
 * 端口不写死在 package.json 里 —— 本机开发、自建服务器、容器部署用同一份配置即可。
 */
function resolveWebPort(): number {
    for (const raw of [process.env.CANVAS_WEB_PORT, process.env.PORT]) {
        const port = Number(raw);
        if (Number.isInteger(port) && port > 0 && port < 65536) return port;
    }
    return 3000;
}

/**
 * dev 与 preview 共用的网络配置。
 * strictPort:false ⇒ 默认端口被别的应用占用时，Vite 自动顺延到下一个可用端口
 * （3000 → 3001 → 3002…）并在终端提示，不需要人工改端口；
 * 需要「端口必须固定、占用即失败」的场景，可把 strictPort 打开。
 * 每次调用返回新对象，避免被 Vite 就地改写。
 */
const networkOptions = () => ({ host: true, port: resolveWebPort(), strictPort: false });

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

// 构建产物清单（P3a）：对本次构建的每个产物计算 sha256，产出 build-manifest.json。
// 桌面端三层更新据此做前端增量覆盖；CF Pages 部署时一并发布，网页版与桌面端共用同一份产物。
//
// 注意：必须同时收录 chunk（JS，取 .code）与 asset（CSS/图片等，取 .source）。
// 只按 asset 过滤会漏掉全部 JS 产物，导致「主 bundle 变了但清单没变」→ 增量更新永远不触发。
function buildManifest(): Plugin {
    return {
        name: "build-manifest",
        apply: "build",
        generateBundle(_options, bundle) {
            const files = Object.values(bundle)
                .map((item) => {
                    const raw = item.type === "asset" ? item.source : item.code;
                    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as string);
                    return { path: item.fileName, hash: createHash("sha256").update(buf).digest("hex"), size: buf.length };
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
    server: networkOptions(),
    preview: networkOptions(),
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
