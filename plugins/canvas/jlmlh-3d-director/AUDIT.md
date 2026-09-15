# 一致性审计报告：3D 导演台插件 vs 官方 jlmlh-3d-director

审计时间：2026-09-16
官方源：`github.com/lkhxxx123/jlmlh-3d-director` master 分支（下载 zip 后逐文件比对）
被审对象：`plugins/canvas/jlmlh-3d-director/app/`（vendor 源码）+ `src/index.tsx`（宿主桥接层）

---

## 一、结论速览

| 维度 | 结论 | 证据 |
| --- | --- | --- |
| 应用源码是否与官方一致 | ✅ **118 / 118 文件逐字节一致，零内容差异** | 全量 MD5 比对（CRLF/BOM 归一化后） |
| 功能模块是否被裁掉 | ✅ 全部保留 | 构建产物功能标记 + 数据级核查（20/20 姿态预设） |
| 是否残留 Electron 依赖 | ✅ src 内无任何 Electron API 调用 | 全局检索 `window.electron` / `ipcRenderer` / `electronAPI` = 0 命中 |
| 宿主 ⇄ 应用协议是否对接完整 | ⚠️ 出向 2/2 完整，入向 2/4（`close`、`panorama-removed` 未处理） | 协议矩阵见第四节 |
| 外部资源（模型库） | ⚠️ 与官方同状态：需外部目录，缺省为空 | `import.meta.glob` 路径分析 |

**一句话**：导演台**应用自身的功能逻辑与官方 100% 一致**，没有任何一处被改写或裁剪；
差异只存在于「宿主侧如何响应应用消息」——这部分是宿主自行定义的，官方源码并未规定。

---

## 二、源码比对：118 / 118 逐字节一致

方法：下载官方 master zip，按相对路径逐一比对内容（忽略 CRLF/LF 与 BOM 差异），
排除双方都跳过的 `images/ video/ release/ node_modules/ dist/` 等媒体与构建产物。

```
official files compared : 123
vendored files compared : 118
files present OFFICIAL but MISSING in vendor : 5   ← 均为独立打包文档/启动脚本
files in vendor but NOT in official           : 0   ← 我们没有往 app/ 里加任何文件
files PRESENT but CONTENT DIFFERS             : 0
byte-identical                                : 118 / 118
```

### 未 vendor 的 5 个文件（均不影响功能）

`使用说明.txt`、`双击启动.bat`、`快速启动说明.txt`、`打包说明.txt`、`简单打包方案.txt`

内容经核实全部是**桌面独立版的打包/启动说明**（"如何打包成 exe"、"Electron 下载失败怎么办"、
"双击启动.bat 用 serve 起 dist"）。它们不是应用代码，对插件形态无意义，
且 `.bat` 文件放进仓库容易被安全扫描误报，因此有意排除。

### 审计过程中修正的一处真实偏差

**我曾误判官方仓库"缺少 vite.config.ts"，并写入了自己的 17 行版本覆盖了官方的 27 行配置。**
本次比对发现后已还原为官方原文件（MD5 校验一致 `F6083756293C40F88FDF7EC737F88F81`）。
被我丢掉的三项配置已恢复：

| 官方配置项 | 作用 | 丢失后果 |
| --- | --- | --- |
| `assetsInclude: ["**/*.fbx", "**/*.obj"]` | 让 FBX/OBJ 可作为资源被 import | 一旦放入模型库，构建会失败 |
| `server.fs.allow` | 开发服务器放行 `../模型库` | 仅影响 dev |
| `test`（vitest + jsdom + setup） | 测试配置 | `npm test` 在 app/ 下会失败 |

同时移除了 `build-app.mjs` 里多余的 `--base /jlmlh-3d-director/` 覆盖：
官方配置用的是 `base: "./"` 相对路径，在 `/jlmlh-3d-director/index.html` 下会正确解析为
`/jlmlh-3d-director/assets/xxx.js`，与绝对路径等价，且在宿主部署到子路径时更稳健。

---

## 三、构建产物功能核验（功能有没有被打包进去）

产物：`web/public/jlmlh-3d-director/`，2222 modules transformed，
`index-CC_RnmZZ.js` 1,426,363 B / `index-xghp-3tj.css` 61,059 B / `models/ue-mannequin-retopology.glb` 750,464 B。

