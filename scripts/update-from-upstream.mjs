#!/usr/bin/env node
/**
 * 在线更新引擎（零 git 依赖）
 *
 * 设计前提：本机 git 元数据可能不可用、且到 GitHub 的 git 通道不稳定，
 * 因此更新完全走 HTTPS 归档：下载上游 tar.gz 源码快照后按文件覆盖，
 * 并依托 second-dev/manifest.json 保护二次开发内容。
 *
 * 用法：
 *   node scripts/update-from-upstream.mjs [--check]     预演，只读，不写任何文件（默认）
 *   node scripts/update-from-upstream.mjs --apply       实际更新
 *   node scripts/update-from-upstream.mjs --rollback    回滚到上一次更新前
 *   --json        以 JSON 输出报告（供网页端调用）
 *   --repo <dir>  指定仓库根（仅用于演练/测试，默认取脚本所在仓库）
 *   --ref <ref>   指定上游 ref（默认 main）
 *
 * 三类文件的处理：
 *   1. 二开新增（protected）→ 完全不碰；
 *   2. 上游文件·本地未改     → 用上游新版覆盖（覆盖前备份）；
 *   3. 上游文件·本地已改（侵入）→ base/ours/theirs 三方合并，冲突一律保留本地并记录。
 *
 * 任何一步失败都会中止并给出回滚指引；所有被覆盖/删除的原文件都在 .update-backup/ 下留有副本。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));

/* ---------------------------------- 参数 ---------------------------------- */

const argv = process.argv.slice(2);
const hasFlag = (name) => argv.includes(name);
const flagValue = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const APPLY = hasFlag("--apply");
const ROLLBACK = hasFlag("--rollback");
const JSON_OUT = hasFlag("--json");
const REPO = resolve(flagValue("--repo", resolve(join(SCRIPT_DIR, ".."))));
const REF = flagValue("--ref", "main");
const OWNER_REPO = "basketikun/infinite-canvas";
const TARBALL = (ref) => `https://codeload.github.com/${OWNER_REPO}/tar.gz/${ref}`;
const RAW = (ref, path) => `https://raw.githubusercontent.com/${OWNER_REPO}/${ref}/${path}`;

const CACHE_DIR = join(REPO, ".update-cache");
const DOWNLOAD_CACHE = join(CACHE_DIR, "downloads");
const BACKUP_ROOT = join(REPO, ".update-backup");
const REPORT_PATH = join(CACHE_DIR, "last-report.json");
const MANIFEST_PATH = join(REPO, "second-dev", "manifest.json");
/** 会移动的 ref 只做短期缓存，避免拿到陈旧快照。 */
const MOVABLE_REFS = new Set(["main", "master", "develop", "dev", "HEAD"]);
const MOVABLE_TTL_MS = 10 * 60 * 1000;

/* --------------------------------- 输出工具 -------------------------------- */

const logLines = [];
const log = (line = "") => {
    logLines.push(line);
    if (!JSON_OUT) console.log(line);
};

/**
 * 机器可读报告：始终以单行紧凑 JSON 输出，供网页端接口解析。
 * 加前缀单独成行，避免与人类可读日志混在一起（也不写回 logLines，防止报告自引用）。
 */
const REPORT_PREFIX = "@@REPORT@@ ";
const emitReport = (report) => {
    console.log(`${REPORT_PREFIX}${JSON.stringify(report)}`);
    if (JSON_OUT) console.log(JSON.stringify(report, null, 2));
};

/* --------------------------------- 基础工具 -------------------------------- */

const sha1 = (buf) => createHash("sha1").update(buf).digest("hex");
const isBinary = (buf) => {
    const n = Math.min(buf.length, 8000);
    for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
    return false;
};
/** 本机检出可能把文本转成 CRLF；比对/合并统一按 LF 口径，避免误判为"已改动"。 */
const toLf = (text) => text.replace(/\r\n/g, "\n");
const norm = (buf) => (isBinary(buf) ? buf : Buffer.from(toLf(buf.toString("utf8")), "utf8"));

function walkFiles(root, rel = "", out = [], skip) {
    let entries;
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch { return out; }
    for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (skip(r, e.isDirectory())) continue;
        if (e.isDirectory()) walkFiles(root, r, out, skip);
        else if (e.isFile()) out.push(r);
    }
    return out;
}

