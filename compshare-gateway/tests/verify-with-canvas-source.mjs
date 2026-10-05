/**
 * 用画布**真实源码**验证网关响应能被解析（不复刻 parseImagePayload）。
 *
 * 做法：esbuild 转译 web/src/services/api/image.ts 里的 parseImagePayload /
 * resolveImageSource（注入桩替掉 nanoid 与 i18n），再把网关实跑返回的响应喂进去。
 * 这样「网关返回什么画布才认」就不是我抄一遍规则说了算。
 *
 * 前置：先跑 python tests/test_gateway_e2e.py --dump <json> 产出真实响应。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// 注意：不能用 import.meta.dirname 拼 esbuild 路径 —— 中文目录名在 file URL 里是百分号编码的，
// 直接字符串拼接会得到 %E6%97%A0… 这种路径，动态 import 必然 ERR_MODULE_NOT_FOUND。
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const dumpPath = process.argv[2];

if (!dumpPath || !fs.existsSync(dumpPath)) {
    console.error("用法：node tests/verify-with-canvas-source.mjs <gateway-response.json>");
    process.exit(2);
}

const esbuild = (await import(pathToFileURL(path.join(root, "web/node_modules/esbuild/lib/main.js")).href)).default;
const source = fs.readFileSync(path.join(root, "web/src/services/api/image.ts"), "utf8");

/** 按括号配平抽取一个函数（含前置的 resolveImageSource）。 */
function extract(header) {
    const start = source.indexOf(header);
    if (start < 0) throw new Error(`image.ts 里找不到 ${header}`);
    const result = extractBalanced(source, start);
    if (!result) throw new Error(`${header} 未闭合`);
    return result;
}

function extractBalanced(text, start) {
    const paren = text.indexOf("(", start);
    let depth = 0;
    let afterParams = -1;
    for (let i = paren; i < text.length; i += 1) {
        if (text[i] === "(") depth += 1;
        else if (text[i] === ")") {
            depth -= 1;
            if (depth === 0) { afterParams = i + 1; break; }
        }
    }
    if (afterParams < 0) return null;
    // 返回类型里可能也有 {}（如 `: { channel: X } | null`），只有后面不是 |/& 时才是函数体
    let cursor = afterParams;
    while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    if (text[cursor] === ":") {
        let tdepth = 0;
        for (let i = cursor + 1; i < text.length; i += 1) {
            if (text[i] === "{" || text[i] === "(" || text[i] === "[" || text[i] === "<") tdepth += 1;
            else if (text[i] === "}" || text[i] === ")" || text[i] === "]" || text[i] === ">") {
                tdepth -= 1;
                if (tdepth === 0) { cursor = i + 1; break; }
            }
        }
        while (cursor < text.length && /\s/.test(text[cursor])) cursor += 1;
    }
    if (text[cursor] !== "{") return null;
    let bdepth = 0;
    for (let i = cursor; i < text.length; i += 1) {
        if (text[i] === "{") bdepth += 1;
        else if (text[i] === "}") {
            bdepth -= 1;
            if (bdepth === 0) return text.slice(start, i + 1);
        }
    }
    return null;
}

const code = [
    extract("function resolveImageSource"),
    extract("function parseImagePayload"),
    // 源码里这两个是本地 function 声明（不是 export），转译后不会自动挂到 exports，
    // 这里显式导出再取，才等于在验证真实逻辑。
    "module.exports.resolveImageSource = resolveImageSource;",
    "module.exports.parseImagePayload = parseImagePayload;",
].join("\n");

const out = await esbuild.transform(code, { loader: "ts", format: "cjs", target: "es2022" });

const module_ = { exports: {} };
// 画布里这两个是外部依赖；桩掉它们，解析逻辑本身用真实源码
const apiText = (key) => key;
new Function("module", "exports", "require", "nanoid", "apiText", out.code)(
    module_, module_.exports,
    () => ({}),
    () => "test-id-" + Math.random().toString(36).slice(2, 8),
    apiText,
);
const { parseImagePayload } = module_.exports;
if (typeof parseImagePayload !== "function") {
    console.error("抽取/转译失败：parseImagePayload 不是函数\n--- esbuild 产物 ---\n" + out.code);
    process.exit(2);
}

const cases = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
let failed = 0;
for (const item of cases) {
    const label = item.label;
    try {
        const images = parseImagePayload(item.payload);
        if (!images.length) throw new Error("解析出 0 张图");
        const head = String(images[0].dataUrl).slice(0, 40);
        const good = String(images[0].dataUrl).startsWith("data:image/png;base64,")
            || /^https?:\/\//.test(String(images[0].dataUrl));
        console.log(`  ${good ? "PASS" : "FAIL"}  ${label} → ${images.length} 张，${head}…`);
        if (!good) failed += 1;
    } catch (error) {
        failed += 1;
        console.log(`  FAIL  ${label} → ${error.message}`);
    }
}

console.log(`\n画布真实解析：${cases.length - failed}/${cases.length} 通过`);
process.exit(failed ? 1 : 0);