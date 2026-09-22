import { readZip } from "@/lib/zip";

import type { ParsedSkill } from "./data/types";

/**
 * 技能导入层：把「本地文件 / 文件夹 / zip / GitHub / Gitee 链接」统一解析成
 * 可安装的 `ParsedSkill`，并做一次风险扫描，供「非高风险自动安装」使用。
 *
 * 这里的解析规则对齐本机 Canvas Agent 的 SkillStore 校验（名称只能用
 * 小写字母、数字与连字符；描述 ≤1024 且不能含尖括号；正文 ≤256KiB），
 * 因此解析通过的内容基本可以直接安装成功。
 */

export const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SKILL_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_INSTRUCTIONS_BYTES = 256 * 1024;
const MAX_SKILL_FILES = 20;

/** 解析失败原因（组件据此翻译文案）。 */
export type SkillParseErrorCode =
    | "nameInvalid"
    | "descriptionMissing"
    | "descriptionTooLong"
    | "descriptionHasAngleBrackets"
    | "instructionsMissing"
    | "instructionsTooLarge"
    | "frontmatterMissing"
    | "noMarkdownFile";

export type SkillParseFailure = { name: string; code: SkillParseErrorCode };

export type ParseOutcome = {
    skills: ParsedSkill[];
    failures: SkillParseFailure[];
};

/** 远程来源类型。 */
export type RemoteSkillSource =
    | { kind: "raw"; url: string; label: string }
    | { kind: "github"; owner: string; repo: string; ref?: string; path?: string }
    | { kind: "gitee"; owner: string; repo: string; ref?: string; path?: string };

export type RemoteErrorCode = "invalidUrl" | "unsupported" | "network" | "notFound" | "noSkills" | "tooMany";

/* ------------------------------------------------------------------ *
 * SKILL.md 解析
 * ------------------------------------------------------------------ */

type Frontmatter = { data: Record<string, string>; body: string; present: boolean };

/** 解析 `---` 包裹的简易 YAML frontmatter（只取标量与行内数组）。 */
export function splitFrontmatter(raw: string): Frontmatter {
    const normalized = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---")) return { data: {}, body: normalized.trim(), present: false };
    const lines = normalized.split("\n");
    let end = -1;
    for (let index = 1; index < lines.length; index += 1) {
        if (lines[index].trim() === "---") {
            end = index;
            break;
        }
    }
    if (end === -1) return { data: {}, body: normalized.trim(), present: false };
    const data: Record<string, string> = {};
    for (const line of lines.slice(1, end)) {
        const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) continue;
        data[match[1]] = unquote(match[2]);
    }
    return { data, body: lines.slice(end + 1).join("\n").trim(), present: true };
}

function unquote(value: string) {
    const text = (value || "").trim();
    if (text.length >= 2 && ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'")))) {
        return text.slice(1, -1);
    }
    return text;
}

function frontmatterValue(data: Record<string, string>, keys: string[]) {
    for (const key of keys) {
        const value = data[key];
        if (typeof value === "string" && value.trim()) return value.trim();
    }
    return "";
}

/** 从一段 SKILL.md 文本解析出可安装技能。 */
export function parseSkillMarkdown(raw: string, fallbackLabel: string, origin: string): { ok: true; skill: ParsedSkill } | { ok: false; code: SkillParseErrorCode } {
    const { data, body, present } = splitFrontmatter(raw);
    const name = frontmatterValue(data, ["name"]).toLowerCase();
    const description = frontmatterValue(data, ["description"]);
    if (!present || !name || !description) return { ok: false, code: "frontmatterMissing" };
    if (!SKILL_NAME_PATTERN.test(name) || name.length > MAX_SKILL_NAME) return { ok: false, code: "nameInvalid" };
    if (description.length > MAX_DESCRIPTION) return { ok: false, code: "descriptionTooLong" };
    if (description.includes("<") || description.includes(">")) return { ok: false, code: "descriptionHasAngleBrackets" };
    if (!body) return { ok: false, code: "instructionsMissing" };
    if (new TextEncoder().encode(body).length > MAX_INSTRUCTIONS_BYTES) return { ok: false, code: "instructionsTooLarge" };

    const skillInterface = parseInterface(data, name);
    const risk = riskScan({ name, description, instructions: body });
    return {
        ok: true,
        skill: {
            name,
            description,
            instructions: body,
            ...(skillInterface ? { interface: skillInterface } : {}),
            origin,
            risky: risk.risky,
            riskReasons: risk.reasons,
        },
    };
}

