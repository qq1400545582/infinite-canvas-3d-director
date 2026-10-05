import { readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { toolDescriptions, toolInputSchemas, toolNames, type ToolName } from "../canvas/schemas.js";
import { AGENT_PROMPT, CONFIG_DIR, loadConfig, type CanvasAgentConfig, VERSION } from "../config.js";

type CanvasAgentToolResponse = { ok?: boolean; result?: unknown; error?: string };

/** 资源单文件上限：超过后截断返回，避免把超大文件整包塞进模型上下文。 */
const MAX_RESOURCE_BYTES = 1024 * 1024;

/** 启动通过标准输入输出通信的 MCP 服务。 */
export async function startMcpServer() {
    const config = loadConfig(true);
    const server = new McpServer({ name: "canvas-agent", version: VERSION }, { instructions: AGENT_PROMPT });
    toolNames.forEach((name) => registerCanvasTool(server, config, name));
    registerCanvasResources(server, config);
    await server.connect(new StdioServerTransport());
}

/** 向 MCP Server 注册单个 Canvas Agent 工具。 */
function registerCanvasTool(server: McpServer, config: CanvasAgentConfig, name: ToolName) {
    const schema = toolInputSchemas[name];
    server.registerTool(name, { description: toolDescriptions[name], inputSchema: schema.shape }, async (input: unknown) => {
        const result = await postCanvasAgentTool(config, name, schema.parse(input));
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
    });
}

/**
 * 让 MCP 支持资源读取（resources/list + resources/read）。
 *
 * 背景：Codex 的 read_mcp_resource 在本服务上原先得到 -32601 Method not found
 * （高层 SDK 只有调用 registerResource 后才挂资源处理器）。模型读取技能/工作区文件
 * 的请求（如「请使用【hypit】技能」）因此整串失败。这里把工作区与技能目录内的
 * 文本文件作为只读资源暴露；目录之外的路径仍拒绝，避免变成任意文件读取后门。
 */
function registerCanvasResources(server: McpServer, config: CanvasAgentConfig) {
    const roots = resourceRoots(config);
    const workspacePath = path.resolve(config.workspace?.workspacePath || path.join(CONFIG_DIR, "codex-workspaces", "site"));
    server.server.registerCapabilities({ resources: { listChanged: false } });
    server.server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: await listSkillResources(workspacePath) }));
    server.server.setRequestHandler(ReadResourceRequestSchema, async (request) => ({ contents: [await readResourceContents(String(request.params?.uri || ""), roots)] }));
}

/** MCP 资源允许读取的根目录：画布工作区、Canvas Agent 配置目录（含 codex-workspaces）与 Codex 技能目录。 */
export function resourceRoots(config: CanvasAgentConfig): string[] {
    const roots = [config.workspace?.workspacePath || path.join(CONFIG_DIR, "codex-workspaces", "site"), CONFIG_DIR, path.join(os.homedir(), ".codex", "skills")];
    return [...new Set(roots.map((root) => path.resolve(root)))];
}

/** 把资源 URI 还原为本地绝对路径：兼容 file:// URI 与模型直接传来的裸绝对路径。 */
export function resourceTargetPath(rawUri: string): string {
    let value = String(rawUri || "").trim();
    if (!value) throw new Error("资源 URI 为空");
    if (/^file:/i.test(value)) {
        try {
            return path.normalize(fileURLToPath(new URL(value)));
        } catch {
            value = value.replace(/^file:\/\//i, "");
        }
    }
    let candidate = value;
    if (/%[0-9a-f]{2}/i.test(candidate)) {
        try {
            candidate = decodeURIComponent(candidate);
        } catch {
            // 保留原值：非法转义按字面路径处理
        }
    }
    candidate = candidate.replace(/\\/g, "/");
    if (/^\/[a-zA-Z]:\//.test(candidate)) candidate = candidate.slice(1);
    return path.normalize(candidate);
}

function isInsideRoots(candidate: string, roots: string[]) {
    const resolved = path.resolve(candidate);
    return roots.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

/** 读取受控资源文件并包装为 MCP contents；根目录之外的路径一律拒绝。 */
export async function readResourceContents(rawUri: string, roots: string[]) {
    const target = resourceTargetPath(rawUri);
    if (!isInsideRoots(target, roots)) throw new Error(`资源不在允许读取的目录内（仅限画布工作区与技能目录），请改用 shell 读取：${target}`);
    const info = await stat(target).catch(() => null);
    if (!info) throw new Error(`资源不存在：${target}`);
    if (info.isDirectory()) throw new Error(`资源是目录而非文件：${target}`);
    const buffer = await readFile(target);
    const truncated = buffer.byteLength > MAX_RESOURCE_BYTES;
    const text = buffer.subarray(0, MAX_RESOURCE_BYTES).toString("utf8");
    return {
        uri: pathToFileURL(path.resolve(target)).href,
        mimeType: "text/plain; charset=utf-8",
        text: truncated ? `${text}\n\n[文件超过 1MB，已截断]` : text,
    };
}

/** 列出工作区技能目录下的 SKILL.md，作为可发现资源暴露给 Codex（references 等其余文件按路径可读）。 */
export async function listSkillResources(workspacePath: string) {
    const skillsDir = path.join(path.resolve(workspacePath), ".agents", "skills");
    const entries = await readdir(skillsDir, { withFileTypes: true }).catch(() => []);
    const resources: Array<{ uri: string; name: string; title: string; description: string; mimeType: string }> = [];
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const file = path.join(skillsDir, entry.name, "SKILL.md");
        if (!(await stat(file).catch(() => null))) continue;
        resources.push({ uri: pathToFileURL(file).href, name: entry.name, title: entry.name, description: `技能 ${entry.name} 的说明文件（SKILL.md）`, mimeType: "text/markdown" });
    }
    return resources;
}

/** 将 MCP 工具调用转发到本地 Canvas Agent HTTP 服务。 */
async function postCanvasAgentTool(config: CanvasAgentConfig, name: ToolName, input: unknown) {
    const res = await fetch(`${config.url}/api/tools`, { method: "POST", headers: { "content-type": "application/json", "x-canvas-agent-token": config.token }, body: JSON.stringify({ name, input }) });
    const body = (await res.json()) as CanvasAgentToolResponse;
    if (!body.ok) throw new Error(body.error || "tool call failed");
    return body.result;
}
