# 二次开发分离层（second-dev）

本目录把「相对上游 `basketikun/infinite-canvas` 的二次开发内容」显式声明出来，
让在线更新可以**只更新上游代码、不碰二开内容**，并在更新后自动校验二开是否完好。

## 文件

| 文件 | 作用 |
| --- | --- |
| `manifest.json` | 二开清单：保护路径、忽略路径、合并策略、校验断言、更新后重建步骤 |

## 二开内容分三类

1. **新增（protected）** —— 完全属于二开的新文件/目录，更新时一律不读不写：
   - `plugins/canvas/jlmlh-3d-director/`、`plugins/canvas/openreel-video/`（两个节点插件）
   - `web/public/jlmlh-3d-director/`、`web/public/openreel-video/`、`web/public/plugins/`（同源托管产物）
   - `web/src/pages/expert-library/`（专家库模块）
   - `web/src/lib/agent/composer-callables.ts`、`web/src/lib/canvas/plugin-manager-tabs.ts`（宿主扩展点注册表）
   - `scripts/`、`second-dev/`（更新引擎与清单自身）

2. **侵入（intrusive）** —— 二开改动过的上游文件。数量很少（13 个），且以**纯追加**为主
   （新增 import、路由项、i18n 命名空间、扩展点调用、插件登记项）：
   `.gitignore`、`CHANGELOG.md`、`docs/content/docs/progress/pending-test.mdx`、
   `plugins/canvas/registry/build.mjs`、`web/package-lock.json`、
   `web/src/components/agent/agent-chat-prompt-input.tsx`、
   `web/src/components/canvas/canvas-create-menus.tsx`、
   `web/src/components/canvas/canvas-plugin-manager-modal.tsx`、
   `web/src/constant/navigation-tools.ts`、`web/src/i18n/locales/{zh-CN,en-US}.ts`、
   `web/src/lib/canvas/plugin-loader.ts`、`web/src/router.tsx`。
   更新时按 `base(基线版本) / ours(本地) / theirs(上游新版)` 三方合并，**冲突一律保留本地**。

3. **其余（clean）** —— 上游文件且本地未改，直接覆盖为上游新版。

## 更新方式

```bash
# 预演：只报告影响面，不写任何文件
node scripts/update-from-upstream.mjs

# 实际更新
node scripts/update-from-upstream.mjs --apply

# 回滚到更新前
node scripts/update-from-upstream.mjs --rollback
```

也可以直接在网页的「版本更新」弹窗里点「预演影响面 / 立即更新 / 回滚」——
开发服务在 `/__online-update/*` 暴露了对应接口（仅本机可访问）。

## 安全保证

- **零 git 依赖**：更新走 HTTPS 归档下载，不依赖 `.git` 是否完好、也不需要 `git` 命令；
  基线版本快照按 `baseVersion` 从 tag 下载，不依赖本地提交历史。
- **先备份后写入**：所有被覆盖/删除的文件都先复制到 `.update-backup/<时间戳>/`，可一键回滚。
- **写后校验**：按 `manifest.json` 的 `assertions` 校验二开文件、关键标记（路由、导航、i18n、
  扩展点、插件登记）与目录文件数；任一项不通过即**自动回滚**。
- **自动重建**：更新后按 `postApply` 重新构建两个节点插件产物（产物被 gitignore，不重建会失效）。

## 维护须知

- 新增二开文件时，若它落在新的目录下，请把该目录加入 `protected`。
- 更新成功后 `baseVersion` 会自动推进到新版；`--rollback` 会一并还原它。
- 上游若改了某个侵入文件的重叠区域，更新后会在报告里列出（保留本地版本），
  需要人工判断是否把上游那处改动补进二开代码。
