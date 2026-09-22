# 3D导演台

一个基于 React、Vite、Three.js 和 React Three Fiber 的 3D 分镜导演台。它适用于轻量级预演、镜头规划和场景摆位，支持在浏览器里搭建角色、机位、场景和全景背景，并通过关键帧动画让人物与镜头动起来，还能一键把整段动画导出为视频。

## 功能概览

- 导演视角 / 机位视角切换
- 内置8种不同的人物，20种不同的人物姿势
- 角色、群演、基础几何体和机位快速添加
- 本地 FBX / OBJ 模型导入，可自定义模型库
- 群众阵列，想多少人就可以多少人
- 全景图导入与背景调节
- 机位拍摄、截图记录和基础镜头管理
- 视口比例框、九宫格、平移 / 旋转 / 缩放控制
- **关键帧动画**：物体位移 / 旋转 / 缩放 + 镜头运镜（机位、注视点、视野 FOV）关键帧，旋转使用四元数 slerp 保证平滑过渡
- **时间轴**：播放 / 暂停、指针拖动逐帧预览、时长调整、打帧 / 删除 / 清空；面板高度可拖动调整（顶部手柄），关键帧轨道在面板内滚动
- **基础动作**：角色内置走路 / 跑步循环动作（真实步态曲线、左右对侧摆臂、跑步独立步频与屈膝曲线），支持速度 / 幅度调节与群体相位错开；动作之上可按关节叠加姿势偏移微调
- **姿势调节**：两级折叠分组（核心 / 左右臂 / 左右腿），20 种姿势预设一键应用
- **视频导出**：上帝视角或机位视角，WebCodecs 逐帧快速导出 MP4（固定分辨率、不随视口布局变形，导出速度远快于实时）
- 本地场景与关键帧状态持久化

## 界面截图

![项目截图](./images/new-01.png)

## 演示

机位视角下的关键帧运镜与时间轴 scrub 预览：

![演示](./video/8ef398c0-2967-4ce1-880d-02ae0af85d78.gif)

## 技术栈

- React 18
- Vite 6
- TypeScript
- Three.js
- @react-three/fiber
- @react-three/drei
- Zustand
- Vitest

## 项目结构

```text
src
├─ app/layout          # 顶层壳布局，组织画布、左右侧栏与底部时间轴
├─ editor/canvas       # Three.js / R3F 视口、画幅框、工具条、截图视图、回放覆盖
├─ editor/panels       # 左侧对象树、右侧属性面板、底部时间轴
├─ editor/store        # Zustand 状态管理、撤销、剪贴板、关键帧 actions
├─ editor/io           # 截图导出、视频导出、工程导入导出、宿主通信
├─ editor/loaders      # 本地模型与全景图导入
├─ editor/runtime      # 角色渲染、骨骼、姿势应用、播放状态与回放驱动
├─ editor/schema       # 数据结构、机位、视口、时间轴与插值定义
└─ styles              # 全局样式
```

时间轴、动作与视频导出相关的核心文件：

- `editor/schema/timeline.ts` — 时间轴数据模型与纯函数（物体 / 相机关键帧的插值、增删改）
- `editor/runtime/playbackStore.ts` — 播放状态（播放中、指针、时长、录制模式）
- `editor/runtime/PlaybackFrameDriver.tsx` — `useFrame` 推进指针
- `editor/runtime/ActiveCameraPlaybackSync.tsx` — 机位视角下用运镜轨道覆盖渲染相机
- `editor/runtime/playbackTransforms.ts` — 按 playhead 把关键帧插值与运镜应用到场景（预览与导出共用）
- `editor/canvas/PlaybackTransformSync.tsx` — 每帧调用上述共享逻辑驱动预览
- `editor/runtime/mannequin/motion.ts` — 走路 / 跑步关节曲线（纯函数，含速度 / 幅度 / 群体相位）
- `editor/panels/TimelinePanel.tsx` — 时间轴 UI（播放控制、关键帧编辑、视频导出按钮）
- `editor/io/videoExport.ts` — WebCodecs 逐帧渲染 + H.264 编码导出 MP4（MediaRecorder 实时录制作兜底）
- `editor/io/videoExportBridge.ts` — 把 R3F 渲染三件套（renderer / scene / camera）暴露给导出逻辑

## 本地开发

```bash
npm install
npm run dev
```

默认开发地址通常为：

```text
http://127.0.0.1:5173/
```

如果本机端口被占用，Vite 会自动顺延到下一个可用端口。

需要局域网访问（手机或其他设备）时：

```bash
npm run dev -- --host
```

> Windows 提示：
> - `vite.config` 已处理中文路径下 `server.fs.allow` 的盘符解析问题（避免 403 Restricted）。
> - 若 `npm install` 报 `@rollup/rollup-darwin-arm64` 平台不匹配，用 `npm install --force` 跳过——该包是 macOS 专用，Windows 不需要，rollup 会自动装载对应平台的二进制。

预览生产包：

```bash
npm run preview
```

默认预览地址通常为：

```text
http://127.0.0.1:4173/
```

## 常用操作

