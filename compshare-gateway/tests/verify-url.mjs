/**
 * 用画布真实 buildApiUrl 验证「网关地址 → 画布实际请求 URL」。
 *
 * 关注点只有一个：不能拼出 `/v1/v1/...`（这是接入实例最常见的失败方式）。
 * 真实 buildApiUrl 依赖 withLocalProxy → 依赖 zustand store，这里用可控桩替换，
 * 但被测的 buildApiUrl 本身是源码原文，不是复刻。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const esbuild = (await import(pathToFileURL(path.join(root, "web/node_modules/esbuild/lib/main.js")).href)).default;
const source = fs.readFileSync(path.join(root, "web/src/stores/use-config-store.ts"), "utf8");

const start = source.indexOf("export function buildApiUrl");
if (start < 0) throw new Error("use-config-store.ts 里找不到 buildApiUrl");
let depth = 0;
let end = -1;
for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
        depth -= 1;
        if (depth === 0) { end = i + 1; break; }
    }
}
if (end < 0) throw new Error("buildApiUrl 未闭合");
const fnSource = source.slice(start, end);

const out = await esbuild.transform(
    `function withLocalProxy(url) { return url; }\n${fnSource}\nmodule.exports.buildApiUrl = buildApiUrl;`,
    { loader: "ts", format: "cjs", target: "es2022" },
);
const m = { exports: {} };
new Function("module", "exports", out.code)(m, m.exports);
const { buildApiUrl } = m.exports;
if (typeof buildApiUrl !== "function") {
    console.error("转译失败：buildApiUrl 不是函数\n" + out.code);
    process.exit(2);
}

const gatewayBases = [
    "https://8000-uf-abc123.pod.compshare.cn",     // 优云智算实例域名形态
    "http://127.0.0.1:8000",                        // 实例内自测
    "https://8000-uf-abc123.pod.compshare.cn/",     // 带尾斜杠
    "https://8000-uf-abc123.pod.compshare.cn/v1",   // 误把 /v1 填进 baseUrl
    "https://8000-uf-abc123.pod.compshare.cn/v1/",  // 误填 /v1 且带尾斜杠
];

let failed = 0;
for (const base of gatewayBases) {
    const results = ["/models", "/images/generations", "/images/edits", "/audio/speech", "/videos"]
        .map((p) => buildApiUrl(base, p));
    const bad = results.filter((u) => u.includes("/v1/v1"));
    const ok = bad.length === 0;
    if (!ok) failed += 1;
    console.log(`  ${ok ? "PASS" : "FAIL"}  baseUrl=${base}`);
    console.log(`        /images/generations → ${results[1]}`);
    if (!ok) console.log(`        出现 /v1/v1：${bad.join(", ")}`);
}

console.log(`\nbuildApiUrl：${gatewayBases.length - failed}/${gatewayBases.length} 种地址形态无 /v1/v1`);
process.exit(failed ? 1 : 0);