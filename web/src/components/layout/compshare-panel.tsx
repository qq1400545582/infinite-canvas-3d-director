import { useCallback, useEffect, useState } from "react";
import { Copy, Cpu, Download, FileUp, FolderPlus, FolderTree, KeyRound, PlugZap, Plus, Power, RefreshCw, Square, Trash2, Upload, Wifi } from "lucide-react";
import { App, Badge, Button, Descriptions, Drawer, Empty, Input, Modal, Popconfirm, Select, Space, Spin, Table, Tag, Tooltip, Upload as AntUpload } from "antd";
import { useTranslation } from "react-i18next";

import { ensureAgentTarget } from "@/pages/expert-library/agent-bridge";
import type { CompShareInstance, CompShareOverview } from "./compshare-client";
import { FileManagerDrawer } from "@/components/layout/compshare-files-drawer";
import {
    buildInstanceChannel,
    connectInstanceToCanvas,
    describeProbe,
    isInstanceConnected,
    type ProbeOutcome,
} from "@/components/layout/compshare-canvas-bridge";
import { CreateInstanceWizard } from "@/components/layout/compshare-create-wizard";

/**
 * 优云智算 GPU 实例面板 —— 挂在「配置 → 本地代理」Tab 内。
 *
 * 为什么不放独立页面：本地代理 Tab 已经是「本机与外部服务接入」的位置，
 * GPU 实例正属于此类；新增顶层入口会改变全局 chrome（且用户明确要求放在这里）。
 *
 * 密钥处理：**私钥只写不读**。前端只能「填进去 / 探测是否已配置」，
 * 读取配置时 Agent 只回公钥脱敏串与 configured 标记。这样网页被 XSS 也不会泄露私钥。
 *
 * 写操作（创建 / 关机 / 释放）都带 `confirm: true`，并在此层做二次确认与计费提示：
 * 创建会按小时/天/月计费，释放**不可恢复、数据会丢**。
 */