/** 只接受合法区间内的界面元数据，避免安装时被 SkillStore 拒绝。 */
function parseInterface(data: Record<string, string>, name: string) {
    const displayName = frontmatterValue(data, ["display_name", "displayName", "display-name", "title"]);
    const shortDescription = frontmatterValue(data, ["short_description", "shortDescription", "short-description"]);
    const defaultPrompt = frontmatterValue(data, ["default_prompt", "defaultPrompt", "default-prompt"]);
    const value = {
        ...(displayName && displayName.length <= 64 ? { displayName } : {}),
        ...(shortDescription.length >= 25 && shortDescription.length <= 64 ? { shortDescription } : {}),
        ...(defaultPrompt.includes(`$${name}`) && defaultPrompt.length <= 1024 ? { defaultPrompt } : {}),
    };
    return Object.keys(value).length ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * 风险扫描（供「非高风险自动安装」判定）
 * ------------------------------------------------------------------ */

const RISK_RULES: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\brm\s+-[a-z]*[rf]/i, reason: "包含递归删除命令" },
    { pattern: /remove-item\s+.*-recurse/i, reason: "包含递归删除命令" },
    { pattern: /\b(curl|wget|iwr|invoke-webrequest)\b[^\n|]*\|\s*(sh|bash|zsh|iex|powershell)/i, reason: "包含管道执行远程脚本" },
    { pattern: /\bsudo\b/i, reason: "要求提权执行" },
    { pattern: /\b(eval|exec)\s*\(/i, reason: "包含动态执行代码" },
    { pattern: /base64\s+(-d|--decode)/i, reason: "包含解码后执行的可疑内容" },
    { pattern: /(api[_-]?key|secret|password|passwd|access[_-]?token)\s*[:=]\s*["'][^"']{12,}["']/i, reason: "包含疑似明文凭证" },
    { pattern: /\/etc\/(passwd|shadow|sudoers)/i, reason: "涉及系统敏感文件" },
    { pattern: /[A-Za-z]:\\Windows\\/i, reason: "涉及系统目录写入" },
    { pattern: /(^|\n)\s*(子)?进程注入|反调试|hook\s+syscall/i, reason: "包含可疑系统行为描述" },
];

export function riskScan(input: Pick<ParsedSkill, "name" | "description" | "instructions">) {
    const text = `${input.name}\n${input.description}\n${input.instructions}`;
    const reasons = RISK_RULES.filter((rule) => rule.pattern.test(text)).map((rule) => rule.reason);
    return { risky: reasons.length > 0, reasons };
}

/* ------------------------------------------------------------------ *
 * 本地文件 / 文件夹 / zip
 * ------------------------------------------------------------------ */

type Entry = { path: string; blob: Blob };

function baseName(path: string) {
    const segments = path.split("/").filter(Boolean);
    return segments[segments.length - 1] || path;
}

