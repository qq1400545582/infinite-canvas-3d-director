import { spawn } from "node:child_process";
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { join } from "node:path";
import type { Connect, Plugin } from "vite";

/**
 * 画布内「一键启动后端」接口（仅开发服务 / serve 阶段）。
 *
 * 浏览器 / WebView 无法自行拉起本地进程，也无法读写本机配置文件，所以由本地服务
 * （Vite dev server）代为完成。网页端的「一键启动后端」按钮与「编辑渠道」抽屉里的
 * 「同步到 Codex」按钮都走这里，小白用户无需在终端输入任何命令、也无需手工编辑配置。
 *
 *   GET  /__canvas-agent/status  返回 { running, url, token }（token 仅本机可读，loopback 限定）
 *   POST /__canvas-agent/start   若未运行则拉起后端，返回 { starting }；已在运行则 { alreadyRunning }
 *   POST /__canvas-agent/stop    仅停止本接口拉起的进程（不会误杀 DSH 等外部托管实例）
 *   POST /__canvas-agent/sync-codex  把渠道的 baseUrl + API Key + 模型写进 Codex 配置（先自动备份）
 *
 * 启动命令优先级：
 *   1) 已存在的 DSH 托管后端 ~/.dsh/canvas-agent/backend（无需重新下载 ~427MB）
 *   2) npx -y @basketikun/canvas-agent@latest（复用 npm 缓存；首次会下载）
 *
 * 仅在 vite serve 阶段注册，不影响构建产物；所有接口只接受**来自本机**的请求
 * （loopback，或来源地址就是本机网卡地址之一 —— 同一台机器用局域网 IP / 机器名打开画布时
 * 属于后者），局域网内其它设备一律拒绝。
 */

const AGENT_PORT = 17371;
const AGENT_HOST = "127.0.0.1";
const TOKEN_FILE = join(homedir(), ".infinite-canvas", "canvas-agent.json");
const DSH_BACKEND = join(homedir(), ".dsh", "canvas-agent", "backend", "node_modules", "@basketikun", "canvas-agent", "dist", "index.js");

/** Codex 配置目录（供应商 / 密钥都在这里，canvas-agent 启动时原样读取，不做任何覆盖）。 */
const CODEX_DIR = join(homedir(), ".codex");
const CODEX_CONFIG = join(CODEX_DIR, "config.toml");
const CODEX_AUTH = join(CODEX_DIR, "auth.json");
/** 只改写这个 provider 块，其余配置（含 WeSight 托管注释与其它 provider）原样保留。 */
const CODEX_PROVIDER = "custom";

type StartState = { starting: boolean; pid: number | null; error: string | null };

/**
 * 本机网卡地址集合（含 IPv4-mapped 形式），5 秒缓存。
 * 「来源地址 ∈ 本机网卡地址」等价于「请求由本机发出」：局域网里其它设备发起请求时，
 * remoteAddress 是**它自己**的地址，不可能等于本机网卡地址（那会构成 IP 冲突）。
 */
