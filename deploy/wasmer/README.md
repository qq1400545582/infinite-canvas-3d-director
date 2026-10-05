# deploy/wasmer — 把 Infinite Canvas 前端发布到 Wasmer Edge

跟前端源码完全隔离：这里只放「打包清单 + 服务器配置」，不碰 `web/`，也不会被
`scripts/update-from-upstream.mjs` 的合并流程覆盖（已登记进 `second-dev/manifest.json`
的 `protected`）。

## 已部署

| 项 | 值 |
|---|---|
| 站点 | **https://infinite-canvas-3d-director.wasmer.app** |
| 管理台 | https://wasmer.io/apps/1400545582/infinite-canvas-3d-director |
| 应用 / 归属 | `infinite-canvas-3d-director` / `1400545582` |
| 包 | `1400545582/infinite-canvas-3d-director@0.1.0` |
| 首批状态 | app v1，已 active |

## 目录

| 文件 | 作用 |
|---|---|
| `wasmer.toml` | 打包清单：把 `../../web/dist` 映射进包（不拷贝），挂 `wasmer/static-web-server` |
| `app.yaml` | Wasmer Edge 应用定义（owner / name / package 已填好） |
| `settings/config.toml` | static-web-server 的配置，等价于仓库根 `nginx.conf` 的服务契约 |

## 用法

```bash
# 1) 构建前端产物
cd web && npm run build

# 2) 本地预览（注意必须带 --net，否则 WASIX 拿不到网络权限、起不来）
cd deploy/wasmer && wasmer run . --net      # → http://localhost:8080

# 3) 发布到 Edge（非交互 + 一并发布包）
cd deploy/wasmer && WASMER_TOKEN=<token> wasmer deploy --non-interactive --publish-package
```

token 在 https://wasmer.io/settings/access-tokens 生成；`wasmer whoami` 可确认登录身份。

## 首次部署踩到的两个 YAML 坑（都会直接报错，别浪费时间）

1. **纯数字的 owner 必须加引号。**
   `owner: 1400545582` 会被 YAML 解析成**整数**，`wasmer deploy` 直接报
   `error: No owner specified: use --owner XXX`（看上去像没写 owner）。
   写成 `owner: "1400545582"` 即可。`name` 同理建议加引号。

2. **`package` 不能写完整包名。**
   写 `package: 1400545582/infinite-canvas-3d-director` 虽然包名没错，但会被判为
   deprecated 行为并立刻中止：`error: deprecated deploy behaviour`。
   正确写法是 `package: .`（用同目录的 `wasmer.toml` 打包）。


## 服务契约对照（nginx → SWS）

| 契约 | nginx (`nginx.conf`) | 这里 (`settings/config.toml`) |
|---|---|---|
| SPA 深链回退 | `try_files $uri $uri/ /index.html` | `page404 = "./index.html"` ⚠️ 状态码是 404 不是 200 |
| `/config.js` 不缓存 | `location = /config.js` + `no-store` | `[advanced.headers] /config.js` → `no-store` |
| hash 资源长缓存 | 无（走默认） | `/assets/*`、`/*/assets/*`、`**/*.wasm` → `immutable` |
| wasm MIME | 由 mime.types 提供 | 显式 `application/wasm` |

## 四个已知限制（实测结论，别当成 bug 反复查）

1. **SPA 回退只有 404，没有 200。**
   Wasmer 官方预编译的 `wasmer/static-web-server`（1.1.0 / SWS 2.32.2）**没有编译
   `fallback-page` 特性**，把 `page-fallback` 写进 config 会被明确告警为 unsupported；
   该包全部 7 个版本都只有一个 `webserver` 入口，没有开了该特性的变体。
   所以只能用 `page404` 顶：深链刷新能正常渲染，但 HTTP 状态码是 404，
   搜索引擎不会收录深链。要拿 200 只能自建 WASI HTTP server 替换该依赖。

2. **只有 gzip，没有 brotli。**
   本地日志 `auto compression: enabled=true, formats=gzip`，线上实测响应头也是 `content-encoding: gzip`。
   带宽按 gzip 估，别按 br。

3. **本机的 `wasmer run --net` 有一个连接复用缺陷**（Windows 上的 WASIX 运行时）：
   同一条 TCP 连接上的**第二个请求永远不会被处理，且服务器不关闭连接**，
   于是浏览器复用连接后页面永久挂起（首个请求正常、后续全部 pending）。
   已在配置里用 `Connection: close`（`[advanced.headers] source = "**"`）绕开。

   **这条规则只为本地预览存在。** 线上 Edge 网关会把它覆盖回 `keep-alive`（实测线上响应头
   就是 `connection: keep-alive`），而且线上同一条连接上连发多个请求全部正常 —— 线上没有这个缺陷。

4. **本机到 `*.wasmer.app` 的吞吐只有 ~5–8KB/s**，首屏 1.25MB(gzip) 的入口包要几分钟。
   这是**这台机器到 Wasmer 边缘节点的链路问题，不是部署缺陷**。
   决定性对照：Wasmer 官方静态站 `static-website.wasmer.app` 从本机同样只有 ~8KB/s
   （199,636 字节用了 23.8s）。换到正常网络环境应按正常速度加载。

## 与其它部署形态的边界

- 画布内的**一键启动后端**（`/__canvas-agent/*`）在 Edge 上不存在：请求会被 SPA 回退
  接住，返回 HTML（不是 JSON），前端的 `probeLauncher()` 会据此提示「当前部署环境不支持」，
  不会空转也不会假成功。`canvas-agent` / `canvas-proxy` / 桌面壳都必须留在本机。
- 画布数据在 **IndexedDB（按 origin 隔离）**，换到 `*.wasmer.app` 等于打开一个空画布。
  搬家前先用内置同步（WebDAV）或导出功能迁移。

## 环境变量覆盖

`app.yaml` 的 `env:` 段可覆盖运行期配置；常用的有：

- `VITE_DESKTOP_DOWNLOAD_URL` — 该变量在**构建期**注入，不在这里生效；
  发布前在 `web/` 侧设好再构建。
