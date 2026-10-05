export function hasAgentUrlBootstrap(hash: string) {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    return params.has("agentUrl") || params.has("agentToken");
}

export function readAgentUrlBootstrap(hash: string) {
    const params = new URLSearchParams(hash.replace(/^#/, ""));
    if (!params.has("agentUrl") && !params.has("agentToken")) return null;
    const url = params.get("agentUrl")?.trim() || "";
    const token = params.get("agentToken")?.trim() || "";
    params.delete("agentUrl");
    params.delete("agentToken");
    const remaining = params.toString();
    return { url, token, remainingHash: remaining ? `#${remaining}` : "" };
}

/** 读取打开方声明的平台标识（`source=codex|dsh|workbuddy|trae…`），未声明时返回空串。 */
export function readAgentPlatformSource(hash: string) {
    return new URLSearchParams(hash.replace(/^#/, "")).get("source")?.trim() || "";
}
