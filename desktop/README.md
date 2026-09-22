# Infinite Canvas 桌面壳（P2）

把 `web/` 前端作为「一份前端」通过本机 HTTP 服务（**固定 127.0.0.1**）加载到 Electron WebView，从而：

- **网页版全功能原样可用**：画布、4 个自研插件、生图/生视频/文本/音频、WebDAV 同步全部不变；
- **补齐本机进程能力**：一键启动 canvas-agent（`/__canvas-agent/start|status|stop`）、同步 Codex（`/__canvas-agent/sync-codex`）、三层更新（`/__layer-update/*`）——这些接口由本机服务接住，**web/ 运行时零改动**（直接复用 `web/vite-plugins/canvas-agent-launcher.ts` 中间件）；
- **离线可用**：内置 `web/dist` 作为回退，断网也能打开并编辑；
- **三层更新**（P3）：插件刷新即最新、前端增量覆盖层、桌面壳 electron-updater。

## 关键约束（务必遵守）

1. **必须用 `127.0.0.1` 而非 `localhost`**：二者是不同源，差一个字符就要重迁 IndexedDB 数据。固定端口默认 `3000`（与 web 开发服务一致，可零成本继承本地数据），可用环境变量 `CANVAS_DESKTOP_PORT` 覆盖。
2. **不设置 COOP/COEP**：保持 `crossOriginIsolated === false`，与现有 nginx 部署一致（openreel 维持单线程，非回归）。
3. **web/ 不被桌面端重编译**：renderer 不经 electron-vite 构建，只把 `web/dist` 拷到 `resources/web-dist` 随包分发。
4. **桌面端页面 origin 是 `http://127.0.0.1:PORT`**：因此连本机 agent（127.0.0.1:17371）**不需要 Chrome LNA 授权**（LNA 只在公网页连本机时才触发）。

## 目录结构

```
desktop/
  package.json            # 依赖 + electron-builder 打包配置（publish: github）
  electron.vite.config.ts # 只构建 main + preload
  tsconfig.json
  empty.html              # renderer 占位（不使用）
  src/
    main.ts               # 入口：起本机 HTTP 服务 + 创建窗口 + 下载/外链处理
    server.ts             # 静态服务（覆盖层优先回退内置 dist）+ Connect 中间件链
    agent-handler.ts      # 用「假 server」提取 web/vite-plugins/canvas-agent-launcher 中间件
    updater.ts            # 三层更新 HTTP 接口 + 覆盖层下载/校验/原子切换
    auto-update.ts        # 第③层：electron-updater 壳更新
    preload.ts            # 暴露 window.__INFINITE_CANVAS_DESKTOP__ = true
  scripts/build-web.mjs   # install + build web + 生成 manifest + 拷贝到 resources/web-dist
  resources/web-dist/     # （gitignore）打包时内置的 web 前端
```

## 开发 / 构建 / 打包

```bash
cd desktop
npm install                 # 安装 electron / electron-vite / electron-builder / electron-updater

# 用已存在的 web/dist 直接起桌面壳（开发，需先在本仓库根构建 web）
npm run dev

# 一键构建 web 前端 + 拷贝到 resources/web-dist（CI / 打包前）
npm run build:web

# 构建桌面壳（main/preload）
npm run build

# 完整打包（先 build:web 再 build 再用 electron-builder 出安装包）
npm run package
```

## 三层更新配置

- **前端远程 manifest 地址**：设置环境变量 `CANVAS_UPDATE_MANIFEST_URL`，指向你发布的 `build-manifest.json`
  （例如 `https://<你的CF Pages>/build-manifest.json`）。桌面端在「版本」面板检测前端新版本，只下载 sha256 变化的文件到
  `userData/frontend-overlay/`，**下次启动生效**（离线回退内置 dist）。
- **桌面壳更新**：`package.json` 的 `build.publish` 已配置 GitHub Releases，打 Release 后桌面端自动检测并提示重启安装。
- **插件更新**：同源 `/plugins/*.js`，刷新即最新，无需壳更新。

## 已知注意事项

- openreel 的 Service Worker 是 cache-first 且 `CACHE_NAME` 固定；覆盖层更新 `/openreel-video/*` 时，本机服务已自动把覆盖层里的 `sw.js` 的缓存名 bump 为 `openreel-v2-overlay-<version>`，避免命中旧缓存。
- 导出 / 下载走系统下载目录（`session.on("will-download")`）；外链（非本机 origin）转系统浏览器。
- C 盘空间紧张时，先确保 `web/dist` 已构建（约 65MB），桌面壳本身增量不大，但首次 `npm install` 会拉 electron 二进制（约 100MB+），请预留空间。