- 顶部可切换 `导演视角` 与 `机位视角`
- 左侧用于搜索、选择、分组查看场景对象，并支持可见性 / 锁定 / 删除
- 中央视口用于摆放场景、切换变换模式、添加角色和机位、导入资源与截图
- 右侧属性面板会根据当前选中对象自动切换为场景 / 角色 / 模型 / 摄像机编辑面板；选中摄像机时可直接编辑 位置 / 注视坐标 / FOV
- **角色动作与姿势**：角色面板「动作」标签用单选按钮切换 无 / 闲置 / 走路 / 跑步，可调速度与幅度；「姿势」标签按两级分组（核心 / 左右臂 / 左右腿）微调各关节，动作开启时滑杆显示「动作当前值 + 偏移」
- **底部时间轴**：
  - 选中对象或相机 → 用 gizmo 或右侧面板摆好状态 → 指针移到某时刻 → 点「在指针处打关键帧」
  - 拖动指针可逐帧预览所有对象在该时刻的姿态
  - 点关键帧方块可选中（变橙）以便更新 / 删除；方块右上角的 × 可直接删除单帧
  - 「清空全部」一键清除所有关键帧（可撤销）
  - 顶部手柄可上下拖动调整面板高度（会记住）；删除对象时其关键帧轨道一并清理
  - 「导出视频·上帝视角 / 机位视角」逐帧快速导出整段动画为 MP4

## 快捷键

- `Ctrl/Cmd + C`：复制当前选中对象
- `Ctrl/Cmd + V`：粘贴复制对象
- `Ctrl/Cmd + Z`：撤销最近一次操作
- `Delete / Backspace`：删除当前选中对象

## 关键帧与视频导出说明

- **物体关键帧**：记录位移 / 旋转 / 缩放，位移与缩放帧间线性插值，旋转使用四元数球面插值（slerp），确保转身等动作沿最短路径平滑过渡。
- **镜头运镜关键帧**：记录机位位置、注视点 target、视野 FOV；仅 `manual`（手动坐标）相机支持打运镜关键帧，锁定物体的相机（`targetMode = object`）不支持。
- **编辑与预览**：暂停态下用 gizmo 或右侧属性面板编辑对象（被拖对象不会被回放覆盖）；拖指针 scrub 实时预览各时刻姿态（机位视角下镜头同步跟随）；点播放看连续动画。
- **视频导出（WebCodecs 快速路径）**：不实时录屏，而是按 30fps 逐帧推进时间轴离线渲染并编码为 H.264 MP4——导出 10 秒动画约 1~3 秒完成，逐帧时间精确、结尾不丢帧。导出分辨率固定（按画幅比例、短边 720），不随视口布局（如时间轴拖高）变形；导出完自动恢复视角与指针。
- **视频导出（兜底路径）**：浏览器不支持 WebCodecs 时回退 `MediaRecorder` 实时录制（优先 MP4，其次 WebM），耗时 = 视频时长。
- **动作与姿势分层**：基础动作（走路 / 跑步）为关节基础层，姿势滑杆写入的是叠加偏移；切换动作时姿势自动重置为站立基础态，删除对象时其时间轴轨道一并清理。

## 数据与嵌入

- 当前场景、本地模型库与关键帧都会写入浏览器 `localStorage`
- 工程数据为 `version: 2`，含 `timeline` 字段（物体轨道 `tracks` + 相机运镜轨道 `cameraTracks`）；导入旧 v1 工程会自动迁移、补齐空时间轴
- 支持导出工程 JSON，也支持通过文件重新导入
- 支持“保存最近工程 / 恢复最近工程”
- 组件已包含宿主页面通信桥，适合嵌入到更大的创作工作台中

## Electron 桌面版打包

项目支持打包为 Windows 桌面应用（Electron + NSIS 安装包）。

一键打包：

```bash
build-electron.bat
```

或手动分步执行：

```bash
npm install
npm run build
npx electron-builder --win
```

打包产物位于 `release/` 目录：

- `故事AI导演工作台 Setup x.x.x.exe` — NSIS 安装包（推荐分发）
- `win-unpacked/` — 免安装版，整个文件夹拷走即可运行

> 打包脚本已配置 npmmirror 镜像加速 Electron 和 electron-builder 二进制下载。

## 构建与测试

构建：

```bash
npm run build
```

测试：

```bash
npm test
```

最近一次核对结果：

- `npm run build` 可通过
- 构建阶段会出现少量 Vite 警告：部分模型库缩略图 URL 会保留到运行时解析，同时主包体积超过默认 chunk 警告阈值
- `npm test` 含时间轴插值、动作步态曲线、视频导出、姿势 / 动作面板交互等用例（397 个）；剩余 `8` 个既有失败用例（模型库面板、视口画幅 / 轴向命中区、坐标输入拖柄、取景器缩放、个别姿势预设）保持不变，未引入回归

## 开源说明

- 本仓库以源码演示为主，适合继续扩展为更完整的 3D 导演工具。
- 当前版本保留内置角色能力，并支持通过界面导入本地模型与全景图。
- 若你基于本项目继续发布，请自行确认新增模型、贴图和场景素材的分发许可。

## License

MIT
