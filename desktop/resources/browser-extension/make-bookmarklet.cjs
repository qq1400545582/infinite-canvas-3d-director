#!/usr/bin/env node
/**
 * 生成「发送到画布」书签小工具页面。
 *
 * 读取本机 Canvas Agent 配置（地址 + Token），把 bookmarklet-src.js 压成一行并内嵌，
 * 产出 bookmarklet.html：打开它，把页面里的链接拖到书签栏即可（跨浏览器通用）。
 *
 * 只读取 ~/.infinite-canvas/canvas-agent.json，不写入任何配置。
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const here = __dirname;
const configFile = path.join(os.homedir(), ".infinite-canvas", "canvas-agent.json");

if (!fs.existsSync(configFile)) {
    console.error("未找到 " + configFile + "，请先在画布里点一次「一键启动 Canvas Agent」。");
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(configFile, "utf8"));
const base = String(config.url || "http://127.0.0.1:17371").trim().replace(/\/+$/, "");
const token = String(config.token || "").trim();
if (!token) {
    console.error("配置里没有 token，请先启动一次 Canvas Agent。");
    process.exit(1);
}

// 压成单行的书签脚本：去掉整行注释与缩进换行，再转义进 href。
const source = fs
    .readFileSync(path.join(here, "bookmarklet-src.js"), "utf8")
    .replace(/__TOKEN__/g, token)
    .replace(/__BASE__/g, base)
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s{2,}/g, " ");

const href = "javascript:" + encodeURIComponent("(function(){" + source + "})();");
const escaped = href.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>发送到无限画布 · 书签小工具</title>
<style>
  body { max-width: 760px; margin: 0 auto; padding: 32px 24px; font: 400 14px/1.8 -apple-system, "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif; color: #1f1f1f; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  p.sub { color: #6b7280; margin: 0 0 24px; font-size: 13px; }
  .link { display: inline-block; padding: 12px 20px; border-radius: 10px; background: #111827; color: #fff; text-decoration: none; font-weight: 500; cursor: grab; }
  .card { border: 1px solid #eee; border-radius: 12px; padding: 16px 18px; margin: 18px 0; background: #fafafa; }
  code { background: #fff; border: 1px solid #e5e7eb; border-radius: 4px; padding: 1px 5px; font-size: 12.5px; }
  ol { padding-left: 22px; }
  textarea { width: 100%; height: 120px; box-sizing: border-box; font: 12px/1.5 ui-monospace, Menlo, Consolas, monospace; border: 1px solid #d1d5db; border-radius: 8px; padding: 8px; }
  .warn { color: #b45309; }
</style>
</head>
<body>
  <h1>发送到无限画布 · 书签小工具</h1>
  <p class="sub">跨浏览器通用（含装不了扩展的浏览器）。Token 已内嵌在本页，请勿外传。</p>

  <div class="card">
    <p><strong>① 把下面的按钮拖到浏览器的书签栏</strong>（大多数浏览器按 Ctrl+Shift+B 可显示书签栏）</p>
    <p><a class="link" href="${escaped}" onclick="return false;">发送到画布</a></p>
  </div>

  <div class="card">
    <p><strong>② 使用</strong></p>
    <ol>
      <li>打开画布页面，并确认智能体已连接本机 Canvas Agent；</li>
      <li>在任意网页点一下这个书签，进入「拾取模式」；</li>
      <li>鼠标移到图片 / 视频上会高亮，点击即发送，可连续发送多个；</li>
      <li>按 <code>Esc</code> 或再点一次书签退出。</li>
    </ol>
    <p class="warn">说明：知乎、GitHub 等 CSP 严格的站点会拦截书签脚本，这类站点请用同目录下的浏览器扩展（扩展不受页面 CSP 限制）。</p>
  </div>

  <div class="card">
    <p><strong>如果拖拽不方便，可手动新建书签，把下面这段填进「网址」</strong></p>
    <textarea readonly>${escaped.replace(/<\/textarea>/gi, "&lt;/textarea&gt;")}</textarea>
  </div>
</body>
</html>
`;

const out = path.join(here, "bookmarklet.html");
fs.writeFileSync(out, html, "utf8");
console.log("已生成：" + out);
console.log("Agent 地址：" + base + "（Token 已内嵌）");
