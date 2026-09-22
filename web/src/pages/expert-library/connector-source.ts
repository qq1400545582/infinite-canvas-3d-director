import type { ConnectorConfig, ConnectorTransport } from "./data/types";
import { parseRemoteSource, type RemoteErrorCode, type RemoteSkillSource } from "./skill-source";

/**
 * 自定义连接器解析层：把「JSON 配置文本」与「开源仓库 / 配置直链」统一解析成
 * 可保存的 `ConnectorConfig`，供「配置连接器」弹窗使用。
 *
 * 兼容主流 MCP 客户端导出的配置片段，使「从链接安装」可以直接粘贴作者提供的
 * 配置，而不必逐项手填：
 *   · `{ "mcpServers": { "<name>": { command, args, env } } }`（Claude / Cursor 等）
 *   · `{ "servers": { … } }` / `{ "mcp": { "servers": { … } } }`
 *   · `[{ name, url, headers }]` / 单个 `{ name, command }`
 *
 * 注意：解析结果是「配置」而非「已连接」。真正的接入由画布智能体在调用时完成，
 * 这里不建立连接，避免与其它模块的 Agent 生命周期耦合。
 */

export type ConnectorParseErrorCode =
    | "invalidJson"
    | "noServers"
    | "nameMissing"
    | "endpointMissing"
    | "emptyText"
    | "tooMany";

export type ConnectorParseOutcome = { ok: true; configs: ConnectorConfig[] } | { ok: false; code: ConnectorParseErrorCode };

/** 一次最多导入的连接器数量，避免误粘贴超大清单。 */
const MAX_CONNECTORS = 50;

/* ------------------------------------------------------------------ *
 * 单个服务条目 → ConnectorConfig
 * ------------------------------------------------------------------ */

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
}

/** 参数支持数组或空格分隔的字符串两种写法。 */
function argsValue(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
    const text = stringValue(value);
    if (!text) return [];
    return text.split(/\s+/).filter(Boolean);
}

function pairsValue(value: unknown): Record<string, string> {
    const record = asRecord(value);
    if (!record) return {};
    const out: Record<string, string> = {};
    for (const [key, raw] of Object.entries(record)) {
        const text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
        if (key.trim()) out[key.trim()] = text;
    }
    return out;
}

/** 依据显式 type/transport 或 URL 形态推断传输方式。 */
function transportValue(type: unknown, url: string, hasCommand: boolean): ConnectorTransport {
    const declared = stringValue(type).toLowerCase();
    if (declared.includes("stdio") || hasCommand) return "stdio";
    if (declared.includes("sse")) return "sse";
    if (declared.includes("http")) return "http";
    if (/\/sse\/?($|\?)/i.test(url)) return "sse";
    return url ? "http" : "stdio";
}

// 常见别名：不同客户端的字段名不一致，这里统一收敛。
const NAME_KEYS = ["name", "id", "title", "serverName", "server_name", "label"];
const COMMAND_KEYS = ["command", "cmd", "bin", "executable"];
const URL_KEYS = ["url", "endpoint", "baseUrl", "base_url", "serverUrl", "server_url", "href"];
const TYPE_KEYS = ["type", "transport", "protocol", "kind"];
const ARGS_KEYS = ["args", "arguments", "argv"];
const ENV_KEYS = ["env", "environment", "envVars", "env_vars"];
const HEADER_KEYS = ["headers", "header", "httpHeaders", "http_headers"];
const DESC_KEYS = ["description", "desc", "summary", "note", "purpose"];

function pick(record: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null && record[key] !== "") return record[key];
    }
    return undefined;
}