export function CompsharePanel() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [agentMissing, setAgentMissing] = useState(false);
    const [config, setConfig] = useState<{ configured: boolean; publicKeyMasked: string; region: string; vllmApiKey: string } | null>(null);
    const [overview, setOverview] = useState<CompShareOverview | null>(null);
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);
    const [keys, setKeys] = useState({ publicKey: "", privateKey: "" });
    const [createOpen, setCreateOpen] = useState(false);

    const loadConfig = useCallback(async () => {
        const target = await ensureAgentTarget();
        if (!target?.token) {
            setAgentMissing(true);
            return;
        }
        setAgentMissing(false);
        try {
            const data = await callAgent<typeof config>(target, "/agent/compshare/config");
            setConfig(data);
        } catch (error) {
            message.error(describe(error, t));
        }
    }, [message, t]);

    const [failures, setFailures] = useState<{ part: string; error: string }[]>([]);
    const loadOverview = useCallback(async () => {
        const target = await ensureAgentTarget();
        if (!target?.token) {
            setAgentMissing(true);
            return;
        }
        setLoading(true);
        try {
            const data = await callAgent<CompShareOverview>(target, "/agent/compshare/overview");
            setOverview(data);
            // 部分接口失败时把原因挂到全局提示上——否则用户只看到「下拉是空的」却不知为何
            setFailures(data?.failures || []);
            if (data?.failures?.length) {
                message.warning(t("compshare.partialFailure", { parts: data.failures.map((item) => `${item.part}（${item.error}）`).join("；") }));
            }
        } catch (error) {
            message.error(describe(error, t));
        } finally {
            setLoading(false);
        }
    }, [message, t]);

    useEffect(() => {
        void loadConfig();
    }, [loadConfig]);
    // 已配置密钥后自动拉一次概览（未配置时保持安静，避免一进来就报错）
    useEffect(() => {
        if (config?.configured) void loadOverview();
    }, [config?.configured, loadOverview]);

    const saveKeys = async () => {
        const target = await ensureAgentTarget();
        if (!target?.token) return;
        setBusy("keys");
        try {
            await callAgent(target, "/agent/compshare/config", {
                method: "POST",
                body: { publicKey: keys.publicKey, privateKey: keys.privateKey },
            });
            setKeys({ publicKey: "", privateKey: "" });
            message.success(t("compshare.keysSaved"));
            await loadConfig();
        } catch (error) {
            message.error(describe(error, t));
        } finally {
            setBusy(null);
        }
    };

    const runAction = async (instanceId: string, action: "start" | "stop" | "release") => {
        const target = await ensureAgentTarget();
        if (!target?.token) return;
        setBusy(`${instanceId}:${action}`);
        try {
            await callAgent(target, `/agent/compshare/instances/${instanceId}/${action}`, { method: "POST", body: { confirm: true } });
            message.success(t(`compshare.action.${action}Done`));
            await loadOverview();
        } catch (error) {
            message.error(describe(error, t));
        } finally {
            setBusy(null);
        }
    };

    if (agentMissing) {
        return (
            <div className="rounded-lg border border-stone-200 p-4 text-sm text-stone-500 dark:border-stone-800 dark:text-stone-400">
                {t("compshare.agentMissing")}
            </div>
        );
    }

    return (
        <div className="flex flex-col gap-4">
            {/* ——— 密钥配置 ——— */}
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-stone-800 dark:text-stone-200">
                    <Cpu className="size-4" />
                    {t("compshare.title")}
                    {config?.configured ? <Badge status="success" text={t("compshare.configured")} /> : null}
                </div>
                <p className="mb-3 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("compshare.intro")}</p>
                {config?.configured ? (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                        <span>
                            {t("compshare.publicKey")}：<code className="rounded bg-stone-100 px-1 py-0.5 dark:bg-stone-800">{config.publicKeyMasked}</code>
                        </span>
                        <span>{t("compshare.region")}：<code className="rounded bg-stone-100 px-1 py-0.5 dark:bg-stone-800">{config.region || "cn-wlcb"}</code></span>
                        <Button size="small" type="link" onClick={() => setKeys({ publicKey: "", privateKey: "" })}>
                            {t("compshare.replaceKeys")}
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-2">
                        <Input.Password value={keys.privateKey} onChange={(event) => setKeys({ ...keys, privateKey: event.target.value })} placeholder={t("compshare.privateKeyPlaceholder")} />
                        <Input value={keys.publicKey} onChange={(event) => setKeys({ ...keys, publicKey: event.target.value })} placeholder={t("compshare.publicKeyPlaceholder")} />
                        <div>
                            <Button type="primary" size="small" icon={<KeyRound className="size-4" />} loading={busy === "keys"} disabled={!keys.publicKey || !keys.privateKey} onClick={() => void saveKeys()}>
                                {t("compshare.saveKeys")}
                            </Button>
                        </div>
                        <p className="text-[11px] leading-4 text-stone-400">{t("compshare.keysHint")}</p>
                    </div>
                )}
                {/* vLLM API Key 不在此配置：算力租赁平台并不提供该密钥的生成入口，
                    它是镜像内 vLLM 服务预置的固定值，只在实例「接入信息」里展示。 */}
            </section>

            {/* ——— 实例列表 + 运维 ——— */}
            <section className="rounded-lg border border-stone-200 p-4 dark:border-stone-800">
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-stone-800 dark:text-stone-200">
                        {t("compshare.instances")}（{overview?.instances?.length || 0}）
                    </div>
                    <Space size="small">
                        <Button size="small" icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} disabled={!config?.configured} onClick={() => void loadOverview()}>
                            {t("compshare.refresh")}
                        </Button>
                        <Button size="small" type="primary" icon={<Plus className="size-4" />} disabled={!config?.configured} onClick={() => setCreateOpen(true)}>
                            {t("compshare.create")}
                        </Button>
                    </Space>
                </div>

                {failures.length ? (
                    <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">
                        <div className="font-medium">{t("compshare.partialFailureTitle")}</div>
                        <ul className="list-disc pl-4">
                            {failures.map((item) => (
                                <li key={item.part}>
                                    {item.part}：{item.error}
                                </li>
                            ))}
                        </ul>
                    </div>
                ) : null}

                {!config?.configured ? (
                    <p className="text-xs text-stone-400">{t("compshare.configureFirst")}</p>
                ) : loading && !overview ? (
                    <div className="flex justify-center py-6">
                        <Spin size="small" />
                    </div>
                ) : !overview?.instances?.length ? (
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("compshare.noInstances")} />
                ) : (
                    <div className="flex flex-col gap-3">
                        {overview.instances.map((instance) => (
                            <InstanceCard key={instance.id} instance={instance} busy={busy} onAction={(action) => void runAction(instance.id, action)} />
                        ))}
                    </div>
                )}
            </section>

            <CreateInstanceWizard
                open={createOpen}
                overview={overview}
                onClose={() => setCreateOpen(false)}
                onCreated={async () => {
                    setCreateOpen(false);
                    await loadOverview();
                }}
            />
        </div>
    );
}

