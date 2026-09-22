import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connect, Plugin } from "vite";

/**
 * 在线更新接口（仅开发服务）。
 *
 * 网页端「版本更新」里的「在线更新」按钮通过本中间件真正执行更新：
 *   GET  /__online-update/status    查询当前/上游版本与进行中的任务
 *   POST /__online-update/check     预演（只读，报告影响面）
 *   POST /__online-update/apply     实际更新
 *   POST /__online-update/rollback  回滚到更新前
 *
 * 更新动作全部交给 scripts/update-from-upstream.mjs，二次开发保护由
 * second-dev/manifest.json 声明，本中间件只做转发与状态展示，不自己改文件。
 * 仅在 vite serve 阶段注册，不影响构建产物。
 */

type TaskState = {
    running: boolean;
    mode: "check" | "apply" | "rollback" | null;
    startedAt: number;
    finishedAt: number;
    lines: string[];
    result: unknown;
    error: string | null;
};

const MAX_LINES = 400;
const REPORT_PREFIX = "@@REPORT@@ ";

function createState(): TaskState {
    return { running: false, mode: null, startedAt: 0, finishedAt: 0, lines: [], result: null, error: null };
}

function isLoopback(req: Connect.IncomingMessage) {
    const addr = req.socket?.remoteAddress || "";
    // 优先用 TCP 层来源地址（Host 头可伪造）；开发服务默认 --host 0.0.0.0，必须挡住局域网访问。
    if (addr) return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
    const host = String(req.headers.host || "");
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

function readVersion(repoRoot: string) {
    try {
        return readFileSync(join(repoRoot, "VERSION"), "utf8").trim();
    } catch {
        return null;
    }
}

function readManifest(repoRoot: string) {
    try {
        return JSON.parse(readFileSync(join(repoRoot, "second-dev", "manifest.json"), "utf8")) as { baseVersion?: string; protected?: string[] };
    } catch {
        return null;
    }
}

const sendJson = (res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
};

const readBody = (req: Connect.IncomingMessage) =>
    new Promise<string>((resolveBody) => {
        let text = "";
        req.on("data", (chunk) => { text += chunk; });
        req.on("end", () => resolveBody(text));
        req.on("error", () => resolveBody(""));
    });

export function onlineUpdate(options: { repoRoot: string }): Plugin {
    const { repoRoot } = options;
    const script = join(repoRoot, "scripts", "update-from-upstream.mjs");
    const state = createState();

    const startTask = (mode: "check" | "apply" | "rollback") => {
        if (state.running) return false;
        state.running = true;
        state.mode = mode;
        state.startedAt = Date.now();
        state.finishedAt = 0;
        state.lines = [];
        state.result = null;
        state.error = null;

        const args = [script, "--json"];
        if (mode === "apply") args.push("--apply");
        if (mode === "rollback") args.push("--rollback");

        const child = spawn(process.execPath, args, { cwd: repoRoot, windowsHide: true });
        const push = (chunk: Buffer) => {
            for (const line of chunk.toString("utf8").split(/\r?\n/)) {
                if (!line.trim()) continue;
                state.lines.push(line);
                if (state.lines.length > MAX_LINES) state.lines.splice(0, state.lines.length - MAX_LINES);
            }
        };
        child.stdout.on("data", push);
        child.stderr.on("data", push);
        child.on("error", (error) => {
            state.running = false;
            state.error = error.message;
            state.finishedAt = Date.now();
        });
        child.on("close", (code) => {
            state.running = false;
            state.finishedAt = Date.now();
            // 报告由脚本以单行 @@REPORT@@ 前缀输出，避免与人类可读日志混杂
            const reportLine = [...state.lines].reverse().find((line) => line.startsWith(REPORT_PREFIX));
            if (reportLine) {
                try { state.result = JSON.parse(reportLine.slice(REPORT_PREFIX.length)); } catch { state.result = null; }
            }
            if (code !== 0 && !state.result) state.error = `更新脚本以退出码 ${code} 结束`;
        });
        return true;
    };

    return {
        name: "online-update",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = (req.url || "").split("?")[0];
                if (!url.startsWith("/__online-update/")) return next();
                if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: "仅允许本机访问" });
                if (!existsSync(script)) return sendJson(res, 500, { ok: false, error: `缺少更新脚本：${script}` });

                const manifest = readManifest(repoRoot);

                if (url === "/__online-update/status" && req.method === "GET") {
                    return sendJson(res, 200, {
                        ok: true,
                        supported: true,
                        localVersion: readVersion(repoRoot),
                        baseVersion: manifest?.baseVersion ?? null,
                        protectedPaths: manifest?.protected ?? [],
                        task: {
                            running: state.running,
                            mode: state.mode,
                            startedAt: state.startedAt,
                            finishedAt: state.finishedAt,
                            error: state.error,
                            result: state.result,
                            lines: state.lines.slice(-60),
                        },
                    });
                }

                if (url === "/__online-update/check" && req.method === "POST") {
                    await readBody(req);
                    if (!startTask("check")) return sendJson(res, 409, { ok: false, error: "已有更新任务在进行中" });
                    return sendJson(res, 200, { ok: true, started: "check" });
                }
                if (url === "/__online-update/apply" && req.method === "POST") {
                    await readBody(req);
                    if (!startTask("apply")) return sendJson(res, 409, { ok: false, error: "已有更新任务在进行中" });
                    return sendJson(res, 200, { ok: true, started: "apply" });
                }
                if (url === "/__online-update/rollback" && req.method === "POST") {
                    await readBody(req);
                    if (!startTask("rollback")) return sendJson(res, 409, { ok: false, error: "已有更新任务在进行中" });
                    return sendJson(res, 200, { ok: true, started: "rollback" });
                }

                return sendJson(res, 404, { ok: false, error: "未知的在线更新接口" });
            });
        },
    };
}