let localAddressCache: { at: number; set: Set<string> } | null = null;
export function localAddresses(): Set<string> {
    if (localAddressCache && Date.now() - localAddressCache.at < 5000) return localAddressCache.set;
    const set = new Set<string>(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
    try {
        for (const entries of Object.values(networkInterfaces())) {
            for (const info of entries ?? []) {
                if (!info.address) continue;
                const addr = info.address.toLowerCase();
                set.add(addr);
                // IPv4 在双栈 socket 上会以 ::ffff:x.x.x.x 呈现，两种写法都要认。
                if (info.family === "IPv4" || /^\d+\.\d+\.\d+\.\d+$/.test(addr)) set.add(`::ffff:${addr}`);
            }
        }
    } catch {
        /* 取不到网卡信息时仅保留 loopback：宁可拒绝，也不放宽 */
    }
    localAddressCache = { at: Date.now(), set };
    return set;
}

/**
 * 是否来自本机：loopback，或来源地址就是本机网卡地址之一。
 * 后者覆盖「同一台机器用局域网 IP / 机器名打开画布」的情形 —— 此时 remoteAddress 是
 * 192.168.x.x 这类地址而不是 127.0.0.1，旧的纯 loopback 判定会把本机用户误判成外部设备，
 * 导致「一键启动后端」静默失效。局域网其它设备仍然被拒。
 */
export function isLocalRequest(req: Connect.IncomingMessage) {
    // 链路本地 IPv6 会带 zone（fe80::1%12），比对前去掉。
    const addr = (req.socket?.remoteAddress || "").toLowerCase().split("%")[0];
    if (addr) return localAddresses().has(addr);
    const host = String(req.headers.host || "");
    return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

const sendJson = (res: Parameters<Connect.NextHandleFunction>[1], status: number, body: unknown) => {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
};

async function agentReachable(): Promise<boolean> {
    try {
        const res = await fetch(`http://${AGENT_HOST}:${AGENT_PORT}/config`);
        return res.ok;
    } catch {
        return false;
    }
}

function readToken(): string | null {
    try {
        const data = JSON.parse(readFileSync(TOKEN_FILE, "utf8")) as { token?: string };
        return typeof data.token === "string" && data.token ? data.token : null;
    } catch {
        return null;
    }
}

/** 读取请求体 JSON（仅在需要时使用，避免影响其它接口）。 */
async function readJsonBody(req: Connect.IncomingMessage): Promise<Record<string, unknown>> {
    const raw = await new Promise<string>((resolve, reject) => {
        let data = "";
        req.on("data", (chunk) => {
            data += String(chunk);
            if (data.length > 1_000_000) reject(new Error("请求体过大"));
        });
        req.on("end", () => resolve(data));
        req.on("error", reject);
    });
    if (!raw.trim()) return {};
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
        throw new Error("请求体不是合法 JSON");
    }
}

const tomlString = (value: string) => JSON.stringify(value);

/** 文件备份：原名 + 时间戳后缀，失败不影响主流程但会向上抛出。 */
function backupFile(file: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const target = `${file}.bak-${stamp}`;
    copyFileSync(file, target);
    return target;
}

type SyncResult = {
    ok: boolean;
    error?: string;
    backup?: { config: string; auth: string };
    applied?: { modelProvider: string; model: string; baseUrl: string; wireApi: string | null };
    changed?: string[];
};

/**
 * 把渠道配置写进 Codex：只改三处（顶层 model_provider / model，以及 [model_providers.custom] 的 base_url），
 * 并把 API Key 写进 auth.json。其余内容（含 WeSight 托管注释、其它 provider、projects 段）逐字保留。
 */
function syncCodexConfig(input: { baseUrl: string; apiKey: string; model: string }): SyncResult {
    if (!existsSync(CODEX_CONFIG)) return { ok: false, error: "未找到 Codex 配置文件" };

    const source = readFileSync(CODEX_CONFIG, "utf8");
    const lines = source.split(/\r?\n/);
    const changed: string[] = [];
    let section = "";
    let inCustomProvider = false;
    let sawModelProvider = false;
    let sawModel = false;
    let sawBaseUrl = false;
    let wireApi: string | null = null;
    const newline = source.includes("\r\n") ? "\r\n" : "\n";

    for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();

        if (/^\[.+\]\s*$/.test(trimmed)) {
            section = trimmed.slice(1, -1).trim().replace(/^["']|["']$/g, "");
            inCustomProvider = section === `model_providers.${CODEX_PROVIDER}`;
            continue;
        }

        const keyMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(trimmed);
        if (!keyMatch) continue;
        const key = keyMatch[1];

        if (!section) {
            if (key === "model_provider") {
                sawModelProvider = true;
                if (trimmed !== `model_provider = ${tomlString(CODEX_PROVIDER)}`) {
                    lines[i] = `model_provider = ${tomlString(CODEX_PROVIDER)}`;
                    changed.push("model_provider");
                }
            } else if (key === "model") {
                sawModel = true;
                if (trimmed !== `model = ${tomlString(input.model)}`) {
                    lines[i] = `model = ${tomlString(input.model)}`;
                    changed.push("model");
                }
            }
            continue;
        }

        if (inCustomProvider) {
            if (key === "base_url") {
                sawBaseUrl = true;
                if (trimmed !== `base_url = ${tomlString(input.baseUrl)}`) {
                    lines[i] = `base_url = ${tomlString(input.baseUrl)}`;
                    changed.push("model_providers.custom.base_url");
                }
            } else if (key === "wire_api") {
                wireApi = keyMatch[2].replace(/^["']|["']$/g, "");
            }
        }
    }

    if (!sawBaseUrl) return { ok: false, error: `Codex 配置中缺少 [model_providers.${CODEX_PROVIDER}] 的 base_url，未做改动` };
    if (!sawModelProvider) return { ok: false, error: "Codex 配置中缺少顶层 model_provider，未做改动" };
    if (!sawModel) return { ok: false, error: "Codex 配置中缺少顶层 model，未做改动" };

    const backups = { config: backupFile(CODEX_CONFIG), auth: "" };
    writeFileSync(CODEX_CONFIG, lines.join(newline));

    // API Key 单独存放：Codex 只认这里的 OPENAI_API_KEY。
    let auth: Record<string, unknown> = {};
    if (existsSync(CODEX_AUTH)) {
        try {
            auth = JSON.parse(readFileSync(CODEX_AUTH, "utf8")) as Record<string, unknown>;
        } catch {
            auth = {};
        }
        backups.auth = backupFile(CODEX_AUTH);
    }
    auth.OPENAI_API_KEY = input.apiKey;
    writeFileSync(CODEX_AUTH, `${JSON.stringify(auth, null, 2)}${newline}`);

    return {
        ok: true,
        backup: backups,
        applied: { modelProvider: CODEX_PROVIDER, model: input.model, baseUrl: input.baseUrl, wireApi },
        changed,
    };
}

function findDshNode(): string | null {
    const base = join(homedir(), "Downloads");
    if (!existsSync(base)) return null;
    let best: string | null = null;
    try {
        for (const entry of readdirSync(base)) {
            if (entry.startsWith("DSH Desktop")) {
                const candidate = join(base, entry, "resources", "node", "node.exe");
                if (existsSync(candidate)) best = candidate;
            }
        }
    } catch {
        /* ignore */
    }
    return best;
}

function resolveStartCommand(): { command: string; args: string[]; shell: boolean } {
    if (existsSync(DSH_BACKEND)) {
        // 优先用 DSH 自带的 node 运行其后端，与官方启动方式一致；找不到就退回当前 node。
        const node = findDshNode() ?? process.execPath;
        return { command: node, args: [DSH_BACKEND], shell: false };
    }
    // 回退：npx 会复用已缓存的包；首次会下载 ~427MB 平台包。
    return { command: "npx", args: ["-y", "@basketikun/canvas-agent@latest"], shell: true };
}

export function canvasAgentLauncher(): Plugin {
    const state: StartState = { starting: false, pid: null, error: null };

    const tryStart = (): { ok: boolean; error?: string } => {
        if (state.starting) return { ok: false, error: "starting" };
        if (state.pid) return { ok: false, error: "already" };
        state.starting = true;
        state.error = null;
        const { command, args, shell } = resolveStartCommand();
        try {
            const child = spawn(command, args, { shell, windowsHide: true, stdio: "ignore" });
            state.pid = child.pid ?? null;
            child.on("error", (error) => {
                state.error = error.message;
                state.starting = false;
            });
            child.on("exit", (code) => {
                if (state.pid === child.pid) {
                    state.pid = null;
                    state.starting = false;
                    if (code && code !== 0) state.error = `agent exited with code ${code}`;
                }
            });
            return { ok: true };
        } catch (error) {
            state.starting = false;
            state.error = (error as Error).message;
            return { ok: false, error: state.error };
        }
    };

    return {
        name: "canvas-agent-launcher",
        apply: "serve",
        configureServer(server) {
            server.middlewares.use(async (req, res, next) => {
                const url = (req.url || "").split("?")[0];
                if (!url.startsWith("/__canvas-agent/")) return next();
                if (!isLocalRequest(req)) return sendJson(res, 403, { ok: false, error: "仅允许本机访问（当前请求来自局域网内的其它设备）" });

                if (req.method === "GET" && url === "/__canvas-agent/status") {
                    const running = await agentReachable();
                    return sendJson(res, 200, {
                        ok: true,
                        running,
                        url: running ? `http://${AGENT_HOST}:${AGENT_PORT}` : null,
                        token: running ? readToken() : null,
                    });
                }

                if (req.method === "POST" && url === "/__canvas-agent/start") {
                    if (await agentReachable()) return sendJson(res, 200, { ok: true, running: true, alreadyRunning: true });
                    const result = tryStart();
                    if (!result.ok && result.error !== "already" && result.error !== "starting") {
                        return sendJson(res, 500, { ok: false, error: result.error });
                    }
                    return sendJson(res, 200, { ok: true, starting: state.starting });
                }

                if (req.method === "POST" && url === "/__canvas-agent/sync-codex") {
                    let body: Record<string, unknown>;
                    try {
                        body = await readJsonBody(req);
                    } catch (error) {
                        return sendJson(res, 400, { ok: false, error: (error as Error).message });
                    }
                    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
                    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
                    const model = typeof body.model === "string" ? body.model.trim() : "";
                    if (!/^https?:\/\/[^\s]+$/i.test(baseUrl)) return sendJson(res, 400, { ok: false, error: "接口地址无效" });
                    if (!apiKey) return sendJson(res, 400, { ok: false, error: "缺少 API Key" });
                    if (!model) return sendJson(res, 400, { ok: false, error: "缺少模型名称" });
                    try {
                        const result = syncCodexConfig({ baseUrl, apiKey, model });
                        return sendJson(res, result.ok ? 200 : 400, result);
                    } catch (error) {
                        return sendJson(res, 500, { ok: false, error: (error as Error).message });
                    }
                }

                if (req.method === "POST" && url === "/__canvas-agent/stop") {
                    if (state.pid) {
                        try {
                            process.kill(state.pid);
                        } catch {
                            /* ignore */
                        }
                        state.pid = null;
                        state.starting = false;
                    }
                    return sendJson(res, 200, { ok: true });
                }

                return sendJson(res, 404, { ok: false, error: "未知的接口" });
            });
        },
    };
}
