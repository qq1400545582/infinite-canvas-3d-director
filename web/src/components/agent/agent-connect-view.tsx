import { Fragment, useState } from "react";
import { App, Button, Input, Tooltip } from "antd";
import copyToClipboard from "copy-to-clipboard";
import { Copy, KeyRound, Link2, PlugZap } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes } from "@/lib/canvas-theme";
import { isLikelyLocalNetworkAccessBlocked, isLikelyChromium } from "@/lib/agent/lna-guidance";

const AGENT_PLUGIN_REMOVE_COMMAND = "codex plugin remove infinite-canvas";
const AGENT_MCP_REMOVE_COMMAND = "codex mcp remove infinite-canvas";

type McpClientStatus = { id: string; label: string; detected: boolean; configured: boolean; upToDate: boolean; configPath: string | null };
type McpSetupResult = { id: string; label: string; status: "written" | "already" | "skipped" | "failed"; reason?: string; error?: string };

export function AgentConnectView({
    theme,
    url,
    token,
    enabled,
    connected,
    activity,
    connectError,
    onUrlChange,
    onTokenChange,
    onToggleEnabled,
    onStartBackend,
    backendStarting,
}: {
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    url: string;
    token: string;
    enabled: boolean;
    connected: boolean;
    activity: string;
    connectError: string;
    onUrlChange: (value: string) => void;
    onTokenChange: (value: string) => void;
    onToggleEnabled: () => void;
    onStartBackend: () => void;
    backendStarting: boolean;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const steps = [
        { title: t("agent.connect.pluginTitle"), text: t("agent.connect.pluginText") },
        { title: t("agent.connect.directTitle"), text: t("agent.connect.directText"), action: "startBackend" as const },
    ];
    const AGENT_MCP_JSON = JSON.stringify({ mcpServers: { "infinite-canvas": { command: "npx", args: ["-y", "@basketikun/canvas-agent", "mcp"] } } }, null, 2);
    // 徽标只表达「连接」状态：此处若混入 activity（对话活动），对话失败会把「处理失败」显示成「网页连接失败」，产生误判。
    // 对话活动单独用 conversationState 一行展示。（与 local-agent-panel 头部的 connectionStatus 写法保持一致）
    const connectionState = connectError ? "agent.status.failed" : connected ? "agent.status.connected" : enabled ? "agent.status.connecting" : "agent.status.disconnected";
    const statusText = t(connectionState);
    const statusColor = connectError ? "#dc2626" : connected ? "#16a34a" : enabled ? "#d97706" : theme.node.muted;
    const conversationState = connected && activity && activity !== t("agent.status.connected") ? activity : "";
    const copyCommand = (command: string) => {
        copyToClipboard(command);
        message.success(t("agent.connect.commandCopied"));
    };

    // —— 一键接入：让本机 Agent 把 MCP 配置写进各工具（Codex TOML / VS Code servers 键 / Windows cmd /c npx 都由后端处理）——
    const [mcpClients, setMcpClients] = useState<McpClientStatus[] | null>(null);
    const [mcpBusyAction, setMcpBusyAction] = useState<"" | "status" | "install">("");
    const requestMcpSetup = async (action: "status" | "install", clients?: string[]) => {
        if (!token.trim()) {
            message.warning(t("agent.connect.mcpNeedAgent"));
            return null;
        }
        const res = await fetch(`${url.trim().replace(/\/$/, "")}/api/tools`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-canvas-agent-token": token.trim() },
            body: JSON.stringify({ name: "client_mcp_setup", input: { action, ...(clients?.length ? { clients } : {}) } }),
        });
        const body = (await res.json()) as { ok?: boolean; error?: string; result?: { clients?: McpClientStatus[]; results?: McpSetupResult[] } };
        if (!body.ok) throw new Error(String(body.error || res.status));
        return body.result ?? {};
    };
    const runMcpStatus = async () => {
        setMcpBusyAction("status");
        try {
            const result = await requestMcpSetup("status");
            if (result?.clients) setMcpClients(result.clients);
        } catch (error) {
            message.error(t("agent.connect.mcpRequestFailed", { error: error instanceof Error ? error.message : String(error) }));
        } finally {
            setMcpBusyAction("");
        }
    };
    const runMcpInstall = async (clients?: string[]) => {
        setMcpBusyAction("install");
        try {
            const result = await requestMcpSetup("install", clients);
            const results = result?.results || [];
            const failed = results.filter((item) => item.status === "failed");
            if (failed.length) message.error(t("agent.connect.mcpWriteFailed", { name: failed[0].label, error: failed[0].error || "" }));
            else {
                const written = results.filter((item) => item.status === "written").length;
                const already = results.filter((item) => item.status === "already").length;
                const skipped = results.filter((item) => item.status === "skipped").length;
                message.success(t("agent.connect.mcpWriteDone", { written, already, skipped }));
            }
            const refreshed = await requestMcpSetup("status");
            if (refreshed?.clients) setMcpClients(refreshed.clients);
        } catch (error) {
            message.error(t("agent.connect.mcpRequestFailed", { error: error instanceof Error ? error.message : String(error) }));
        } finally {
            setMcpBusyAction("");
        }
    };
    const mcpState = (client: McpClientStatus) =>
        client.upToDate ? t("agent.connect.mcpStateOk") : client.configured ? t("agent.connect.mcpStateStale") : client.detected ? t("agent.connect.mcpStatePending") : t("agent.connect.mcpStateMissing");
    const mcpStateColor = (client: McpClientStatus) => (client.upToDate ? "#16a34a" : client.configured ? "#d97706" : client.detected ? theme.node.muted : theme.node.faint);
    const mcpPendingCount = mcpClients?.filter((client) => client.detected && !client.upToDate).length ?? 0;
    const codexPluginReminder = (
        <div className="rounded-lg border px-3 py-2.5 text-xs leading-5" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
            <div className="font-medium" style={{ color: theme.node.text }}>
                {t("agent.connect.pluginReminder")}
            </div>
            <div className="mt-1">{t("agent.connect.pluginReminderText")}</div>
            <div className="mt-2 grid gap-1.5">
                {[
                    [t("agent.connect.removePlugin"), AGENT_PLUGIN_REMOVE_COMMAND],
                    [t("agent.connect.removeMcp"), AGENT_MCP_REMOVE_COMMAND],
                ].map(([label, command]) => (
                    <div key={command} className="flex items-center gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                        <span className="shrink-0 text-[11px]" style={{ color: theme.node.muted }}>
                            {label}
                        </span>
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] leading-5">{command}</code>
                        <Tooltip title={t("agent.connect.copyCommand")}>
                            <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={() => copyCommand(command)} />
                        </Tooltip>
                    </div>
                ))}
            </div>
        </div>
    );
    return (
        <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto p-4">
            <div className="space-y-4">
                <div>
                    <div className="text-base font-semibold leading-6">{t("agent.connect.title")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        {t("agent.connect.description")}
                    </div>
                </div>
                <div className="space-y-2">
                    {steps.map((step, index) => {
                        const action = "action" in step ? step.action : undefined;
                        return (
                            <Fragment key={step.title}>
                                <div className="rounded-lg px-3 py-2.5">
                                    <div className="text-sm font-medium leading-5">{step.title}</div>
                                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                        {step.text}
                                    </div>
                                    {action === "startBackend" ? (
                                        <div className="mt-3">
                                            <Button className="!h-9 !px-4" type="primary" loading={backendStarting} icon={<PlugZap className="size-4" />} onClick={onStartBackend}>
                                                {backendStarting ? t("agent.connect.startingBackend") : t("agent.connect.startBackend")}
                                            </Button>
                                            <div className="mt-1.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                                {t("agent.connect.startBackendHint")}
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                                {index === 0 ? codexPluginReminder : null}
                            </Fragment>
                        );
                    })}
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="text-sm font-medium leading-5">{t("agent.connect.interopTitle")}</div>
                    <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                        {t("agent.connect.interopText")}
                    </div>
                    <div className="mt-2.5 rounded-md border px-2.5 py-2" style={{ borderColor: theme.node.stroke }}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <div className="text-xs font-medium" style={{ color: theme.node.text }}>
                                    {t("agent.connect.mcpAutoTitle")}
                                </div>
                                <div className="mt-0.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                                    {t("agent.connect.mcpAutoDesc")}
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-2">
                                <Button size="small" loading={mcpBusyAction === "status"} onClick={() => void runMcpStatus()}>
                                    {t("agent.connect.mcpDetect")}
                                </Button>
                                <Button size="small" type="primary" loading={mcpBusyAction === "install"} disabled={!mcpClients || mcpPendingCount === 0} onClick={() => void runMcpInstall()}>
                                    {t("agent.connect.mcpWriteAll")}
                                </Button>
                            </div>
                        </div>
                        {mcpClients ? (
                            <div className="mt-2 grid gap-1">
                                {mcpClients.map((client) => (
                                    <div key={client.id} className="flex items-center gap-2 rounded border px-2 py-1" style={{ borderColor: theme.node.stroke }}>
                                        <span className="shrink-0 text-xs font-medium" style={{ color: theme.node.text }}>
                                            {client.label}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate text-[11px]" style={{ color: mcpStateColor(client) }}>
                                            {mcpState(client)}
                                        </span>
                                        {client.detected && !client.upToDate ? (
                                            <Button size="small" type="text" className="!h-5 !px-1.5 !text-[11px]" disabled={Boolean(mcpBusyAction)} onClick={() => void runMcpInstall([client.id])}>
                                                {t("agent.connect.mcpWriteOne")}
                                            </Button>
                                        ) : null}
                                    </div>
                                ))}
                            </div>
                        ) : null}
                        <div className="mt-1.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                            {t("agent.connect.mcpBackupNote")}
                        </div>
                    </div>
                    <div className="mt-2 text-[11px] font-medium" style={{ color: theme.node.muted }}>
                        {t("agent.connect.interopConfig")}
                    </div>
                    <div className="mt-1.5 flex items-start gap-2 rounded-md border bg-transparent px-2 py-1.5" style={{ borderColor: theme.node.stroke, color: theme.node.text }}>
                        <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre text-[11px] leading-5">{AGENT_MCP_JSON}</code>
                        <Tooltip title={t("agent.connect.interopCopy")}>
                            <Button size="small" type="text" className="!h-6 !w-6 !min-w-6" icon={<Copy className="size-3.5" />} onClick={() => copyCommand(AGENT_MCP_JSON)} />
                        </Tooltip>
                    </div>
                    <div className="mt-1.5 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                        {t("agent.connect.interopNote")}
                    </div>
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] leading-4" style={{ color: theme.node.muted }}>
                        <a href="/send" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 no-underline hover:underline" style={{ color: "#2563eb" }}>
                            {t("agent.connect.sendStation")}
                        </a>
                        <a href="/send#bookmarklet" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 no-underline hover:underline" style={{ color: "#2563eb" }}>
                            {t("agent.connect.bookmarkletEntry")}
                        </a>
                    </div>
                </div>
                <div className="rounded-lg border p-3" style={{ borderColor: theme.node.stroke }}>
                    <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                            <div className="flex min-w-0 items-center gap-2">
                                <span className="shrink-0 text-sm font-medium leading-5">{t("agent.connect.webConnection")}</span>
                                <span
                                    className="inline-flex min-w-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-4"
                                    style={{ borderColor: connected || enabled || connectError ? statusColor : theme.node.stroke, color: statusColor }}
                                >
                                    <span className="size-1.5 shrink-0 rounded-full" style={{ background: statusColor }} />
                                    <span className="truncate">{statusText}</span>
                                </span>
                            </div>
                            <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                {t("agent.connect.autoDiscover")}
                            </div>
                            {conversationState ? (
                                <div className="mt-1 text-xs leading-5" style={{ color: theme.node.muted }}>
                                    {t("agent.connect.conversationState", { state: conversationState })}
                                </div>
                            ) : null}
                        </div>
                        <Button className="!h-8 !px-3" type={enabled ? "default" : "primary"} icon={<PlugZap className="size-4" />} onClick={onToggleEnabled}>
                            {t(enabled ? "agent.connect.disconnect" : "agent.connect.connect")}
                        </Button>
                    </div>
                    <div className="mt-3 grid gap-2.5">
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <Link2 className="size-3.5" />
                                {t("agent.connect.localAddress")}
                                <span className="font-normal opacity-70">Local URL</span>
                            </span>
                            <Input size="large" prefix={<Link2 className="mr-1 size-4" style={{ color: theme.node.faint }} />} value={url} onChange={(event) => onUrlChange(event.target.value)} placeholder={t("agent.connect.urlPlaceholder")} />
                        </label>
                        <label className="grid gap-1.5">
                            <span className="flex items-center gap-1.5 text-xs font-medium" style={{ color: theme.node.muted }}>
                                <KeyRound className="size-3.5" />
                                {t("agent.connect.token")}
                                <span className="font-normal opacity-70">Connect token</span>
                            </span>
                            <Input.Password
                                size="large"
                                prefix={<KeyRound className="mr-1 size-4" style={{ color: theme.node.faint }} />}
                                value={token}
                                onChange={(event) => onTokenChange(event.target.value)}
                                placeholder={t("agent.connect.tokenPlaceholder")}
                            />
                        </label>
                        {connectError ? (
                            <div className="rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: "rgba(220,38,38,.35)", color: "#dc2626" }}>
                                {connectError}
                            </div>
                        ) : null}
                        {connectError && isLikelyLocalNetworkAccessBlocked(url) ? (
                            <div className="rounded-md border px-2.5 py-2 text-xs leading-5" style={{ borderColor: "rgba(37,99,235,.35)", color: "#1d4ed8", background: "rgba(37,99,235,.06)" }}>
                                <div className="font-medium">{t("agent.connect.lnaTitle")}</div>
                                <div className="mt-1">{t("agent.connect.lnaText")}</div>
                                <div className="mt-1">
                                    {isLikelyChromium() ? t("agent.connect.lnaChromium") : t("agent.connect.lnaFirefox")}
                                </div>
                            </div>
                        ) : null}
                    </div>
                </div>
            </div>
        </div>
    );
}