/** 把一条服务配置（任意客户端字段名）归一成 ConnectorConfig。 */
export function toConnectorConfig(
    name: string,
    value: unknown,
    meta: { from: ConnectorConfig["from"]; source?: string; at?: number },
): ConnectorConfig | null {
    const record = asRecord(value);
    if (!record) return null;

    const command = stringValue(pick(record, COMMAND_KEYS));
    const url = stringValue(pick(record, URL_KEYS));
    if (!command && !url) return null;

    const transport = transportValue(pick(record, TYPE_KEYS), url, Boolean(command));
    const env = pairsValue(pick(record, transport === "stdio" ? ENV_KEYS : HEADER_KEYS));
    const args = argsValue(pick(record, ARGS_KEYS));
    const description = stringValue(pick(record, DESC_KEYS));
    const finalName = stringValue(pick(record, NAME_KEYS)) || name;

    return {
        name: finalName,
        transport,
        ...(command ? { command } : {}),
        ...(args.length ? { args } : {}),
        ...(url ? { url } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(description ? { description } : {}),
        // 导入的配置默认启用，用户可在列表里随时停用
        enabled: record.disabled === true || record.enabled === false ? false : true,
        at: meta.at ?? Date.now(),
        from: meta.from,
        ...(meta.source ? { source: meta.source } : {}),
    };
}

/* ------------------------------------------------------------------ *
 * 文本 → 若干 ConnectorConfig
 * ------------------------------------------------------------------ */

/** 从对象里找出承载服务字典的容器（mcpServers / servers / mcp.servers …）。 */
function serverContainer(record: Record<string, unknown>): { named: boolean; value: unknown } | null {
    for (const key of ["mcpServers", "mcp_servers", "servers", "mcp", "connectors"]) {
        const candidate = record[key];
        const inner = asRecord(candidate);
        if (!inner) continue;
        // `mcp: { servers: {...} }` 这一层再往下钻一次
        for (const nestKey of ["mcpServers", "mcp_servers", "servers", "connectors"]) {
            if (asRecord(inner[nestKey])) return { named: true, value: inner[nestKey] };
        }
        return { named: true, value: candidate };
    }
    return null;
}

/** 从一段 JSON 文本解析连接器；支持清单、数组与单个服务三种形态。 */
export function parseConnectorText(
    raw: string,
    meta: { from: ConnectorConfig["from"]; source?: string; fallbackName?: string } = { from: "import" },
): ConnectorParseOutcome {
    const text = raw.trim();
    if (!text) return { ok: false, code: "emptyText" };

    let parsed: unknown;
    try {
        parsed = JSON.parse(stripJsonNoise(text));
    } catch {
        return { ok: false, code: "invalidJson" };
    }

    const configs: ConnectorConfig[] = [];
    const push = (name: string, value: unknown) => {
        const config = toConnectorConfig(name, value, { from: meta.from, source: meta.source });
        if (config) configs.push(config);
    };

    if (Array.isArray(parsed)) {
        parsed.forEach((entry, index) => {
            const record = asRecord(entry);
            const name = record ? stringValue(pick(record, NAME_KEYS)) : "";
            push(name || `${meta.fallbackName || "连接器"} ${index + 1}`, entry);
        });
    } else {
        const record = asRecord(parsed);
        if (!record) return { ok: false, code: "invalidJson" };
        const container = serverContainer(record);
        if (container && asRecord(container.value)) {
            for (const [name, value] of Object.entries(container.value as Record<string, unknown>)) push(name, value);
        } else if (container && Array.isArray(container.value)) {
            (container.value as unknown[]).forEach((entry, index) => {
                const entryRecord = asRecord(entry);
                const name = entryRecord ? stringValue(pick(entryRecord, NAME_KEYS)) : "";
                push(name || `${meta.fallbackName || "连接器"} ${index + 1}`, entry);
            });
        } else {
            // 单个服务对象：优先用其自带 name，其次用调用方给的兜底名
            push(stringValue(pick(record, NAME_KEYS)) || meta.fallbackName || "", parsed);
        }
    }

    if (!configs.length) {
        // 能解析成 JSON 但没有可识别的服务端点，区分「格式不认识」与「缺端点」
        const record = asRecord(parsed);
        if (record && (pick(record, COMMAND_KEYS) || pick(record, URL_KEYS))) return { ok: false, code: "nameMissing" };
        return { ok: false, code: "noServers" };
    }
    if (configs.some((config) => !config.name)) return { ok: false, code: "nameMissing" };
    if (configs.length > MAX_CONNECTORS) return { ok: false, code: "tooMany" };

    return { ok: true, configs: dedupe(configs) };
}

/** 容忍用户粘贴 JSON 片段时带的注释、行尾逗号与代码围栏。 */
function stripJsonNoise(text: string) {
    return text
        .replace(/^```[a-zA-Z]*\s*/m, "")
        .replace(/```\s*$/m, "")
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/,(\s*[}\]])/g, "$1")
        .trim();
}

/** 从 Markdown（README 等）里抽出第一个包含服务清单的 JSON 代码块。 */
export function extractConnectorJsonFromMarkdown(markdown: string): string | null {
    const fences = [...markdown.matchAll(/```(?:json|jsonc|javascript|js)?\s*\n([\s\S]*?)```/gi)].map((match) => match[1]);
    const candidates = [markdown, ...fences];
    for (const candidate of candidates) {
        const outcome = parseConnectorText(candidate, { from: "import" });
        if (outcome.ok) return candidate;
    }
    return null;
}

function dedupe(configs: ConnectorConfig[]) {
    const seen = new Map<string, ConnectorConfig>();
    for (const config of configs) if (!seen.has(config.name)) seen.set(config.name, config);
    return Array.from(seen.values());
}

/* ------------------------------------------------------------------ *
 * 链接导入（GitHub / Gitee / 配置直链）
 * ------------------------------------------------------------------ */

export type LinkedConnectorOutcome = { ok: true; configs: ConnectorConfig[] } | { ok: false; code: ConnectorParseErrorCode | RemoteErrorCode };

/** 仓库里常见的连接器配置文件命名（优先按此顺序查找）。 */
const CONFIG_FILE_PATTERN = /(^|\/)(\.?mcp\.json|mcp[-_.]?config\.json|connectors?\.json|servers?\.json|mcp\.servers\.json)$/i;