async function download(url, { attempts = 4, timeout = 120000 } = {}) {
    let lastErr = null;
    for (let i = 0; i < attempts; i++) {
        try {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "infinite-canvas-updater" } });
            clearTimeout(timer);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return Buffer.from(await res.arrayBuffer());
        } catch (e) {
            lastErr = e;
            await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        }
    }
    throw new Error(`下载失败 ${url}：${lastErr && lastErr.message}`);
}

/* --------------------------------- tar 解包 -------------------------------- */

function parseTar(buf) {
    const files = new Map();
    let offset = 0;
    let longName = null;
    let paxPath = null;
    while (offset + 512 <= buf.length) {
        const header = buf.subarray(offset, offset + 512);
        if (header.every((b) => b === 0)) break;
        const str = (start, len) => header.subarray(start, start + len).toString("utf8").replace(/\0.*$/, "").trim();
        const size = parseInt(str(124, 12), 8) || 0;
        const type = String.fromCharCode(header[156] || 48);
        const prefix = str(345, 155);
        let name = str(0, 100);
        const body = buf.subarray(offset + 512, offset + 512 + size);
        offset += 512 + Math.ceil(size / 512) * 512;

        if (type === "L") { longName = body.toString("utf8").replace(/\0.*$/, ""); continue; }
        if (type === "x") {
            const text = body.toString("utf8");
            const m = text.match(/\d+ path=([^\n]+)\n/);
            if (m) paxPath = m[1];
            continue;
        }
        if (type === "g") continue;
        if (longName) { name = longName; longName = null; }
        if (paxPath) { name = paxPath; paxPath = null; }
        if (prefix) name = `${prefix}/${name}`;
        if (type === "0" || type === "\0" || type === "") files.set(name, Buffer.from(body));
    }
    return files;
}

/** 下载并解包某个 ref，返回 Map<仓库内相对路径, Buffer>。带本地缓存：不可变 ref 永久复用，可移动 ref 短期复用。 */
async function fetchSnapshot(ref) {
    const immutable = !MOVABLE_REFS.has(ref);
    const cacheFile = join(DOWNLOAD_CACHE, `${ref.replace(/[^A-Za-z0-9._-]/g, "_")}.tar.gz`);
    const ttl = immutable ? Number.POSITIVE_INFINITY : MOVABLE_TTL_MS;
    if (!hasFlag("--refresh") && existsSync(cacheFile) && Date.now() - statSync(cacheFile).mtimeMs < ttl) {
        log(`  使用缓存快照 ${ref}`);
        return stripRoot(parseTar(gunzipSync(readFileSync(cacheFile))));
    }
    const started = Date.now();
    const gz = await download(TARBALL(ref));
    log(`  已下载 ${ref}（${(gz.length / 1024 / 1024).toFixed(1)}MB，${((Date.now() - started) / 1000).toFixed(0)}s）`);
    mkdirSync(DOWNLOAD_CACHE, { recursive: true });
    writeFileSync(cacheFile, gz);
    return stripRoot(parseTar(gunzipSync(gz)));
}

/** GitHub 归档会带一层 `<owner>-<repo>-<sha>/` 根目录，去掉它得到仓库内相对路径。 */
function stripRoot(raw) {
    const files = new Map();
    let rootPrefix = null;
    for (const [name, body] of raw) {
        if (rootPrefix === null) rootPrefix = name.includes("/") ? name.slice(0, name.indexOf("/") + 1) : "";
        const rel = rootPrefix && name.startsWith(rootPrefix) ? name.slice(rootPrefix.length) : name;
        if (rel) files.set(rel, body);
    }
    return files;
}

/* ------------------------------- 三方行级合并 ------------------------------- */

