# 部署到 Cloudflare Pages（网页版画布）

本仓库的网页端是纯静态前端（数据落在浏览器 IndexedDB，AI 请求由浏览器直连用户自有渠道），
可以直接托管到 Cloudflare Pages，无需任何后端。

## 方式一：Git 集成（最简单，无需密钥）

1. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → 连接 GitHub 仓库 `infinite-canvas`。
2. 构建设置：
   - **构建命令**：`cd web && bun install && bun run build`
   - **构建输出目录**：`web/dist`
   - **根目录**：**仓库根目录**（不要设为 `web` —— vite 构建期会读取 `../VERSION` 与 `../CHANGELOG.md`，设错会构建失败）
   - **环境变量**（可选）：若使用 Pages 自带构建且需要 Bun，设 `BUN_VERSION=1.3.13`；本仓库 CI 用 `oven-sh/setup-bun` 固定版本，与此无关。
3. 保存并部署。`VITE_BASE` 保持默认 `/`。

## 方式二：GitHub Actions 自动部署

- 工作流见 `.github/workflows/cloudflare-pages.yml`。
- 在仓库 **Settings → Secrets and variables → Actions** 添加：
  - `CLOUDFLARE_API_TOKEN`（需 Pages 编辑权限）
  - `CLOUDFLARE_ACCOUNT_ID`
- 首次部署前在 Cloudflare 控制台手动创建 Pages 项目，名称 `infinite-canvas`，生产分支设为 `main`。
- 之后推送 `main` 即自动构建并部署。

## 关键注意事项（踩坑点）

- **不要**在构建产物根目录放 `404.html`：Cloudflare Pages 默认对无扩展名的未知路径回退到 `index.html`（SPA 回退）。放 `404.html` 反而会关掉该机制，导致 `/canvas/<id>` 刷新 404。（这与 GitHub Pages 行为正好相反——上游 `github-pages.yml` 里的 `cp index.html 404.html` 仅适用于 GH Pages，移植到 CF 时必须删除。）
- **不要**把 `web/public/openreel-video/_headers`、`web/public/openreel-video/_redirects` 提到产物根目录。它们含 `X-Frame-Options: DENY` 与 `COEP: require-corp`，是给 OpenReel 作为独立站点用的；提到根目录会废掉 OpenReel 的 iframe 嵌入并阻断 CDN 插件脚本加载。Cloudflare Pages 只读取**产物根目录**的 `_headers`/`_redirects`，嵌套子目录里的不生效，保持原样即可。
- 插件 bundle 已提交到 `web/public/plugins/*.js`，构建后由 `web/dist/plugins/index.json` 暴露。网页版会自动发现并**默认启用** 4 个自研插件：3D 导演台 / OpenReel / 白模预演台 / 分镜工作台。
- **自托管官方插件频道（P1a，推荐）**：画布「官方插件」标签默认走上游 `basketikun/infinite-canvas@plugins-dist`（9 个官方插件，且**不含** director-desk / clipshot）。为让 4 个自研插件也走"官方"标签并独立于上游，运行 `.github/workflows/publish-self-plugins.yml`（或打 `self-plugins-v*` 标签），它会把 `web/public/plugins/*.js` + `official-plugins.json` 强推到本仓库 `plugins-dist-self` 孤儿分支；再把前端环境变量 `VITE_PLUGIN_REGISTRY_URL` 指向 `https://cdn.jsdelivr.net/gh/<owner>/<repo>@plugins-dist-self/official-plugins.json` 即可。生成器见 `scripts/generate-plugin-registry.mjs`，其插件元数据须与各插件 `plugins/canvas/<id>/src/index.tsx` 的 `definePlugin` 保持一致。（注意：上游 `publish-plugins.yml` 是另一条构建 9 官方插件的流水线，二者互不影响。）
- 网页版与桌面端数据按浏览器 origin 隔离；跨设备/跨端迁移用「配置与用户偏好 → WebDAV」同步（双向合并，含媒体二进制）。
- 网页版缺的本机进程能力（一键启动后端、同步到 Codex、源码仓库在线更新）需配合桌面端或本机运行的 canvas-agent；装了桌面端的机器上，网页版借本机后端也可变全功能。