async function fetchText(url: string) {
    const response = await fetch(url, { headers: { accept: "text/plain,application/json,*/*" } });
    if (!response.ok) throw new Error(String(response.status));
    return await response.text();
}

async function fetchJson(url: string) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as unknown;
}

function treePaths(value: unknown): string[] {
    const record = asRecord(value);
    const tree = Array.isArray(record?.tree) ? (record!.tree as unknown[]) : [];
    return tree
        .map((entry) => (asRecord(entry) ? String(asRecord(entry)!.path ?? "") : ""))
        .filter((path) => Boolean(path));
}

function encodePath(path: string) {
    return path.split("/").map(encodeURIComponent).join("/");
}

function stringField(value: unknown, key: string) {
    const record = asRecord(value);
    return record && typeof record[key] === "string" ? (record[key] as string) : "";
}

/** 解析并抓取链接里的连接器配置：直链取文件本身，仓库则遍历配置文件名再用 README 兜底。 */
export async function fetchLinkedConnectors(input: string): Promise<LinkedConnectorOutcome> {
    const source: RemoteSkillSource | { error: RemoteErrorCode } = parseRemoteSource(input);
    if ("error" in source) return { ok: false, code: source.error };

    const fromMeta = { from: "link" as const, source: describeSource(source) };

    try {
        if (source.kind === "raw") {
            return fromRaw(source.url, fromMeta);
        }
        const isGithub = source.kind === "github";
        const base = isGithub ? "https://api.github.com/repos" : "https://gitee.com/api/v5/repos";
        const repo = await fetchJson(`${base}/${source.owner}/${source.repo}`);
        const branch = source.ref || stringField(repo, "default_branch") || (isGithub ? "main" : "master");
        const tree = await fetchJson(`${base}/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
        const all = treePaths(tree);
        const scoped = source.path
            ? all.filter((path) => path.toLowerCase().startsWith(`${source.path!.toLowerCase().replace(/\/+$/, "")}/`))
            : all;
        const pool = scoped.length ? scoped : all;
        const targets = pool.filter((path) => CONFIG_FILE_PATTERN.test(path)).slice(0, 5);
        const rawBase = isGithub
            ? `https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(branch)}`
            : `https://gitee.com/${source.owner}/${source.repo}/raw/${encodeURIComponent(branch)}`;

        for (const path of targets) {
            const text = await fetchText(`${rawBase}/${encodePath(path)}`);
            const outcome = parseConnectorText(text, { ...fromMeta, fallbackName: repoName(source) });
            if (outcome.ok) return outcome;
        }

        // 没有独立配置文件时，尝试 README 里的 JSON 代码块
        const readme = pool.find((path) => /(^|\/)readme\.md$/i.test(path));
        if (readme) {
            const markdown = await fetchText(`${rawBase}/${encodePath(readme)}`);
            const json = extractConnectorJsonFromMarkdown(markdown);
            if (json) {
                const outcome = parseConnectorText(json, { ...fromMeta, fallbackName: repoName(source) });
                if (outcome.ok) return outcome;
            }
        }
        return { ok: false, code: "notFound" };
    } catch {
        return { ok: false, code: "network" };
    }
}

async function fromRaw(url: string, meta: { from: "link"; source: string }): Promise<LinkedConnectorOutcome> {
    const fallbackName = inferNameFromUrl(url);
    const text = await fetchText(url);
    const trimmed = text.trim();

    // 直链指向 Markdown / README：先取代码块
    if (/^#|\n#|^\s*<(!doctype|html)/i.test(trimmed.slice(0, 400)) && !trimmed.startsWith("{")) {
        const json = extractConnectorJsonFromMarkdown(trimmed);
        if (!json) return { ok: false, code: "noServers" };
        const outcome = parseConnectorText(json, { ...meta, fallbackName });
        return outcome.ok ? outcome : { ok: false, code: outcome.code };
    }

    const outcome = parseConnectorText(trimmed, { ...meta, fallbackName });
    return outcome.ok ? outcome : { ok: false, code: outcome.code };
}

function repoName(source: Extract<RemoteSkillSource, { kind: "github" | "gitee" }>) {
    return source.repo;
}

function describeSource(source: RemoteSkillSource) {
    if (source.kind === "raw") return source.label || source.url;
    return `${source.kind === "github" ? "github.com" : "gitee.com"}/${source.owner}/${source.repo}`;
}

/** 从直链文件名推断一个可读的连接器名（如 `github.mcp.json` → `github`）。 */
function inferNameFromUrl(url: string) {
    const path = url.split(/[?#]/)[0];
    const file = path.split("/").filter(Boolean).pop() || "";
    return file.replace(/\.(jsonc?|json5|md|txt)$/i, "").replace(/[._-]+/g, " ").trim();
}
