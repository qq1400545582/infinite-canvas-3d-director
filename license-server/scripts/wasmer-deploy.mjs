/**
 * 从「干净仓库」部署到 Wasmer Edge。
 *
 * 为什么需要这个脚本：Wasmer 的 `app secret create` 在 7.4.x 上对这组 app 恒定报
 * `app not found`，`--env-file` 又只影响构建、不写进运行期 env_vars，anybuild 还固定
 * 读「源码目录里的 app.yaml」。所以机密只能进 app.yaml —— 但 app.yaml 是要入库的，
 * 不能带机密。
 *
 * 折中方案：把源码 + 注入过机密的 app.yaml 拷到系统临时目录，再 `wasmer deploy --dir`。
 * 仓库里的 app.yaml 永远是「无机密模板」，机密只存在于 .wasmer.env 与平台侧的版本配置里。
 *
 * 用法：
 *   node scripts/wasmer-deploy.mjs [--env-file .wasmer.env] [--dry-run]
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const envFile = resolve(root, argOf("--env-file", ".wasmer.env"));
const dryRun = argv.includes("--dry-run");

const parse = (text) => {
    const out = {};
    for (const line of text.split(/\r?\n/)) {
        const s = line.trim();
        if (!s || s.startsWith("#")) continue;
        const i = s.indexOf("=");
        if (i < 0) continue;
        const k = s.slice(0, i).trim();
        let v = s.slice(i + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        out[k] = v;
    }
    return out;
};

const secrets = parse(readFileSync(envFile, "utf8"));
const required = ["LICENSE_ADMIN_PASSWORD", "LICENSE_SECRET", "SMTP_HOST", "SMTP_USER", "SMTP_PASS", "SMTP_FROM"];
const missing = required.filter((key) => !secrets[key]);
if (missing.length) {
    console.error("缺少必需的环境变量:", missing.join(", "));
    process.exit(1);
}

const dir = mkdtempSync(join(tmpdir(), "license-deploy-"));
/** 自己递归拷贝：部分环境（含本机 Node 的 fs 代理层）里 fs.cpSync 会静默结束进程。 */
function copyTree(from, to) {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
        const src = join(from, entry.name);
        const dst = join(to, entry.name);
        if (entry.isDirectory()) copyTree(src, dst);
        else writeFileSync(dst, readFileSync(src));
    }
}
copyTree(join(root, "src"), join(dir, "src"));
writeFileSync(join(dir, "package.json"), readFileSync(join(root, "package.json")));

/* ---------------- 前端产物（让域名根路径就是主应用首页） ---------------- */
// 不放进仓库（web/dist 是构建产物），只在部署时拷进临时目录的 public/。
// 用 --no-web 可以只更新后台接口（部署体积小、速度快）；--web <dir> 指定别的构建目录。
const noWeb = argv.includes("--no-web");
const webDir = resolve(root, argOf("--web", "../web/dist"));
let webStat = null;
if (!noWeb) {
    if (!existsSync(join(webDir, "index.html"))) {
        console.warn(`⚠ 没找到前端产物 ${join(webDir, "index.html")}，本次只部署接口与后台；`);
        console.warn("  域名根路径会显示落地页（或跳转到后台配的「站点地址」）。");
    } else {
        const target = join(dir, "public");
        copyTree(webDir, target);
        let files = 0;
        let bytes = 0;
        (function walk(p) {
            for (const entry of readdirSync(p, { withFileTypes: true })) {
                const full = join(p, entry.name);
                if (entry.isDirectory()) walk(full);
                else {
                    files += 1;
                    bytes += statSync(full).size;
                }
            }
        })(target);
        webStat = { files, bytes };
        console.log(`前端产物: ${webDir} → public/（${files} 个文件，${(bytes / 1048576).toFixed(1)} MB）`);
        const entry = /assets\/index-[A-Za-z0-9_-]+\.js/.exec(readFileSync(join(webDir, "index.html"), "utf8"));
        if (entry) console.log("入口:", entry[0]);
    }
}

const template = readFileSync(join(root, "app.yaml"), "utf8");
const quote = (v) => `"${String(v).replace(/"/g, '\\"')}"`;
const lines = template.split(/\r?\n/);
const start = lines.findIndex((l) => l.trim() === "env:");
if (start < 0) throw new Error("app.yaml 里找不到 env:");
let end = start + 1;
while (end < lines.length && /^\s{2}\S/.test(lines[end])) end += 1;

for (const [key, value] of Object.entries(secrets)) {
    const idx = lines.findIndex((l, i) => i > start && i < end && l.trim().startsWith(`${key}:`));
    if (idx >= 0) lines[idx] = `  ${key}: ${quote(value)}`;
    else {
        lines.splice(end, 0, `  ${key}: ${quote(value)}`);
        end += 1;
    }
}
// app_id / annotations 是上一次部署回写的产物，重新部署时不需要（也免得模板被污染）
const cleaned = [];
let skipping = false;
for (const line of lines) {
    if (/^app_id:/.test(line) || /^annotations:/.test(line)) { skipping = true; continue; }
    if (skipping) {
        if (/^\s+\S/.test(line) || /^\s*-/.test(line)) continue;
        skipping = false;
    }
    cleaned.push(line);
}
writeFileSync(join(dir, "app.yaml"), cleaned.join("\n"), "utf8");

console.log("临时部署目录:", dir);
console.log("注入的变量:", Object.keys(secrets).join(", "));
if (dryRun) process.exit(0);

const res = spawnSync(
    "wasmer",
    ["deploy", "--dir", dir, "--build-remote", "--non-interactive", "--no-wait"],
    { stdio: "inherit", shell: process.platform === "win32" },
);
process.exit(res.status ?? 1);
