// 官方插件集中构建:一次进程构建所有官方插件 + 生成清单,产物进 dist/(已 gitignore)。
// 官方插件目录本身不各自安装依赖:统一从本目录 node_modules 解析 SDK(nodePaths)。
// CI(publish-plugins.yml)把 dist/ 强推到 plugins-dist 分支,前端经 jsDelivr 远程拉取。
// 本地自测:`npm install && npm run build`,再把 VITE_PLUGIN_REGISTRY_URL 指向本地 dist。
import { build } from "esbuild";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outDir = join(root, "dist");
const nodeModules = join(root, "node_modules");

// 官方插件登记表:新增官方插件在此登记即可。
// 版本不在这里写死 —— 从各插件的 package.json 读取(单一真源),
// 与插件 src 里 definePlugin({version}) 保持一致,避免清单与产物版本脱节。
const OFFICIAL = [
    { id: "markdown", dir: "markdown", name: "Markdown 节点", description: "在画布中编辑与渲染 Markdown", icon: "📝" },
    { id: "svg", dir: "svg", name: "SVG 节点", description: "透明背景渲染 SVG,可接收上游文本节点的 SVG 源码", icon: "🔷" },
    { id: "html", dir: "html", name: "HTML 节点", description: "沙箱 iframe 渲染 HTML,支持 {{input}} 注入上游文本", icon: "🌐" },
    { id: "panorama", dir: "panorama", name: "3D 全景节点", description: "查看 360° 等距柱状全景图,可从上游图片节点取图", icon: "🧭" },
    { id: "sticky-note", dir: "sticky-note", name: "便利贴节点", description: "可自选颜色、双击编辑、拖动即可移动的便利贴", icon: "📌" },
    // 3D 导演台：以同源 iframe 内嵌 jlmlh-3d-director（app/ 下 vendor 的源码逻辑不改），
    // 本插件只做 iframe + postMessage 桥接。除本 bundle 外，还需先 `npm run build:app`
    // 把导演台构建到 web/public/jlmlh-3d-director/（同源静态资源，随仓库提交）。
    { id: "jlmlh-3d-director", dir: "jlmlh-3d-director", name: "3D 导演台节点", description: "在画布内嵌 jlmlh-3d-director 三维导演台:模型导入、机位管理、时间线动画、截图导出到画布", icon: "🎬" },
    // OpenReel：以同源 iframe 内嵌 OpenReel 浏览器端专业视频编辑器（app/ 下 vendor 的源码逻辑不改，
    // 仅 vite base 改为相对路径以便嵌入 /openreel-video/ 子路径）。除本 bundle 外，还需先
    // `npm run build:app` 把编辑器构建到 web/public/openreel-video/（同源静态资源，随仓库提交）。
    { id: "openreel-video", dir: "openreel-video", name: "OpenReel 视频编辑器", description: "在画布内嵌 OpenReel 浏览器端专业视频编辑器:时间线剪辑、转场、滤镜、字幕、ffmpeg 导出", icon: "🎬" },
    // 白模预演台：以同源 iframe 内嵌 mangfufu/director-desk（纯前端 Three.js SPA，无 React / 无后端 / 无宿主桥接协议），
    // 本插件只做 iframe 容器 + 重载按钮（与 jlmlh-3d-director 同策略）。除本 bundle 外，还需先
    // `npm run build:app` 把构建产物放到 web/public/director-desk/（同源静态资源，随仓库提交）。
    { id: "director-desk", dir: "director-desk", name: "白模预演台节点", description: "在画布内嵌 DirectorDesk 白模预演台:glTF/GLB 导入、机位与灯光布置、实时白模预览", icon: "🏗️" },
    // 分镜工作台：把开源 Skill「cinematic-storyboard-design」(TanShilongMario/clipshot, MIT) 的提示词与规范
    // 逐字内联进节点（见 clipshot/src/prompts.ts，由 tools/gen-prompts.mjs 生成），运行时用宿主注入的
    // ctx.ai 驱动文本模型拆镜头 + 图像模型出制作型分镜总图。分镜格数可自定义（默认 3×3 九宫格），
    // 逐格提示词写进节点 metadata，由下游「分镜出图」节点按分镜序列逐格出图。纯节点实现，无 iframe、无静态产物需同步。
    { id: "clipshot", dir: "clipshot", name: "分镜工作台节点", description: "按 clipshot Skill 规范把剧本拆成可自定义格数（默认九宫格）的制作型分镜与时间线镜头表，并可连接下游节点按分镜序列逐格出图", icon: "🎬" },
];

// 读取插件 package.json 的 version 作为清单版本的唯一来源
async function readPluginVersion(dir) {
    const pkg = JSON.parse(await readFile(join(root, "..", dir, "package.json"), "utf8"));
    if (!pkg.version) throw new Error(`插件 ${dir} 的 package.json 缺少 version`);
    return pkg.version;
}

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });

for (const plugin of OFFICIAL) {
    await build({
        entryPoints: [join(root, "..", plugin.dir, "src", "index.tsx")],
        outfile: join(outDir, `${plugin.id}.js`),
        bundle: true,
        format: "esm",
        platform: "browser",
        target: "es2020",
        // automatic JSX → SDK 的 jsx-runtime(内部用宿主 React),react external
        jsx: "automatic",
        jsxImportSource: "@infinite-canvas/plugin-sdk",
        loader: { ".ts": "ts", ".tsx": "tsx", ".css": "text" },
        external: ["react", "react-dom"],
        minify: true,
        nodePaths: [nodeModules],
    });
    console.log(`built ${plugin.id}.js`);
}

const manifest = {
    // 清单结构版本;entry 为相对本清单的 bundle 文件名,由前端解析成绝对 URL
    version: 1,
    plugins: await Promise.all(
        OFFICIAL.map(async (plugin) => ({
            id: plugin.id,
            name: plugin.name,
            version: await readPluginVersion(plugin.dir),
            description: plugin.description,
            icon: plugin.icon,
            entry: `${plugin.id}.js`,
        })),
    ),
};
await writeFile(join(outDir, "official-plugins.json"), JSON.stringify(manifest, null, 4) + "\n");
console.log(`wrote official-plugins.json (${OFFICIAL.length} plugins) → dist/`);