function InstanceCard({ instance, busy, onAction }: { instance: CompShareInstance; busy: string | null; onAction: (action: "start" | "stop" | "release") => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [endpoints, setEndpoints] = useState<{ apiBase: string; gpuStats: string; comfyui: string; apiKey: string } | null>(null);
    const [filesOpen, setFilesOpen] = useState(false);
    // 实例可调用性探测：探 8000 端口的 OpenAI 兼容 API，决定能喂给画布哪类节点
    const [probing, setProbing] = useState(false);
    const [probe, setProbe] = useState<ProbeOutcome | null>(null);
    const [connected, setConnected] = useState(false);

    /**
     * 探测并接入画布。
     *
     * 流程是「先探测再接入」而不是直接写渠道：探测不通过时用户只会看到
     * 「实例还没起服务 / 地址不对 / 没模型」这类可行动原因，而不会在画布里
     * 多出一个选了就报错的空渠道。
     */
    const handleProbe = async () => {
        const target = await ensureAgentTarget();
        if (!target?.token) {
            message.error(t("compshare.agentMissing"));
            return;
        }
        setProbing(true);
        try {
            const outcome = await callAgent<ProbeOutcome>(target, `/agent/compshare/instances/${encodeURIComponent(instance.id)}/probe`, {
                method: "POST",
                body: { apiKey: endpoints?.apiKey || "" },
            });
            setProbe(outcome);
            if (!outcome.ok) {
                message.error(outcome.reason);
                return;
            }
            const result = connectInstanceToCanvas(
                buildInstanceChannel({
                    instanceId: instance.id,
                    instanceName: instance.name,
                    apiBase: outcome.apiBase,
                    // 优先用实例接入信息里的 vLLM Key（用户在平台改过的话以它为准）
                    apiKey: endpoints?.apiKey || "",
                    models: outcome.models,
                }),
            );
            if (!result.ok) {
                message.error(result.reason);
                return;
            }
            setConnected(true);
            message.success(
                result.replaced
                    ? t("compshare.canvas.updated", { name: describeProbe(outcome) })
                    : t("compshare.canvas.connected", { name: describeProbe(outcome) }),
            );
        } catch (error) {
            message.error(describe(error, t));
        } finally {
            setProbing(false);
        }
    };

    // 首次渲染时读一次「是否已接入」，让按钮态准确
    useEffect(() => {
        setConnected(isInstanceConnected(instance.id));
    }, [instance.id]);

    const copy = async (label: string, value: string) => {
        try {
            await navigator.clipboard.writeText(value);
            message.success(t("compshare.copied", { name: label }));
        } catch {
            message.error(t("compshare.copyFailed"));
        }
    };

    const loadEndpoints = async () => {
        const target = await ensureAgentTarget();
        if (!target?.token) return;
        try {
            setEndpoints(await callAgent(target, `/agent/compshare/endpoints?instanceId=${encodeURIComponent(instance.id)}`));
        } catch (error) {
            message.error(describe(error, t));
        }
    };

    return (
        <div className="rounded-md border border-stone-200 p-3 dark:border-stone-800">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-stone-900 dark:text-stone-100">{instance.name || instance.id}</span>
                    <Tag color={statusColor(instance.status)}>{instance.status || t("compshare.unknownStatus")}</Tag>
                    {instance.gpuType ? (
                        <Tag>
                            {instance.gpuType} × {instance.gpuCount ?? "?"}
                        </Tag>
                    ) : null}
                </div>
                <Space size="small">
                    <Tooltip title={t("compshare.endpoints")}>
                        <Button size="small" icon={<Wifi className="size-4" />} onClick={() => void loadEndpoints()}>
                            {t("compshare.endpoints")}
                        </Button>
                    </Tooltip>
                    {instance.status === "Running" || instance.status === "运行中" ? (
                        <Button size="small" icon={<Square className="size-4" />} loading={busy === `${instance.id}:stop`} onClick={() => onAction("stop")}>
                            {t("compshare.action.stop")}
                        </Button>
                    ) : (
                        <Button size="small" icon={<Power className="size-4" />} loading={busy === `${instance.id}:start`} onClick={() => onAction("start")}>
                            {t("compshare.action.start")}
                        </Button>
                    )}
                    <Tooltip title={t("compshare.canvas.probeHint")}>
                        <Button size="small" icon={<PlugZap className="size-4" />} loading={probing} onClick={() => void handleProbe()}>
                            {t("compshare.canvas.connect")}
                        </Button>
                    </Tooltip>
                    <Tooltip title={t("compshare.files.open")}>
                        <Button size="small" icon={<FolderTree className="size-4" />} onClick={() => setFilesOpen(true)}>
                            {t("compshare.files.open")}
                        </Button>
                    </Tooltip>
                    <Popconfirm
                        title={t("compshare.action.release")}
                        description={t("compshare.action.releaseWarning")}
                        okText={t("compshare.action.release")}
                        cancelText={t("common.cancel")}
                        okButtonProps={{ danger: true }}
                        onConfirm={() => onAction("release")}
                    >
                        <Button size="small" danger icon={<Trash2 className="size-4" />} loading={busy === `${instance.id}:release`}>
                            {t("compshare.action.release")}
                        </Button>
                    </Popconfirm>
                </Space>
            </div>

            {instance.id ? <div className="mt-1 text-[11px] text-stone-400">{instance.id}</div> : null}

            {/* 探测结果：把「这个实例能不能被画布调用、调用哪几类节点」直接说清楚 */}
            {probe ? (
                <div
                    className={`mt-2 rounded-md border px-3 py-2 text-[11px] leading-5 ${
                        probe.ok
                            ? "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300"
                            : "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300"
                    }`}
                >
                    <div className="font-medium">
                        {probe.ok ? t("compshare.canvas.probeOkTitle") : t("compshare.canvas.probeFailTitle")}
                    </div>
                    <div>{describeProbe(probe)}</div>
                    {probe.ok && connected ? (
                        <div className="mt-1 text-[11px] opacity-80">
                            {t("compshare.canvas.whereToUse")}
                        </div>
                    ) : null}
                </div>
            ) : null}

            {endpoints ? (
                <Descriptions size="small" column={1} className="mt-2" bordered>
                    <Descriptions.Item label={t("compshare.endpoint.api")}>
                        <CopyRow value={endpoints.apiBase} onCopy={() => void copy(t("compshare.endpoint.api"), endpoints.apiBase)} />
                    </Descriptions.Item>
                    <Descriptions.Item label={t("compshare.endpoint.gpu")}>
                        <CopyRow value={endpoints.gpuStats} onCopy={() => void copy(t("compshare.endpoint.gpu"), endpoints.gpuStats)} />
                    </Descriptions.Item>
                    <Descriptions.Item label={t("compshare.endpoint.comfy")}>
                        <CopyRow value={endpoints.comfyui} onCopy={() => void copy(t("compshare.endpoint.comfy"), endpoints.comfyui)} />
                    </Descriptions.Item>
                    <Descriptions.Item label={t("compshare.endpoint.vllmKey")}>
                        <CopyRow value={endpoints.apiKey} onCopy={() => void copy(t("compshare.endpoint.vllmKey"), endpoints.apiKey)} />
                    </Descriptions.Item>
                </Descriptions>
            ) : null}

            <FileManagerDrawer open={filesOpen} instance={instance} onClose={() => setFilesOpen(false)} />
        </div>
    );
}

function CopyRow({ value, onCopy }: { value: string; onCopy: () => void }) {
    return (
        <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate text-[11px]">{value}</code>
            <Button size="small" type="text" icon={<Copy className="size-3.5" />} onClick={onCopy} />
        </div>
    );
}


function statusColor(status: string) {
    const s = String(status || "").toLowerCase();
    if (s.includes("running") || s.includes("运行")) return "green";
    if (s.includes("stopped") || s.includes("stop") || s.includes("停止")) return "default";
    if (s.includes("error") || s.includes("fail")) return "red";
    return "blue";
}

/** 统一调用 Agent：带 token，超时保护，并把上游 code/error 抛成可读错误。 */
async function callAgent<T>(target: { endpoint: string; token: string }, endpointPath: string, options: { method?: "GET" | "POST"; body?: unknown } = {}): Promise<T> {
    const method = options.method || "GET";
    let response: Response;
    try {
        response = await fetch(`${target.endpoint}${endpointPath}${endpointPath.includes("?") ? "&" : "?"}token=${encodeURIComponent(target.token)}`, {
            method,
            headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}) },
            body: options.body ? JSON.stringify(options.body) : undefined,
            signal: AbortSignal.timeout(60_000),
        });
    } catch {
        // fetch 抛 TypeError 只说明「没连上」，最常见的是本机 Canvas Agent 未运行 / 版本过旧。
        // 直接抛裸的 "Failed to fetch" 用户无从下手，所以这里换成人能行动的提示。
        throw new Error("连不上本机 Canvas Agent：请确认智能体面板已连接。若已连接仍报此错，多半是 Agent 版本过旧——本功能需要重新构建并同步 Agent 后重启。");
    }
    const payload = (await response.json()) as { ok?: boolean; data?: T; code?: string; error?: string };
    if (!payload.ok) {
        const err = new Error(payload.error || "请求失败") as Error & { code?: string };
        err.code = payload.code;
        throw err;
    }
    return payload.data as T;
}

function describe(error: unknown, t: (key: string, option?: Record<string, unknown>) => string) {
    if (error instanceof Error) return error.message || t("compshare.failed");
    return String(error);
}
