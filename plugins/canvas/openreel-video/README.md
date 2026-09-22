# OpenReel 视频编辑器 · 画布节点插件

把开源项目 [OpenReel Video](https://github.com/Augani/openreel-video)（MIT，浏览器端专业视频编辑器：
时间线剪辑、转场、滤镜、调色、字幕、音频处理、ffmpeg 导出）以**画布节点插件**形式接入无限画布，
可在「节点插件」管理器中**随意安装 / 关闭 / 卸载**。

- 插件 id：`openreel-video`
- 节点类型：`openreel-video:editor`
- 图标：🎬
- 默认尺寸：960 × 600

---

## 一、集成方式（为什么用 iframe）

OpenReel 是**独立的浏览器端 SPA**（React 19 + Vite），并且是 pnpm monorepo，自身并未设计宿主桥接协议；
同时无限画布的插件契约要求 **React 必须是宿主单例**（插件不打包 react）。

因此沿用本仓库已验证的 **3D 导演台（jlmlh-3d-director）同源 iframe 桥接**策略：

- OpenReel 完整源码 **vendor 在 `app/`**，所有编辑器功能逻辑**保持不变**；仅做了三处**集成必需补丁**（不影响任何既有编辑能力，见第三节表格）：
  1. `vite.config.ts` 新增 `OPENREEL_BASE_RELATIVE` 开关使资源走相对路径；
  2. Service Worker 注册与 `sw.js` 改为基于部署基址的相对作用域，避免嵌入子路径时劫持宿主应用；
  3. **新增** `bridges/canvas-host-bridge.ts`（纯新增模块 + `main.tsx` 里一次安装调用），用于接收上游节点媒体并调用编辑器自己的 `importMedia` 入库。
- 本插件做五件事：同源 iframe 嵌入、运行时中文本地化、「使用中」整节点高亮、上游媒体自动入库、仅悬停显示的重载按钮；
- 产物构建到 `web/public/openreel-video/`（同源托管），iframe 以
  `/openreel-video/index.html?instanceId=<nodeId>` 加载。

> **关于「交互 / 移动」**：本节点 `defaultMetadata` 为空（`metadata.content` 未设置），而宿主的判定是
> `contentInteractive = !interactionToggle || forceInteractive || !metadata.content ? true : interactive`
> —— 空内容节点**始终可交互**，因此编辑器打开即可直接操作，节点上也不会出现「交互 ⇄ 移动」按钮。
> 需要拖动节点时，抓节点上方的**标题栏**区域即可（iframe 会吞掉内容区内的指针事件，这是 iframe 嵌入的固有特性）。
> 基于同一原因，节点内**不再显示任何操作提示文字**。

---

## 二、源码与产物布局

```
plugins/canvas/openreel-video/
├── app/                              # ← OpenReel 完整仓库（vendor，逻辑零改动）
│   ├── apps/web/                     #   编辑器前端（构建目标 @openreel/web）
│   │   └── src/bridges/
│   │       └── canvas-host-bridge.ts #   ★ 新增：宿主桥（接收上游媒体 → importMedia）
│   ├── packages/{core,ui,agent,...}  #   工作区包（core 含 ffmpeg / wasm / 时间线引擎）
│   ├── patches/                      #   @ffmpeg/core(-mt) 的 pnpm 补丁（构建必需，须用 pnpm）
│   ├── pnpm-workspace.yaml / pnpm-lock.yaml
│   └── package.json
├── src/index.tsx                     # 插件本体（iframe 桥接层）
├── src/i18n-zh.ts                    # 运行时中文本地化（词典 + 安装器）
├── src/media-sync.ts                 # 上游媒体同步（连线 → 媒体库）
├── build.mjs                         # 打插件 JS（→ web/public/plugins/openreel-video.js）
├── build-app.mjs                     # 打编辑器应用（→ web/public/openreel-video/）
├── package.json / tsconfig.json
└── README.md
```

产物路径（均**随仓库提交**，运行时直接同源托管）：

- `web/public/plugins/openreel-video.js` — 插件 JS，被插件管理器加载
- `web/public/openreel-video/` — 编辑器静态资源（`index.html` + assets）

> `app/node_modules` 与 `app/apps/web/dist` 已被 `.gitignore` 的
> `plugins/canvas/*/node_modules`、`**/dist` 覆盖，不会入库。

---

## 三、构建

### 1) 插件 JS（很轻，秒级）

```bash
cd plugins/canvas/openreel-video
npm install     # 仅 esbuild + 类型 + 本地 SDK
npm run build   # → web/public/plugins/openreel-video.js
```

### 2) 编辑器应用（重，需正常网络）

OpenReel 依赖体量大（three / @huggingface/transformers / @mediapipe/tasks-vision /
onnxruntime-web / @ffmpeg/core(-mt) 等），且 **`patches/` 里的 `@ffmpeg/core` 补丁只能由 pnpm 应用**，
所以必须用 pnpm（`app/package.json` 已固定 `packageManager: pnpm@11.7.0`）。

```bash
cd plugins/canvas/openreel-video
pnpm build:app
```

`build-app.mjs` 做的事等价于 OpenReel 官方构建链：

```bash
cd app
pnpm install                      # 首次
OPENREEL_BASE_RELATIVE=1 pnpm build   # = build:wasm(asc) + tsc --noEmit + vite build
# 然后把 app/apps/web/dist 拷贝到 web/public/openreel-video/
```

### 关键构建细节（务必不要改动）

| 项 | 说明 |
| --- | --- |
| **必须跑 `build:wasm`** | `packages/core/src/wasm/{fft,wav,beat-detection}` 的 `*.wasm` **未提交**，需用 AssemblyScript(`asc`) 编译；缺了 web 构建会失败。官方根 `build` 脚本已包含此步。 |
| **`base` 改为相对路径** | `app/apps/web/vite.config.ts` 新增环境开关 `OPENREEL_BASE_RELATIVE`，打开时 `base = "./"`。**这是唯一的构建配置改动**，只影响资源 URL，不影响任何运行时功能。 |
| **切勿使用 `OPENREEL_DESKTOP=1`** | 它会触发 `vite-plugins/strip-ffmpeg.ts` **清空 ffmpeg core 的 wasm**（桌面端改用原生 ffmpeg），会导致**浏览器内导出功能失效**。同理 `prune-fonts` 会裁掉字体。 |
| **不可用 npm/yarn 替代** | `pnpm-workspace.yaml` 的 `patchedDependencies` 依赖 pnpm 的 patch 机制。 |
| **Service Worker 子路径隔离** | 原 `service-worker.ts` 写死 `register("/sw.js",{scope:"/"})`，`sw.js` 内 `STATIC_ASSETS=["/","/index.html","/manifest.json"]`。在 `/openreel-video/` 子路径下这会把 SW 作用域钉到站点根、**劫持宿主应用并缓存宿主资源**。已改为基于部署基址的相对注册：`base=new URL("./",location.href).pathname`，`register(base+"sw.js",{scope:base})`；`sw.js` 增 `scopeBase()`（取 `self.registration.scope`）用于 STATIC_ASSETS 与 SPA fallback。根路径下与原始行为逐字节一致，子路径下正确隔离。 |
| **宿主桥（新增模块）** | `bridges/canvas-host-bridge.ts` 是**全新文件**，`main.tsx` 里只多一行 `installCanvasHostBridge()`。它不修改任何既有模块行为：独立打开编辑器时桥处于待机（只接受 `event.source === window.parent` 的消息），被画布嵌入时才生效。导入统一走编辑器自己的 `useProjectStore.importMedia`，与「导入媒体」按钮**同一条链路**。 |

---

## 四、宿主侧运行要求（重要）

OpenReel 需要**跨源隔离**才能启用 `SharedArrayBuffer`（ffmpeg 多线程 core / onnxruntime / whisper 等）。
仓库自带 `app/apps/web/public/_headers` 表明其生产托管（Cloudflare Pages）对 `/*` 下发了：

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

因此**托管 `web/public/openreel-video/` 的服务器应对该路径前缀下发同样的两个响应头**。
若缺失，`crossOriginIsolated === false`，多线程导出等能力会降级或不可用（编辑器本身仍可打开与编辑）。

> 本插件**不修改无限画布的宿主 vite 配置**（遵循「只添加专家库/插件功能、不动其它模块」的约束），
> 故此项由部署方按需配置。

---

## 五、连线上游素材自动进媒体库

**用法**：从画布上的**图片节点 / 视频节点**右侧输出点拖一条连线，连到本节点左侧输入点即可。
这些节点生成（或上传）的内容会自动出现在 OpenReel 编辑器的**媒体库**里，随后用编辑器正常剪辑。

**链路**（插件侧只负责取文件，入库完全走编辑器原有逻辑）：

```
上游图片/视频节点 metadata.content
        │  （插件每秒轮询 ctx.getUpstream()，新增内容才推送）
        ▼
src/media-sync.ts  fetch → File  → postMessage(structured clone 直接传 File，不做 base64)
        ▼
app/apps/web/src/bridges/canvas-host-bridge.ts  →  useProjectStore.importMedia(file)
        ▼
媒体库 items（缩略图 / filmstrip / 波形 / 元数据 / 工程持久化，与手工导入完全一致）
```

**要点**

- **零重复**：媒体去重按「内容指纹」；宿主页面刷新后插件会重推，但编辑器侧会记住
  `导入 id → 媒体库 item id`（localStorage，按工程 id 隔离）。只要媒体库里那个 item 还在就跳过；
  被用户手工删掉了才会重新导入 —— 既不会重复，也不会漏。
- **重生成即更新**：上游重新生成后内容指纹变化，会作为新素材再入一次媒体库（旧素材保留）。
- **支持批量图**：图片节点是「批量图」根节点时，`metadata.images[].content` 会一并导入。
- **失败有界**：单个素材最多尝试 3 次；读取失败会在控制台告警，并在节点左下角显示 6 秒临时提示。
- **不变的部分**：编辑器自身的导入按钮、拖拽导入、媒体库管理、剪辑/导出等能力完全不受影响。

---

## 六、界面行为（本次 UX 调整）

| 行为 | 说明 |
| --- | --- |
| **节点内不再有提示文字** | 移除了原先「点击节点上的『交互』按钮…」的遮罩提示（该提示本身也已失效：空内容节点始终可交互）。 |
| **使用时整节点高亮** | 当节点被**悬停 / 选中 / 编辑器获得焦点**时，整个节点出现一圈高亮描边 + 外发光（与画布选中态同一蓝色 `#2f80ff`）。焦点状态由 iframe 内 `bridges/canvas-host-bridge.ts` 回传（`focus` / `blur`）。 |
| **使用时隐藏宿主悬浮工具条** | 宿主那条「信息 / 删除 / 重载」悬浮工具条是对**所有节点统一渲染**的，插件无法从节点定义里去掉它。因此改为：**指针位于本节点内（即正在使用它）时**给 `<html>` 挂 `ic-openreel-inuse`，用插件 `css` 里的一条规则把它 `display:none`（只做视觉覆盖，**未改动任何宿主模块代码**）。触发条件刻意只取「指针在节点内」——若取「选中/焦点」，本节点被选中时会把**其它节点**的悬浮工具条也一起隐藏，属于会引出新问题的副作用。指针离开节点后规则立即失效，工具条恢复显示，仍可正常点「信息 / 删除」。 |
| **重载按钮** | 悬停节点时右上角出现一个**纯图标**重载按钮（无文字、带 tooltip）；插件工具条项也保留为图标形式作为兜底。 |

> 工具条选择器锁定 `z-[70].h-12`（只有 `canvas-node-hover-toolbar` 与 `canvas-selection-toolbar` 用这一组合，
> 不会命中 Agent 面板或节点下方面板）。若宿主将来调整这两个工具类，规则会静默失效、工具条恢复显示，
> 不会破坏任何功能。删除节点仍可通过节点右键菜单完成。

---

## 七、全中文化（运行时文本替换层）

OpenReel **没有 i18n 框架**，界面文案全部硬编码英文，且大量英文串同时被当作**逻辑值**使用
（混合模式 / 插值算法 / 缓动类型 / 导出编解码等枚举的取值就是显示文本）。
因此**不改动 `app/` 内任何源码**，而是在插件侧加了一层「运行时文本替换」：

```
iframe onLoad → src/i18n-zh.ts  installOpenReelZh(doc, win)
        │
        ├─ MutationObserver 观察 documentElement（含 <head><title> 与挂在 <html> 下的浮层/弹窗）
        ├─ 文本节点        → 先整串精确命中词典，未命中再走「组合串分词翻译」
        ├─ 展示属性        → placeholder / title / aria-label / aria-description / aria-placeholder
        │                     / aria-valuetext / aria-roledescription / data-tooltip / alt
        └─ input value     → type=button|submit|reset 的按钮文案
```

**要点**

| 项 | 说明 |
| --- | --- |
| **词典规模** | 约 **3371 条** `en → zh` 映射，覆盖面板 / 检查器 / 时间线 / 滤镜 / 转场 / 缓动 / 文字与 SVG 动画 / 粒子 / 模板 / 引导 / 导出预设 / 设备 / 素材 / 播放 / 字幕 / AI 对话 / MCP / 多机位 / 页面标题等。 |
| **组合串分词翻译** | 运行期拼接出来的串（如 `${n} clips`、`Exported 3 files successfully`、`Background color`）不会命中整串词典，改由一次性大正则按**长度降序最长优先**分词替换：`"5 clips" → "5 片段"`、`"Background color" → "背景 颜色"`。 |
| **不会误译素材名** | 单条词右侧带 `(?![A-Za-z0-9._-])` 边界；另用 `LOOKS_LIKE_FILENAME`（含 `.mp4/.png/.mov` 之类扩展名）兜底跳过，`Color.mp4` 这类文件名保持原样。 |
| **不改逻辑值** | 替换只发生在「渲染到 DOM 的文本/展示属性」上，不碰 React props、state、store、事件与任何比较分支，功能与原项目完全一致。 |
| **性能** | 结果进 Map 缓存（上限 4000 条）；实测 1000 次查询约 19ms，MutationObserver 增量处理，不影响编辑与播放。 |
| **关闭插件/不装载** | 该层只在插件 iframe 加载完成后注入；插件被「关闭」时不执行，编辑器回到原生英文界面。 |

> 若上游新增了词典未覆盖的英文文案，界面会保持英文显示——**不会报错、不会影响功能**，
> 只需往 `src/i18n-zh.ts` 的 `ZH_DICT` 补条目即可。

---

## 八、安装 / 关闭 / 卸载

打开画布「节点插件」管理器 → 「官方插件」列表可见 **OpenReel 视频编辑器**：

- **安装**：写入插件启用状态并加载 `web/public/plugins/openreel-video.js`
- **关闭**：开关关闭后节点不再渲染（插件代码不执行）
- **卸载**：移除该插件，已放置的节点不再有可用内容组件

插件已在官方注册表登记：`plugins/canvas/registry/build.mjs` 的 `OFFICIAL` 数组。

---

## 九、许可

OpenReel Video 为 MIT 许可，版权归 Augustus Otu and Contributors，原始仓库：
<https://github.com/Augani/openreel-video>。`app/` 内保留其原始 `LICENSE`。