function normalizePath(path: string) {
    return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** 从一组「路径 → 内容」中抽取技能：优先 SKILL.md，其次任意 .md。 */
export async function extractSkills(entries: Entry[], originLabel: string): Promise<ParseOutcome> {
    const skills: ParsedSkill[] = [];
    const failures: SkillParseFailure[] = [];
    const skillMd = entries.filter((entry) => baseName(entry.path).toLowerCase() === "skill.md");
    const candidates = skillMd.length ? skillMd : entries.filter((entry) => /\.md$/i.test(entry.path));
    if (!candidates.length) return { skills, failures: [{ name: originLabel, code: "noMarkdownFile" }] };
    for (const entry of candidates.slice(0, MAX_SKILL_FILES)) {
        const text = await entry.blob.text().catch(() => "");
        const label = baseName(entry.path);
        const result = parseSkillMarkdown(text, label, originLabel ? `${originLabel} · ${entry.path}` : entry.path);
        if (result.ok) skills.push(result.skill);
        else failures.push({ name: label, code: result.code });
    }
    return { skills, failures };
}

/** 解析用户选择（或拖入）的文件与文件夹。 */
export async function parseLocalSkills(files: File[]): Promise<ParseOutcome> {
    const zipFiles = files.filter((file) => /\.zip$/i.test(file.name));
    const plainFiles = files.filter((file) => !/\.zip$/i.test(file.name));
    const skills: ParsedSkill[] = [];
    const failures: SkillParseFailure[] = [];

    for (const file of zipFiles.slice(0, 5)) {
        try {
            const entries = Array.from((await readZip(file)).entries()).map(([path, blob]) => ({ path: normalizePath(path), blob }));
            const outcome = await extractSkills(entries, file.name);
            skills.push(...outcome.skills);
            failures.push(...outcome.failures);
        } catch {
            failures.push({ name: file.name, code: "noMarkdownFile" });
        }
    }

    if (plainFiles.length) {
        const entries = plainFiles.map((file) => ({ path: normalizePath(file.webkitRelativePath || file.name), blob: file }));
        const outcome = await extractSkills(entries, "");
        skills.push(...outcome.skills);
        failures.push(...outcome.failures);
    }

    return { skills: dedupeSkills(skills), failures };
}

function dedupeSkills(list: ParsedSkill[]) {
    const seen = new Map<string, ParsedSkill>();
    for (const skill of list) if (!seen.has(skill.name)) seen.set(skill.name, skill);
    return Array.from(seen.values());
}

/* ------------------------------------------------------------------ *
 * 远程链接（GitHub / Gitee / 直链）
 * ------------------------------------------------------------------ */

/** 解析用户输入的仓库 / 直链地址。 */
export function parseRemoteSource(input: string): RemoteSkillSource | { error: RemoteErrorCode } {
    const value = input.trim();
    if (!value) return { error: "invalidUrl" };
    let url: URL;
    try {
        url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    } catch {
        return { error: "invalidUrl" };
    }
    const segments = url.pathname.split("/").filter(Boolean);
    const host = url.hostname.toLowerCase();

    if (host === "raw.githubusercontent.com") return { kind: "raw", url: url.toString(), label: `${segments[0] || ""}/${segments[1] || ""}` };

    if (host === "github.com" || host === "www.github.com") {
        if (segments.length < 2) return { error: "invalidUrl" };
        const [owner, repo] = segments;
        const rest = segments.slice(2);
        const marker = rest[0]?.toLowerCase();
        if (marker === "tree" || marker === "blob") {
            const ref = rest[1];
            const sub = rest.slice(2).join("/");
            if (marker === "blob" && ref) {
                return { kind: "raw", url: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${sub}`, label: `${owner}/${repo}` };
            }
            return { kind: "github", owner, repo, ...(ref ? { ref } : {}), ...(sub ? { path: sub } : {}) };
        }
        return { kind: "github", owner, repo };
    }

    if (host === "gitee.com" || host === "www.gitee.com") {
        if (segments.length < 2) return { error: "invalidUrl" };
        const [owner, repo] = segments;
        const rest = segments.slice(2);
        const marker = rest[0]?.toLowerCase();
        if (marker === "tree" || marker === "blob" || marker === "raw") {
            const ref = rest[1];
            const sub = rest.slice(2).join("/");
            if ((marker === "blob" || marker === "raw") && ref) {
                return { kind: "raw", url: `https://gitee.com/${owner}/${repo}/raw/${ref}/${sub}`, label: `${owner}/${repo}` };
            }
            return { kind: "gitee", owner, repo, ...(ref ? { ref } : {}), ...(sub ? { path: sub } : {}) };
        }
        return { kind: "gitee", owner, repo };
    }

    // 其它域名按直链处理（SKILL.md / .md / .zip）
    return { kind: "raw", url: url.toString(), label: host };
}

async function fetchText(url: string) {
    const response = await fetch(url, { headers: { accept: "text/plain,*/*" } });
    if (!response.ok) throw new Error(String(response.status));
    return await response.text();
}

async function fetchBlob(url: string) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(String(response.status));
    return await response.blob();
}

/** 抓取并解析远程来源中的技能。 */
export async function fetchRemoteSkills(source: RemoteSkillSource): Promise<{ skills: ParsedSkill[] } | { error: RemoteErrorCode }> {
    try {
        if (source.kind === "raw") {
            const label = source.label || "remote";
            if (/\.zip(\?|#|$)/i.test(source.url)) {
                const blob = await fetchBlob(source.url);
                const entries = Array.from((await readZip(blob)).entries()).map(([path, entryBlob]) => ({ path: normalizePath(path), blob: entryBlob }));
                const outcome = await extractSkills(entries, label);
                return outcome.skills.length ? { skills: outcome.skills } : { error: "noSkills" };
            }
            const text = await fetchText(source.url);
            if (/^\s*PK\u0003\u0004/.test(text)) return { error: "noSkills" };
            const result = parseSkillMarkdown(text, label, source.url);
            return result.ok ? { skills: [result.skill] } : { error: "noSkills" };
        }
        const listed = source.kind === "github" ? await listGithubSkills(source) : await listGiteeSkills(source);
        if ("error" in listed) return listed;
        return { skills: listed.skills };
    } catch {
        return { error: "network" };
    }
}

type RemoteListing = { skills: ParsedSkill[] } | { error: RemoteErrorCode };

async function listGithubSkills(source: Extract<RemoteSkillSource, { kind: "github" }>): Promise<RemoteListing> {
    const repo = await fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}`);
    const branch = source.ref || stringField(repo, "default_branch") || "main";
    const tree = await fetchJson(`https://api.github.com/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const paths = treePaths(tree).filter((path) => /(^|\/)skill\.md$/i.test(path));
    const scoped = source.path ? paths.filter((path) => path.toLowerCase().startsWith(`${source.path!.toLowerCase().replace(/\/+$/, "")}/`)) : paths;
    const targets = (scoped.length ? scoped : paths).slice(0, MAX_SKILL_FILES);
    if (!targets.length) return { error: "noSkills" };
    const skills: ParsedSkill[] = [];
    for (const path of targets) {
        const raw = await fetchText(`https://raw.githubusercontent.com/${source.owner}/${source.repo}/${encodeURIComponent(branch)}/${encodePath(path)}`);
        const result = parseSkillMarkdown(raw, baseName(path), `github.com/${source.owner}/${source.repo}`);
        if (result.ok) skills.push(result.skill);
    }
    return skills.length ? { skills: dedupeSkills(skills) } : { error: "noSkills" };
}

async function listGiteeSkills(source: Extract<RemoteSkillSource, { kind: "gitee" }>): Promise<RemoteListing> {
    const repo = await fetchJson(`https://gitee.com/api/v5/repos/${source.owner}/${source.repo}`);
    const branch = source.ref || stringField(repo, "default_branch") || "master";
    const tree = await fetchJson(`https://gitee.com/api/v5/repos/${source.owner}/${source.repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`);
    const paths = treePaths(tree).filter((path) => /(^|\/)skill\.md$/i.test(path));
    const scoped = source.path ? paths.filter((path) => path.toLowerCase().startsWith(`${source.path!.toLowerCase().replace(/\/+$/, "")}/`)) : paths;
    const targets = (scoped.length ? scoped : paths).slice(0, MAX_SKILL_FILES);
    if (!targets.length) return { error: "noSkills" };
    const skills: ParsedSkill[] = [];
    for (const path of targets) {
        const raw = await fetchText(`https://gitee.com/${source.owner}/${source.repo}/raw/${encodeURIComponent(branch)}/${encodePath(path)}`);
        const result = parseSkillMarkdown(raw, baseName(path), `gitee.com/${source.owner}/${source.repo}`);
        if (result.ok) skills.push(result.skill);
    }
    return skills.length ? { skills: dedupeSkills(skills) } : { error: "noSkills" };
}

async function fetchJson(url: string) {
    const response = await fetch(url, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(String(response.status));
    return (await response.json()) as unknown;
}

function stringField(value: unknown, key: string) {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    return typeof record[key] === "string" ? (record[key] as string) : "";
}

function treePaths(value: unknown): string[] {
    const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
    const tree = Array.isArray(record.tree) ? record.tree : [];
    return tree
        .map((entry) => (entry && typeof entry === "object" ? (entry as Record<string, unknown>).path : ""))
        .filter((path): path is string => typeof path === "string" && Boolean(path));
}

function encodePath(path: string) {
    return path.split("/").map(encodeURIComponent).join("/");
}
