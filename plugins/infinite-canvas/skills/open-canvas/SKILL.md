---
name: open-canvas
description: 打开 Infinite Canvas 在线或本地画布，并自动连接本地 Canvas Agent。用户要求打开、启动、进入或使用 Infinite Canvas 画布时使用。
---

# Open Infinite Canvas

默认打开在线版。只有用户明确要求使用本地项目时，才启动本地前端。

## 在线版

1. 启动本地 Canvas Agent 并保持运行：

```bash
npx -y @basketikun/canvas-agent@latest
```

2. 从启动输出取得 `Local URL` 和 `Connect token`。

3. 在 Codex 右侧浏览器打开：

```text
https://canvas.best/canvas?mode=new#agentUrl=<Local URL>&agentToken=<Connect token>&source=<平台标识>
```

## 本地版

1. 在 Infinite Canvas 项目中启动前端，并使用 Vite 输出的 `Local` 地址：

```bash
cd web
bun install
bun run dev
```

2. 启动本地 Canvas Agent：

```bash
npx -y @basketikun/canvas-agent@latest
```

3. 从启动输出取得 `Local URL` 和 `Connect token`，在 Codex 右侧浏览器打开：

```text
<Vite Local 地址>/canvas?mode=new#agentUrl=<Local URL>&agentToken=<Connect token>&source=<平台标识>
```

## 平台标识（source）

画布可以被任意支持 MCP 的平台打开，不限于 Codex。打开时在 fragment 里带上 `source=<平台标识>`，画布顶栏就会显示打开它的平台名；不带则显示中性的「本地 Agent」。

| 平台 | source |
| --- | --- |
| Codex | `codex` |
| ZCode | `zcode` |
| DeepSeek Harness | `dsh` |
| WorkBuddy | `workbuddy` |
| Trae | `trae` |

其它平台用各自的小写工具名即可，未登记的标识会原样显示（最长 24 个字符）。

## MCP 与连接地址

插件在新的 Codex 任务中加载时会自动启动 `npx -y @basketikun/canvas-agent@latest mcp`。这个 MCP 进程负责提供画布工具，不提供网页连接服务；
上面启动的普通 Canvas Agent 负责提供 `Local URL` 和 `Connect token`。两个进程读取同一份本地配置，因此不需要用户手动填写地址或 token。

## 打开模式

用户没有明确指定打开方式时，始终使用 `mode=new` 新建画布。只有用户明确要求时才替换为：

- 最近画布：`mode=recent`
- 自己选择：`mode=choose`
