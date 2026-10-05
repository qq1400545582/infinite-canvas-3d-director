#!/usr/bin/env node
// 打印本机 Canvas Agent 的连接地址与 Token（供浏览器扩展 / 书签小工具填写）。
//
// 只读本机配置文件 ~/.infinite-canvas/canvas-agent.json，不做任何写入，也不改动 Agent 状态。
const fs = require("fs");
const os = require("os");
const path = require("path");

const file = path.join(os.homedir(), ".infinite-canvas", "canvas-agent.json");
if (!fs.existsSync(file)) {
    console.error("未找到配置文件：" + file);
    console.error("请先在画布里点一次「一键启动 Canvas Agent」，成功连接后再来取 Token。");
    process.exit(1);
}

let config;
try {
    config = JSON.parse(fs.readFileSync(file, "utf8"));
} catch (error) {
    console.error("配置文件解析失败：" + error.message);
    process.exit(1);
}

const url = String(config.url || "").trim() || "http://127.0.0.1:17371";
const token = String(config.token || "").trim();
if (!token) {
    console.error("配置里没有 token，请先启动一次 Canvas Agent。");
    process.exit(1);
}

console.log("Canvas Agent 地址：" + url);
console.log("Token            ：" + token);
console.log("");
console.log("把上面两行填进浏览器扩展的设置页（或用它生成书签小工具）。");
