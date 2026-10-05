/**
 * 画布是「被平台打开」的：Codex、DeepSeek Harness（DSH）、WorkBuddy、Trae、Cursor 等
 * 任意支持 MCP 的工具都可以连上本机 Agent。平台名由打开方在 URL fragment 里用
 * `source=` 声明（例如 `#agentUrl=...&agentToken=...&source=dsh`），画布据此显示真实平台名。
 *
 * 没有声明时不臆测平台——统一用 i18n 里的中性称呼，避免把 Codex 之外的接入方式当成异常。
 */

const PLATFORM_SOURCE_STORAGE_KEY = "canvas-agent-platform";

/** 已登记的平台标识 → 展示名。键为小写。 */
const KNOWN_PLATFORMS: Record<string, string> = {
    codex: "Codex",
    zcode: "ZCode",
    dsh: "DeepSeek Harness",
    "deepseek-harness": "DeepSeek Harness",
    deepseek: "DeepSeek",
    workbuddy: "WorkBuddy",
    trae: "Trae",
    cursor: "Cursor",
    claude: "Claude Desktop",
    "claude-desktop": "Claude Desktop",
    vscode: "VS Code",
    windsurf: "Windsurf",
    zed: "Zed",
};

/**
 * 把声明的 `source` 归一化成可展示的平台名；无法识别时回退到调用方给出的中性称呼。
 *
 * 未登记的来源允许原样展示（平台可以自报家门，不必等画布发版），但限制字符集与长度，
 * 避免把乱七八糟的 URL 片段塞进画布顶栏。
 */
export function resolveAgentPlatformLabel(source: string | null | undefined, fallback: string) {
    const key = (source || "").trim().toLowerCase();
    if (!key) return fallback;
    const known = KNOWN_PLATFORMS[key];
    if (known) return known;
    return key.length <= 24 && /^[a-z0-9][a-z0-9 ._-]*$/.test(key) ? source!.trim() : fallback;
}

/** 读取上次由平台声明的 source；fragment 被清理后（刷新页面）用它恢复展示名。 */
export function readStoredPlatformSource() {
    if (typeof window === "undefined") return "";
    return localStorage.getItem(PLATFORM_SOURCE_STORAGE_KEY) || "";
}

/** 记住平台声明的 source，供后续会话与刷新后继续显示。 */
export function storePlatformSource(source: string) {
    if (typeof window === "undefined") return;
    const value = source.trim();
    if (!value) localStorage.removeItem(PLATFORM_SOURCE_STORAGE_KEY);
    else localStorage.setItem(PLATFORM_SOURCE_STORAGE_KEY, value);
}
