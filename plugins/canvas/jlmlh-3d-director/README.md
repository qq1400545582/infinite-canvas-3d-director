# 3D 导演台节点插件（jlmlh-3d-director）

把独立的三维导演台应用 [jlmlh-3d-director](https://github.com/lkhxxx123/jlmlh-3d-director)
做成无限画布的**节点插件**：可在画布右上角「节点插件」管理器里随意**安装 / 关闭 / 卸载**，
而导演台的全部功能逻辑**保持原样不变**（模型导入、机位管理、时间线动画、截图导出等）。

## 为什么用 iframe 桥接（而非内联打包）

| 项 | 宿主画布 | 导演台应用 |
| --- | --- | --- |
| React | 19.2.5 | 18.3.1 |
| 三维渲染 | — | @react-three/fiber 8（仅支持 React 18）|

插件契约要求 React 为**宿主单例**（插件不得自带 React，`react`/`react-dom` 必须 external）。
而 R3F 8 在 React 19 下无法正常工作，若把导演台源码内联打进插件就会破坏其渲染逻辑。
因此这里采用 **iframe 嵌入**：导演台完整源码 vendor 在 `app/` 下（逻辑零改动），
本插件只负责把导演台以**同源 iframe** 放进节点内容区，并补齐宿主 ⇄ 导演台的 `postMessage` 桥接。

> 同源是关键：`app/src/editor/io/hostBridge.ts` 对入站消息做了 `event.origin === window.location.origin`
> 的校验，iframe 必须与宿主同域，否则导演台收不到会话/全景消息，宿主也收不到 ready/截图消息。

## 目录结构

```
jlmlh-3d-director/
├── app/                      # vendor 的 jlmlh-3d-director 完整源码（与官方**逐字节一致**，零改动）
│   ├── vite.config.ts        # 官方原文件（未改）；其 base 为 "./" 相对路径
│   ├── src/editor/io/hostBridge.ts   # 既有的宿主桥接协议（入站/出站消息）
│   └── public/models/...glb  # 人物模型等资源（按 base 解析）
├── src/index.tsx             # 薄桥接层：iframe + postMessage 桥接
├── build.mjs                 # 原样：把 src/index.tsx 打成 web/public/plugins/jlmlh-3d-director.js
├── build-app.mjs             # 新增：把 app/ 构建到 web/public/jlmlh-3d-director/
└── package.json
```

## 构建与部署

```bash
# 1) 安装依赖（首次）
cd plugins/canvas/jlmlh-3d-director/app && npm install
cd ../../../../web || true   # 视具体环境；核心是下面两步

# 2) 构建导演台应用 → web/public/jlmlh-3d-director/（同源静态资源）
cd plugins/canvas/jlmlh-3d-director && npm run build:app

# 3) 构建本插件桥接层 → web/public/plugins/jlmlh-3d-director.js
npm run build
```

- 第 2 步产物 `web/public/jlmlh-3d-director/` **不**在被 gitignore 的范围内，随仓库提交，
  运行时由宿主以 `/jlmlh-3d-director/` 同源托管。
- 第 3 步产物 `web/public/plugins/jlmlh-3d-director.js` 由插件 loader 自动发现
  （写入 `web/public/plugins/index.json`）。该目录被 gitignore，属本地构建产物。
- 纳入官方注册表：在 `plugins/canvas/registry/build.mjs` 的 `OFFICIAL` 中已登记本插件，
  CI 会把 `dist/*.js` 推到 `plugins-dist` 分支经 jsDelivr 分发。

### 关于 base：不要覆盖 `app/vite.config.ts`

官方 `app/vite.config.ts` 的 `base` 是 `"./"`（相对路径），**不要用 `--base` 去覆盖它**。
产物里的资源引用形如 `./assets/xxx.js`，浏览器相对文档 URL 解析为 `/jlmlh-3d-director/assets/xxx.js`，
与写死绝对路径等价，但在宿主部署到子路径（`VITE_BASE` 非根）时依然可用。
`build-app.mjs` 因此不传 `--base`，使 `app/` 保持与官方逐字节一致。

### ⚠️ iframe 入口必须写 `index.html`

插件里 iframe 的地址是 **`/jlmlh-3d-director/index.html?instanceId=...`**，不能写成
`/jlmlh-3d-director/`。Vite 开发服务器对 `public/` 子目录的「目录 + 斜杠」请求**不会**解析到
该目录下的 `index.html`，而是被宿主 SPA 兜底接管 —— iframe 里会载入宿主画布本身
（表现为节点内白屏或满屏画布）。显式带文件名在 dev 与生产静态托管下行为一致。

调试时若想单独打开导演台，请访问 `/jlmlh-3d-director/index.html`，不要用带斜杠的路径。

## 桥接协议（与 hostBridge.ts 对齐）

**宿主 → 导演台（iframe）**

| type | payload | 说明 |
| --- | --- | --- |
| `storyai:director-desk-session` | `{ instanceId, theme }` | 节点就绪后发送；导演台据此打开按 `instanceId` 隔离的场景存储，并套用主题 |
| `storyai:director-desk-panorama` | `{ edgeId, sourceNodeId, imageUrl, fileName }` | 把上游图片节点当作背景全景图导入导演台 |

**导演台 → 宿主（window.parent）**

| type | payload | 说明 |
| --- | --- | --- |
| `storyai:director-desk-ready` | — | 应用挂载完成并已注册 bridge 监听，宿主此刻回送 session |
| `storyai:director-desk-captures-sent` | `{ captures: [{ dataUrl, fileName }] }` | 截图/机位导出；宿主据此在画布右侧生成图片节点，并把最后一张写回本节点 metadata.content |
| `storyai:director-desk-close` | — | 关闭动作（宿主暂无需处理） |
| `storyai:director-desk-panorama-removed` | `{ edgeId, sourceNodeId }` | 导演台移除全景图时回传（宿主暂无需处理） |

消息均在 `event.origin === window.location.origin` 下收发（同源）。

## 关键行为

- **每节点场景隔离**：iframe URL 带 `?instanceId=<nodeId>`，导演台按 `instanceId` 在
  `localStorage` 中隔离场景；同一画布多个导演台节点互不影响。
- **主题**：宿主在 `<html class="dark">`，插件读 `document.documentElement.classList` 判断
  `dark`/`light`，通过 session 消息同步给导演台（挂载时确定一次）。
- **交互开关**：节点声明 `interactionToggle: true`，宿主自动加「交互 ⇄ 移动」开关。
  默认「移动」态下内容层 `pointer-events:none`，可直接拖动节点；切「交互」后导演台接收指针事件。
  未进入交互态时显示提示遮罩（不影响拖动）。
- **截图导出到画布**：导演台「发送到画布 / 导出」触发 `captures-sent`，宿主用 `ctx.applyOps`
  在节点右侧生成图片节点，并把末张截图写入本节点 `metadata.content`；`resource()` 据此把
  本节点作为上游图片资源输出，供下游节点引用。
- **上游全景**：若本节点上游连有图片节点，宿主在 ready 后发送 `panorama` 消息，导演台将其作为背景全景。

## 已知限制与宿主侧待定行为

- 明暗主题切换若发生在导演台已挂载之后，需重载节点（工具条「重载」）才会重新套用。
- 导演台应用 `app/` 源码保持 vendor 原样；如需升级，替换 `app/` 内容后重新 `npm run build:app`。
- **「模型库」需要外部资源包（与官方一致）**：`src/editor/modelLibrary/modelLibraryCatalog.ts`
  用 `import.meta.glob("../../../../模型库/**/*.fbx")` 读取外部目录，即模型库需放在
  `plugins/canvas/jlmlh-3d-director/模型库/`（与 `app/` 同级，形如
  `模型库/便利生活/xxx.fbx` + `模型库/便利生活/缩略图/xxx.png`）。官方仓库同样不含该目录，
  所以缺省状态下模型库面板为空——**不是功能缺失**。放入后重新 `npm run build:app` 即可。
- **导演台右上角「关闭」按钮（X）**：应用会向宿主发 `storyai:director-desk-close`，
  但「关闭」在画布节点语境下的语义由宿主定义（官方宿主是浮动面板）。当前插件**忽略**该消息，
  因此点 X 不会有任何反应。可选实现：删除本节点。
- **`storyai:director-desk-panorama-removed`**：用户在导演台移除全景背景时回传，携带 `edgeId`。
  当前插件**忽略**该消息，画布上对应的连线不会自动断开。可选实现：`applyOps([{ type: "delete_connections", ids: [edgeId] }])`。

完整的一致性核查记录见 [AUDIT.md](./AUDIT.md)。

## 本地运行排障（Windows + npm）

以下三条是接入时实际踩到的坑，均与插件无关，属宿主 `web/` 本地依赖安装问题：

1. **必须用 `--legacy-peer-deps` 装宿主依赖**

   `@ant-design/pro-components@3.0.0-beta.3` 声明 `antd@^5.11.2`，而项目锁 `antd@^6`，
   直接 `npm install` 会 ERESOLVE 失败：

   ```bash
   cd web && npm install --legacy-peer-deps
   ```

2. **npm 会漏装平台原生包（npm 可选依赖 bug）**

   现象：`vite dev` 报 `Cannot find module '@rollup/rollup-win32-x64-msvc'`，
   或 PostCSS 报 `Failed to load PostCSS config ... Cannot find module '../lightningcss.win32-x64-msvc.node'`。
   需按已安装版本补齐 win32 原生包，**必须一次性合并安装**（`--no-save` 单装会把上一个补装的包清掉）：

   ```bash
   cd web
   npm install --no-save --legacy-peer-deps \
     "@rollup/rollup-win32-x64-msvc@$(node -p "require('./node_modules/rollup/package.json').version")" \
     "lightningcss-win32-x64-msvc@$(node -p "require('./node_modules/lightningcss/package.json').version")" \
     "@tailwindcss/oxide-win32-x64-msvc@$(node -p "require('./node_modules/@tailwindcss/oxide/package.json').version")"
   ```

3. **lockfile 变化后 Vite 清 `.vite` 缓存可能被安全删除策略拦截**

   现象：`error when starting dev server: [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED]`。
   手动删掉依赖预打包缓存即可（该目录是纯缓存，删除无副作用）：

   ```bash
   rm -rf web/node_modules/.vite
   ```
