import type { IncomingMessage, ServerResponse } from "node:http";
import http from "node:http";
import { existsSync, statSync, createReadStream } from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".eot": "application/vnd.ms-fontobject",
    ".map": "application/json; charset=utf-8",
    ".wasm": "application/wasm",
    ".webmanifest": "application/manifest+json",
    ".txt": "text/plain; charset=utf-8",
};

export type Middleware = (req: IncomingMessage, res: ServerResponse, next: () => void) => void;

function sendFile(filePath: string, res: ServerResponse) {
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
    res.setHeader("Cache-Control", "no-cache");
    const stream = createReadStream(filePath);
    stream.on("error", () => {
        res.statusCode = 500;
        res.end("Internal error");
    });
    stream.pipe(res);
}

function resolveSafe(base: string, rel: string): string | null {
    const baseResolved = path.resolve(base);
    const target = path.resolve(baseResolved, rel);
    // 阻止路径穿越
    if (target !== baseResolved && !target.startsWith(baseResolved + path.sep)) return null;
    return target;
}

/**
 * 静态资源服务：覆盖层（userData/frontend-overlay）优先，未命中回退内置 dist。
 * 无扩展名的未知路径（SPA 路由，如 /canvas/<id>）回退到 index.html。
 */
async function serveStatic(overlayDir: string, builtinDir: string, pathname: string, res: ServerResponse) {
    const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
    const candidates = [overlayDir, builtinDir];

    for (const base of candidates) {
        const filePath = resolveSafe(base, rel);
        if (filePath && existsSync(filePath) && statSync(filePath).isFile()) {
            return sendFile(filePath, res);
        }
    }

    // SPA 回退（仅对无扩展名路径；带扩展名 404 直接报错，避免回退 index 掩盖缺失资源）
    if (!path.extname(rel)) {
        const idxOverlay = resolveSafe(overlayDir, "index.html");
        const idxBuiltin = resolveSafe(builtinDir, "index.html");
        const idxPath = idxOverlay && existsSync(idxOverlay) ? idxOverlay : idxBuiltin;
        if (idxPath && existsSync(idxPath)) {
            return sendFile(idxPath, res);
        }
    }

    res.statusCode = 404;
    res.end("Not found");
}

/**
 * 创建本机 HTTP 服务：把一组 Connect 形态的中间件（来自 web/vite-plugins/*.ts，用假 server 提取）
 * 串成链路，未命中的请求交给静态服务。
 */
export function createLocalServer(options: {
    port: number;
    overlayDir: string;
    builtinDir: string;
    middlewares: Middleware[];
}): Promise<http.Server> {
    const { port, overlayDir, builtinDir, middlewares } = options;
    const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        const pathname = url.pathname;
        let idx = 0;
        const next = () => {
            idx += 1;
            run();
        };
        const run = () => {
            if (idx < middlewares.length) {
                try {
                    return middlewares[idx](req, res, next);
                } catch (error) {
                    console.error("[desktop] middleware error:", error);
                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.end("Internal error");
                    }
                    return;
                }
            }
            void serveStatic(overlayDir, builtinDir, pathname, res);
        };
        run();
    });

    return new Promise((resolve, reject) => {
        server.on("error", reject);
        server.listen(port, "127.0.0.1", () => {
            console.log(`[desktop] local server listening on http://127.0.0.1:${port}`);
            resolve(server);
        });
    });
}