/** 行级 diff，返回 hunk 列表：{ baseStart, baseEnd, lines }。文件过大时返回 null。 */
function diffHunks(baseLines, otherLines) {
    const n = baseLines.length;
    const m = otherLines.length;
    if (n * m > 4_000_000) return null;
    const dp = new Int32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
            dp[i * (m + 1) + j] =
                baseLines[i] === otherLines[j]
                    ? dp[(i + 1) * (m + 1) + j + 1] + 1
                    : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
        }
    }
    const hunks = [];
    let i = 0;
    let j = 0;
    let cur = null;
    const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
    while (i < n && j < m) {
        if (baseLines[i] === otherLines[j]) { flush(); i++; j++; continue; }
        if (!cur) cur = { baseStart: i, baseEnd: i, lines: [] };
        if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) { cur.baseEnd = ++i; }
        else { cur.lines.push(otherLines[j++]); }
    }
    if (i < n || j < m) {
        if (!cur) cur = { baseStart: i, baseEnd: i, lines: [] };
        cur.baseEnd = n;
        while (j < m) cur.lines.push(otherLines[j++]);
    }
    flush();
    return hunks;
}

const hunkOverlaps = (a, b) => a.baseStart < b.baseEnd && b.baseStart < a.baseEnd;
const sameHunk = (a, b) => a.baseStart === b.baseStart && a.baseEnd === b.baseEnd && a.lines.join("\n") === b.lines.join("\n");

/**
 * 三方合并：以 base 为坐标轴，应用双方 hunk；与本地 hunk 重叠的上游 hunk 一律让步（冲突=本地优先）。
 * 返回 { text, conflicts }；无法安全合并时返回 null。
 */
function merge3(baseText, oursText, theirsText) {
    const baseLines = baseText.split("\n");
    const oursHunks = diffHunks(baseLines, oursText.split("\n"));
    const theirsHunks = diffHunks(baseLines, theirsText.split("\n"));
    if (!oursHunks || !theirsHunks) return null;

    const conflicts = [];
    const accepted = [];
    const rejected = [];

    for (const th of theirsHunks) {
        const clash = oursHunks.find((oh) => hunkOverlaps(oh, th));
        if (!clash) { accepted.push(th); continue; }
        if (sameHunk(clash, th)) continue; // 双方改法一致，等同已应用
        rejected.push(th);
        conflicts.push({
            baseStart: th.baseStart,
            baseEnd: th.baseEnd,
            oursLines: clash.lines.length,
            theirsLines: th.lines.length,
            theirsPreview: th.lines.slice(0, 3).map((l) => l.trim()).filter(Boolean).join(" | ").slice(0, 160),
        });
    }

    const all = [
        ...oursHunks.map((h) => ({ ...h, side: "ours" })),
        ...accepted.map((h) => ({ ...h, side: "theirs" })),
    ].sort((a, b) => a.baseStart - b.baseStart || a.baseEnd - b.baseEnd);

    const out = [];
    let cursor = 0;
    for (const h of all) {
        if (h.baseStart < cursor) continue; // 防御：diff 的 hunk 互不重叠，这里正常不会命中
        out.push(...baseLines.slice(cursor, h.baseStart));
        out.push(...h.lines);
        cursor = h.baseEnd;
    }
    out.push(...baseLines.slice(cursor));
    return { text: out.join("\n"), conflicts, rejected: rejected.length };
}

/* ---------------------------------- 主流程 --------------------------------- */

function loadManifest() {
    if (!existsSync(MANIFEST_PATH)) throw new Error(`缺少二开清单：${MANIFEST_PATH}`);
    return JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
}

const decodeXml = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** 快速取上游版本号（小文件）。失败不影响主流程 —— 归档里也带 VERSION，可作兜底。 */
async function readUpstreamVersion(ref) {
    try {
        const buf = await download(RAW(ref, "VERSION"), { attempts: 2, timeout: 15000 });
        return decodeXml(buf.toString("utf8")).trim();
    } catch {
        return null;
    }
}

/** 从已下载的归档里读 VERSION（权威来源，避免额外一次网络请求成为单点故障）。 */
function versionFromSnapshot(snapshot) {
    const buf = snapshot.get("VERSION");
    return buf ? decodeXml(buf.toString("utf8")).trim() : null;
}

function readLocalVersion() {
    try { return decodeXml(readFileSync(join(REPO, "VERSION"), "utf8")).trim(); } catch { return null; }
}

function semver(v) {
    const m = String(v || "").trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
    return m ? m.slice(1).map(Number) : null;
}
function isNewer(a, b) {
    const A = semver(a);
    const B = semver(b);
    if (!A || !B) return false;
    return A.some((x, i) => x > B[i] && A.slice(0, i).every((y, k) => y === B[k]));
}

