/**
 * 前端静态资源托管 —— 让「授权服务域名」本身就是主应用首页。
 *
 * 路由约定：
 *   /               → public/index.html（主应用首页）
 *   /assets/*       → 带 hash 的产物，强缓存
 *   /login /purchase→ 前端路由，SPA 回退到 index.html
 *   /admin          → 运营后台（由 api.js 处理，不经过这里）
 *   /api/*          → JSON 接口（同上）
 *
 * 部署时由 scripts/wasmer-deploy.mjs 把 web/dist 拷到部署目录的 public/；
 * 本地调试可以用 LICENSE_WEB_DIR 指向仓库里的 web/dist。
 *
 * 没有 public/ 时（例如只想快速部署一次后台）所有函数都安静地返回 false，
 * 由 api.js 退回「跳转站点地址 / 落地页」，不会把根路径又导回后台。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(here, "..", "public");

/** 单文件缓存上限：入口 JS 有 6MB，缓存它收益不大还占内存，直接读盘更快。 */
const CACHE_MAX_BYTES = 512 * 1024;
const CACHE_MAX_FILES = 256;
const fileCache = new Map();

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".csv": "text/csv; charset=utf-8",
    ".xml": "application/xml; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".avif": "image/avif",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
    ".wasm": "application/wasm",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".glb": "model/gltf-binary",
    ".gltf": "model/gltf+json",
    ".zip": "application/zip",
    ".pdf": "application/pdf",
};

export function webRoot() {
    const custom = (process.env.LICENSE_WEB_DIR || "").trim();
    return custom ? resolve(custom) : resolve(DEFAULT_ROOT);
}

/** 部署包里是否带了前端产物（看 index.html 在不在）。 */
export function webReady() {
    try {
        return statSync(join(webRoot(), "index.html")).isFile();
    } catch {
        return false;
    }
}

function insideRoot(abs) {
    const root = webRoot();
    if (abs === root) return true;
    const withSep = root.endsWith(sep) ? root : root + sep;
    return abs.startsWith(withSep);
}

/** 把 URL 路径映射成磁盘文件；越界返回 null。 */
function resolveFile(pathname) {
    const clean = pathname.replace(/^\/+/, "");
    const abs = clean ? resolve(webRoot(), clean) : join(webRoot(), "index.html");
    return insideRoot(abs) ? abs : null;
}

function readFileEntry(abs) {
    let stat;
    try {
        stat = statSync(abs);
    } catch {
        return null;
    }
    if (!stat.isFile()) return null;

    const cached = fileCache.get(abs);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;

    let body;
    try {
        body = readFileSync(abs);
    } catch {
        return null;
    }
    const entry = { body, size: stat.size, mtimeMs: stat.mtimeMs };
    if (stat.size <= CACHE_MAX_BYTES) {
        if (fileCache.size >= CACHE_MAX_FILES) fileCache.clear();
        fileCache.set(abs, entry);
    }
    return entry;
}

/** 带 hash 的产物可以长缓存；其余（index.html / config.js / 插件清单）每次校验。 */
function isImmutable(abs) {
    const posix = abs.replace(/\\/g, "/");
    if (/\/assets\//.test(posix)) return true;
    return /\.[A-Za-z0-9_-]{8,}\.(?:js|mjs|css|woff2?|png|jpe?g|webp|svg|wasm)$/.test(posix);
}

function respond(req, res, abs, entry) {
    const ext = (abs.match(/\.[A-Za-z0-9]+$/) || [""])[0].toLowerCase();
    const etag = `W/"${entry.size.toString(16)}-${Math.floor(entry.mtimeMs).toString(16)}"`;
    const headers = {
        "content-type": MIME[ext] || "application/octet-stream",
        "cache-control": isImmutable(abs) ? "public, max-age=31536000, immutable" : "no-cache",
        "x-content-type-options": "nosniff",
        etag,
    };

    if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, headers);
        res.end();
        return true;
    }
    headers["content-length"] = String(entry.body.length);
    res.writeHead(200, headers);
    if ((req.method || "").toUpperCase() === "HEAD") res.end();
    else res.end(entry.body);
    return true;
}

/**
 * 尝试按静态资源响应。返回 true 表示已经响应完，false 表示交给上层继续路由。
 */
export function serveWeb(req, res, pathname) {
    const method = (req.method || "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") return false;
    if (!webReady()) return false;

    let decoded;
    try {
        decoded = decodeURIComponent(pathname);
    } catch {
        decoded = null;
    }
    if (!decoded || decoded.includes("\0")) {
        res.writeHead(400, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("bad request");
        return true;
    }

    const abs = resolveFile(decoded);
    if (!abs) {
        res.writeHead(403, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" });
        res.end("forbidden");
        return true;
    }

    const entry = readFileEntry(abs);
    if (entry) return respond(req, res, abs, entry);

    // 不是真实文件：只对「浏览器导航」回退到 index.html（前端路由 /login、/purchase 等）。
    // 带扩展名的一律不回退，否则缺图会变成一坨 HTML，排查更费劲。
    const wantsHtml = (req.headers.accept || "").includes("text/html");
    if (wantsHtml && !/\.[A-Za-z0-9]+$/.test(decoded)) {
        const indexFile = join(webRoot(), "index.html");
        const index = readFileEntry(indexFile);
        if (index) return respond(req, res, indexFile, index);
    }
    return false;
}