| 功能 | 源码命中 | 产物命中 | 结论 |
| --- | --- | --- | --- |
| 模型库（外部 FBX） | 26 | 9 | ✅ |
| 关键帧动画 | 20 | 13 | ✅ |
| 机位/相机 | 28 | 22 | ✅ |
| 全景背景 | 23 | 18 | ✅ |
| 行走/奔跑循环 | 1 | 1 | ✅ |
| 截图 / 发送到画布 | 27 | 21 | ✅ |
| 视频录制（WebCodecs） | 12 | 5 | ✅ |
| MP4 封装 | 7 | 8 | ✅ |
| FBX / OBJ / GLB 导入 | 9 | 50 | ✅ |
| 撤销 / 重做 | 1 | 1 | ✅ |

**数据级核查（更能证明功能完整）**：`mannequinPosePresets.ts` 中
**20 个姿态预设的 id 与 label，20/20 全部出现在产物中**——说明姿态库这类大数据模块确实被完整打进去了。

> 说明：审计中也出现过一个假阳性——`姿态` 在源码命中 2 次但产物为 0，
> 核查后确认那 2 处都在 `motion.ts` 的**注释**里，压缩时被剥离，不是功能丢失。

---

## 四、桥接协议对接矩阵

协议定义在 `app/src/editor/io/hostBridge.ts` 与 `src/App.tsx`（均为官方原文件）。
所有消息都在 `event.origin === window.location.origin` 下收发——这也是必须同源 iframe 的原因。

**应用 → 宿主（4 种）**

| 消息 | 触发点 | 本插件处理 | 状态 |
| --- | --- | --- | --- |
| `storyai:director-desk-ready` | App 挂载 | 回送 session +上游全景 | ✅ |
| `storyai:director-desk-captures-sent` | 截图"发送到画布" | `applyOps` 建图片节点 + 写回 `metadata.content` | ✅ |
| `storyai:director-desk-close` | 点击右上角 X | **忽略** | ⚠️ 点 X 无反应 |
| `storyai:director-desk-panorama-removed` | 移除全景背景 | **忽略** | ⚠️ 画布连线不会自动断开 |

**宿主 → 应用（2 种）**

| 消息 | 应用侧处理 | 本插件 | 状态 |
| --- | --- | --- | --- |
| `storyai:director-desk-session` | `openScopedScene(instanceId)` + 套用主题 | 就绪后发送，带 `instanceId` 与主题 | ✅ |
| `storyai:director-desk-panorama` | `addImportedAsset({kind:"panorama"})` | 上游图片节点作为背景导入 | ✅ |

### 两处未处理消息的性质

这两条都是**"宿主该做什么"由宿主定义**的信号，官方源码并没有规定宿主行为
（官方宿主是浮动面板，我们是画布节点，语义本就不同），因此不属于"功能逻辑被改"：

1. **`close`** — 官方宿主里是"关闭浮动面板"；在画布节点语境下最贴近的等价行为是**删除本节点**。
   因删除不可逆，当前保持忽略，X 按钮暂无反应。
2. **`panorama-removed`** — 回传 `edgeId`，语义是"导演台里已移除这块全景，宿主可以断开连线了"。
   可选实现：`ctx.applyOps([{ type: "delete_connections", ids: [edgeId] }])`。

---

## 五、模型库（外部资源，与官方同状态）

`src/editor/modelLibrary/modelLibraryCatalog.ts` 用

```ts
import.meta.glob("../../../../模型库/**/*.fbx", ...)
```

读取外部模型目录。相对 `app/src/editor/modelLibrary/` 上溯四级，即
**模型库需放在 `plugins/canvas/jlmlh-3d-director/模型库/`（与 `app/` 同级）**，
目录形如 `模型库/便利生活/xxx.fbx` + `模型库/便利生活/缩略图/xxx.png`。

官方仓库同样不包含该目录（它是独立资源包），所以**缺省状态下模型库面板为空，这不是功能缺失**。
构建时出现的 `new URL("../../../../模型库/...") doesn't exist at build time` 警告即来源于此，属预期。
放入资源包后重新 `npm run build:app` 即可启用——此时官方配置的 `assetsInclude` 就是必需的
（这也是必须还原官方 vite.config.ts 的原因之一）。

---

## 六、复现本次核查

```bash
# 1) 下载官方源码并逐文件比对（输出 [A]缺失 [B]多余 [C]差异）
python _diff.py        # 见报告脚本：比对 zip 与 app/ 的 MD5

# 2) 构建产物功能标记核查
python _feature_check.py

# 3) 姿态/预设数据级核查
python _data_check.py
```

快速人工复核：

```bash
# app/ 是否与官方一致（应无输出）
diff -r app/src <官方>/src
```