/**
 * 保护/排除规则匹配。
 * 约定：以 "/" 结尾的条目按目录前缀匹配；否则按文件路径精确匹配
 * （避免 ".git" 之类条目误伤 ".gitignore"、".github/**"）。
 */
function makeSkipPredicate(manifest) {
    const rules = [...(manifest.excluded || []), ...(manifest.protected || [])];
    return (rel, isDir) => {
        const probe = isDir ? `${rel}/` : rel;
        for (const rule of rules) {
            if (rule.endsWith("/")) {
                if (probe === rule || probe.startsWith(rule) || rel.startsWith(rule)) return true;
            } else if (rel === rule) {
                return true;
            }
        }
        return false;
    };
}

function localText(rel) {
    try { return toLf(readFileSync(join(REPO, rel), "utf8")); } catch { return null; }
}

/** 统计某目录下的文件数（忽略 node_modules/dist 等构建目录）。注意：不能用保护规则过滤，否则统计恒为 0。 */
function countUnder(prefix) {
    const ignored = new Set(["node_modules", "dist", "build", ".cache", ".vite"]);
    return walkFiles(join(REPO, prefix), "", [], (rel) => ignored.has(rel.split("/").pop())).length;
}

function runAssertions(manifest) {
    const results = [];
    const a = manifest.assertions || {};
    for (const f of a.files || []) {
        const ok = existsSync(join(REPO, f));
        results.push({ kind: "file", target: f, ok, detail: ok ? "存在" : "缺失" });
    }
    for (const c of a.contains || []) {
        const text = localText(c.file);
        const ok = typeof text === "string" && text.includes(c.text);
        results.push({ kind: "marker", target: `${c.file} :: ${c.text}`, ok, label: c.label, detail: ok ? "标记存在" : text === null ? "文件不存在" : "标记丢失" });
    }
    for (const [prefix, min] of Object.entries(a.minCounts || {})) {
        const n = countUnder(prefix);
        results.push({ kind: "count", target: `${prefix} ≥ ${min}`, ok: n >= min, detail: `实际 ${n}` });
    }
    return results;
}

function doRollback() {
    if (!existsSync(BACKUP_ROOT)) throw new Error("没有可回滚的备份目录（.update-backup 不存在）");
    const dirs = readdirSync(BACKUP_ROOT).filter((d) => statSync(join(BACKUP_ROOT, d)).isDirectory()).sort();
    const latest = dirs[dirs.length - 1];
    if (!latest) throw new Error("备份目录为空，无法回滚");
    const base = join(BACKUP_ROOT, latest);
    const meta = JSON.parse(readFileSync(join(base, "_meta.json"), "utf8"));
    let restored = 0;
    let removed = 0;
    for (const rel of meta.written) {
        const from = join(base, "files", rel);
        if (!existsSync(from)) continue;
        const to = join(REPO, rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
        restored++;
    }
    for (const rel of meta.added || []) {
        const target = join(REPO, rel);
        if (existsSync(target)) { rmSync(target, { force: true }); removed++; }
    }
    for (const rel of meta.deleted || []) {
        const from = join(base, "files", rel);
        if (!existsSync(from)) continue;
        const to = join(REPO, rel);
        mkdirSync(dirname(to), { recursive: true });
        writeFileSync(to, readFileSync(from));
        restored++;
    }
    if (meta.baseVersionBefore) {
        const manifest = loadManifest();
        manifest.baseVersion = meta.baseVersionBefore;
        writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`);
    }
    return { backupDir: latest, restored, removed };
}

async function main() {
    const manifest = loadManifest();
    const skip = makeSkipPredicate(manifest);
    const baseVersion = manifest.baseVersion;

    if (ROLLBACK) {
        try {
            const r = doRollback();
            log(`已回滚到更新前状态（备份 ${r.backupDir}）：还原 ${r.restored} 个文件，撤回新增 ${r.removed} 个文件。`);
            log("提示：版本号在构建期注入，请重启开发服务后同步。");
            emitReport({ ok: true, mode: "rollback", ...r, logs: logLines });
        } catch (error) {
            const message = error && error.message ? error.message : String(error);
            log(`✗ 无法回滚：${message}`);
            emitReport({ ok: false, mode: "rollback", error: message, logs: logLines });
            process.exitCode = 1;
        }
        return;
    }

    log(`在线更新（${APPLY ? "实际执行" : "预演"}）｜仓库：${REPO}`);
    log(`二开基线：${baseVersion || "(未记录)"}　上游 ref：${REF}`);

    const localVersion = readLocalVersion();
    const quickVersion = await readUpstreamVersion(REF);
    log(`本地版本：${localVersion || "未知"}　上游版本：${quickVersion || "（待从归档读取）"}`);

    const report = {
        ok: false,
        mode: APPLY ? "apply" : "check",
        repo: REPO,
        ref: REF,
        localVersion,
        upstreamVersion: quickVersion,
        baseVersion,
        hasUpdate: isNewer(quickVersion, localVersion),
        counts: {},
        conflicts: [],
        assertions: [],
        builds: [],
        backupDir: null,
    };

    // 快路径：已是最新且非强制时，不必下载大归档。
    if (quickVersion && !isNewer(quickVersion, localVersion) && !hasFlag("--force")) {
        log(`本地已是最新（${localVersion}），无需更新。`);
        report.ok = true;
        report.counts = { write: 0, add: 0, keepLocal: 0, merge: 0, deleteCandidates: 0, skipped: 0 };
        report.logs = logLines;
        emitReport(report);
        return;
    }

    log("下载上游快照…");
    const theirs = await fetchSnapshot(REF);
    log(`上游文件 ${theirs.size} 个`);
    const upstreamVersion = versionFromSnapshot(theirs) || quickVersion;
    report.upstreamVersion = upstreamVersion;
    report.hasUpdate = isNewer(upstreamVersion, localVersion);

    if (!upstreamVersion) {
        log("✗ 无法确定上游版本（归档异常），未做任何修改。");
        report.logs = logLines;
        emitReport(report);
        process.exitCode = 1;
        return;
    }
    if (!report.hasUpdate && APPLY && !hasFlag("--force")) {
        log(`本地已是最新（${localVersion}），无需更新。`);
        report.ok = true;
        report.counts = { write: 0, add: 0, keepLocal: 0, merge: 0, deleteCandidates: 0, skipped: 0 };
        report.logs = logLines;
        emitReport(report);
        return;
    }

    const base = baseVersion ? await fetchSnapshot(baseVersion) : new Map();
    log(`基线快照 ${base.size} 个（${baseVersion}）`);

    const localFiles = walkFiles(REPO, "", [], skip);

    const plan = { write: [], add: [], keepLocal: [], merge: [], skipped: [], deleteCandidates: [] };
    const earlyConflicts = [];

    for (const [rel, body] of theirs) {
        if (skip(rel, false)) { plan.skipped.push(rel); continue; }
        const target = join(REPO, rel);
        const exists = existsSync(target) && statSync(target).isFile();
        if (!exists) { plan.add.push(rel); continue; }

        const oursBuf = readFileSync(target);
        const oursNorm = norm(oursBuf);
        const baseBuf = base.get(rel);
        const theirsNorm = norm(body);

        if (oursNorm.equals(theirsNorm)) continue; // 已是上游内容，无需处理

        const localChanged = baseBuf ? !norm(baseBuf).equals(oursNorm) : false;
        if (!localChanged) { plan.write.push(rel); continue; }

        if (baseBuf && norm(baseBuf).equals(theirsNorm)) { plan.keepLocal.push(rel); continue; }

        const binary = isBinary(oursBuf) || isBinary(body) || (baseBuf ? isBinary(baseBuf) : false);
        if (binary || !baseBuf) {
            plan.keepLocal.push(rel);
            earlyConflicts.push({ file: rel, reason: binary ? "二进制文件无法合并，保留本地" : "缺少基线内容，保留本地" });
            continue;
        }
        plan.merge.push(rel);
    }

    for (const rel of localFiles) {
        if (skip(rel, false)) continue;
        if (theirs.has(rel)) continue;
        const baseBuf = base.get(rel);
        if (!baseBuf) continue;
        const oursNorm = norm(readFileSync(join(REPO, rel)));
        if (norm(baseBuf).equals(oursNorm)) plan.deleteCandidates.push(rel);
    }

    log("");
    log("影响面：");
    log(`  · 覆盖上游文件（本地未改）: ${plan.write.length}`);
    log(`  · 新增上游文件            : ${plan.add.length}${plan.add.length ? `（例：${plan.add.slice(0, 3).join(", ")}${plan.add.length > 3 ? " …" : ""}）` : ""}`);
    log(`  · 保留本地（上游未改）    : ${plan.keepLocal.length}`);
    log(`  · 需要三方合并            : ${plan.merge.length}`);
    log(`  · 上游删除候选            : ${plan.deleteCandidates.length}`);
    log(`  · 二开保护跳过            : ${plan.skipped.length}`);

    report.counts = {
        write: plan.write.length,
        add: plan.add.length,
        keepLocal: plan.keepLocal.length,
        merge: plan.merge.length,
        deleteCandidates: plan.deleteCandidates.length,
        skipped: plan.skipped.length,
    };

    // 硬不变量：任何写入/删除计划都不允许落在二开保护路径内（防御性校验，不依赖上面的过滤逻辑）。
    const protectedOnly = (manifest.protected || []).filter((p) => p.endsWith("/"));
    const touched = [...plan.write, ...plan.add, ...plan.merge, ...plan.deleteCandidates];
    const violations = touched.filter((rel) => protectedOnly.some((p) => rel.startsWith(p)));
    if (violations.length) {
        log("");
        log("✗ 计划中出现了受保护路径（内部错误），已中止，未做任何修改：");
        for (const v of violations.slice(0, 20)) log(`  · ${v}`);
        report.ok = false;
        report.error = "计划触碰了二开保护路径";
        report.violations = violations;
        report.logs = logLines;
        emitReport(report);
        process.exitCode = 1;
        return;
    }

    if (!APPLY) {
        if (plan.merge.length) {
            log("");
            log("将做三方合并的文件：");
            for (const f of plan.merge) log(`  · ${f}`);
        }
        for (const c of earlyConflicts) log(`  ⚠ ${c.file}：${c.reason}`);
        log("");
        log("预演结束，未做任何修改。确认后执行：node scripts/update-from-upstream.mjs --apply");
        report.assertions = runAssertions(manifest);
        report.conflicts = earlyConflicts;
        report.ok = true;
        report.logs = logLines;
        emitReport(report);
        return;
    }

    if (earlyConflicts.length) report.conflicts.push(...earlyConflicts);

    /* ------------------------------ 实际写入 ------------------------------ */

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupDir = join(BACKUP_ROOT, stamp);
    const backupFiles = join(backupDir, "files");
    mkdirSync(backupFiles, { recursive: true });

    const written = [];
    const added = [];
    const deleted = [];

    // 用 read/write 而非 cpSync：Windows 上 cpSync 覆盖已存在文件时可能抛出语焉不详的系统错误。
    const backupOne = (rel) => {
        const src = join(REPO, rel);
        if (!existsSync(src)) return;
        const dst = join(backupFiles, rel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, readFileSync(src));
    };

    for (const rel of plan.write) {
        backupOne(rel);
        const dst = join(REPO, rel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, theirs.get(rel));
        written.push(rel);
    }
    for (const rel of plan.add) {
        const dst = join(REPO, rel);
        mkdirSync(dirname(dst), { recursive: true });
        writeFileSync(dst, theirs.get(rel));
        added.push(rel);
    }
    for (const rel of plan.merge) {
        const oursText = localText(rel);
        const theirsText = toLf(theirs.get(rel).toString("utf8"));
        const baseText = base.has(rel) ? toLf(base.get(rel).toString("utf8")) : null;
        if (oursText === null || baseText === null) continue;
        const merged = merge3(baseText, oursText, theirsText);
        if (!merged) {
            report.conflicts.push({ file: rel, reason: "文件过大或无法安全合并，保留本地" });
            continue;
        }
        backupOne(rel);
        const originalRaw = readFileSync(join(REPO, rel), "utf8");
        const useCrlf = originalRaw.includes("\r\n");
        writeFileSync(join(REPO, rel), useCrlf ? merged.text.replace(/\n/g, "\r\n") : merged.text);
        written.push(rel);
        for (const c of merged.conflicts) report.conflicts.push({ file: rel, reason: "上游改动与二开改动重叠，已保留本地", ...c });
        log(`  合并 ${rel}${merged.conflicts.length ? `（${merged.conflicts.length} 处冲突已保留本地）` : "（无冲突）"}`);
    }
    for (const rel of plan.deleteCandidates) {
        backupOne(rel);
        rmSync(join(REPO, rel), { force: true });
        deleted.push(rel);
    }

    writeFileSync(
        join(backupDir, "_meta.json"),
        JSON.stringify({ written, added, deleted, baseVersionBefore: baseVersion, ref: REF, upstreamVersion, at: new Date().toISOString() }, null, 4),
    );

    log("");
    log(`写入 ${written.length} 个文件，新增 ${added.length} 个，删除 ${deleted.length} 个。备份：${relative(REPO, backupDir).split(sep).join("/")}`);
    if (report.conflicts.length) {
        log(`⚠ 保留本地版本的位置 ${report.conflicts.length} 处：`);
        for (const c of report.conflicts.slice(0, 20)) log(`  · ${c.file} :: ${c.reason}`);
    }

    const assertionResults = runAssertions(manifest);
    const failed = assertionResults.filter((a) => !a.ok);
    report.assertions = assertionResults;
    report.backupDir = relative(REPO, backupDir).split(sep).join("/");

    log("");
    log(`二开完整性校验：${assertionResults.length - failed.length}/${assertionResults.length} 通过`);
    for (const f of failed) log(`  ✗ [${f.kind}] ${f.target}（${f.detail}）`);

    if (failed.length) {
        log("");
        log("✗ 二开校验未通过，自动回滚…");
        const r = doRollback();
        report.ok = false;
        report.rolledBack = r;
        report.logs = logLines;
        writeFileSync(REPORT_PATH, JSON.stringify(report, null, 4));
        emitReport(report);
        process.exitCode = 1;
        return;
    }

    // 清理 vite 依赖预构建缓存：package.json 变化后缓存失效，若残留空的 deps 目录，
    // 开发服务会在加载时反复尝试预构建并阻塞请求（表现为"服务卡死"）。
    const viteCache = join(REPO, "web", "node_modules", ".vite");
    if (existsSync(viteCache)) {
        try {
            rmSync(viteCache, { recursive: true, force: true });
            log("已清理 vite 依赖预构建缓存（web/node_modules/.vite），下次启动会重新预构建。");
        } catch (error) {
            log(`⚠ 未能清理 vite 缓存（可手动删除 web/node_modules/.vite）：${error.message}`);
        }
    }

    manifest.baseVersion = semver(upstreamVersion) ? `v${semver(upstreamVersion).join(".")}` : baseVersion;
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 4)}\n`);
    log(`二开基线已推进到 ${manifest.baseVersion}`);

    const nodeExe = process.execPath;
    for (const stepDef of manifest.postApply || []) {
        const cwd = join(REPO, stepDef.cwd);
        if (!existsSync(cwd)) { report.builds.push({ name: stepDef.cwd, ok: false, reason: "目录不存在" }); continue; }
        // 以 node 开头的命令用当前 node 执行（去掉命令名本身），其余命令直接执行
        const parts = stepDef.command.trim().split(/\s+/);
        const [cmd, ...cmdArgs] = parts;
        const executable = cmd === "node" || cmd === "node.exe" ? nodeExe : cmd;
        const r = spawnSync(executable, cmdArgs, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
        const ok = r.status === 0;
        report.builds.push({ name: stepDef.cwd, ok, reason: ok ? "" : `${r.stderr || r.stdout || ""}`.trim().slice(0, 400) });
        log(`  ${ok ? "✓" : "✗"} 重建 ${stepDef.cwd}${ok ? "" : `（${report.builds[report.builds.length - 1].reason}）`}`);
    }

    log("");
    log(`完成：本地已更新到上游 ${upstreamVersion}，二次开发内容全部保留。`);
    log("提示：版本号在构建期注入，请重启开发服务（或重新构建）后生效。");
    report.ok = true;
    report.logs = logLines;
    writeFileSync(REPORT_PATH, JSON.stringify(report, null, 4));
    emitReport(report);
}

main().catch((error) => {
    const message = error && error.message ? error.message : String(error);
    if (!JSON_OUT) console.error(`\n✗ ${message}`);
    emitReport({ ok: false, error: message, logs: logLines });
    process.exitCode = 1;
});
