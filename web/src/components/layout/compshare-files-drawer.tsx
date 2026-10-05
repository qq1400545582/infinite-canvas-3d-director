import { useCallback, useEffect, useState } from "react";
import { ArrowUp, Download, File, FileUp, Folder, FolderPlus, Loader2, RefreshCw, Trash2 } from "lucide-react";
import { App, Button, Drawer, Empty, Input, Popconfirm, Space, Spin, Table, Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ensureAgentTarget } from "@/pages/expert-library/agent-bridge";
import type { CompShareInstance } from "./compshare-client";

/**
 * 实例文件管理抽屉（列目录 / 上传 / 下载 / 新建目录 / 删除）。
 *
 * 浏览器不能直连 SSH，所以全部经本机 Canvas Agent 中转（Agent 侧用 ssh2 建 SFTP）。
 * **可访问范围被限制在实例的 `/root` 之下**，Agent 侧对每个路径做规范化校验，越界直接拒绝。
 *
 * 密码：平台返回的是 Base64 密文，能否本地解码不确定，因此这里允许用户手填一次
 * （存在组件 state，不落盘、不进 Agent 配置）。解码成功时用户完全不用填。
 */
export function FileManagerDrawer({ open, instance, onClose }: { open: boolean; instance: CompShareInstance; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [password, setPassword] = useState("");
    const [dir, setDir] = useState(".");
    const [entries, setEntries] = useState<FileEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [pending, setPending] = useState<string | null>(null);

    const list = useCallback(
        async (target: string) => {
            const agent = await ensureAgentTarget();
            if (!agent?.token) return;
            setLoading(true);
            try {
                const data = await agentPost<{ dir: string; root: string; entries: FileEntry[] }>(agent, "/agent/compshare/sftp/list", {
                    instanceId: instance.id,
                    path: target,
                    password: password || undefined,
                });
                setDir(data.dir);
                setEntries(data.entries || []);
            } catch (error) {
                message.error(describe(error));
            } finally {
                setLoading(false);
            }
        },
        [instance.id, message, password],
    );

    // 打开时自动列一次（若密码不对会提示，届时可手填再试）
    useEffect(() => {
        if (open) void list(".");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    const run = async (endpoint: string, body: Record<string, unknown>, okText?: string) => {
        const agent = await ensureAgentTarget();
        if (!agent?.token) return;
        setPending(endpoint);
        try {
            await agentPost(agent, endpoint, { instanceId: instance.id, password: password || undefined, ...body });
            if (okText) message.success(okText);
            await list(String(body.path ?? ".").startsWith("/") ? String(body.path) : dir);
        } catch (error) {
            message.error(describe(error));
        } finally {
            setPending(null);
        }
    };

    const upload = async (file: File) => {
        const agent = await ensureAgentTarget();
        if (!agent?.token) return;
        setPending("upload");
        try {
            const buffer = await file.arrayBuffer();
            let binary = "";
            const bytes = new Uint8Array(buffer);
            // 分片拼接，避免大文件触发 String.fromCharCode 的参数上限
            for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
            await agentPost(agent, "/agent/compshare/sftp/upload", {
                instanceId: instance.id,
                path: joinPath(dir === "." ? "" : dir, file.name),
                payload: btoa(binary),
                password: password || undefined,
            });
            message.success(t("compshare.files.uploaded", { name: file.name }));
            await list(dir);
        } catch (error) {
            message.error(describe(error));
        } finally {
            setPending(null);
        }
    };

    const download = async (entry: FileEntry) => {
        const agent = await ensureAgentTarget();
        if (!agent?.token) return;
        setPending(entry.path);
        try {
            const data = await agentPost<{ payload: string }>(agent, "/agent/compshare/sftp/download", {
                instanceId: instance.id,
                path: entry.path,
                password: password || undefined,
            });
            const binary = atob(data.payload || "");
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
            const link = document.createElement("a");
            link.href = url;
            link.download = entry.name;
            link.click();
            // 立刻回收会让部分浏览器来不及触发下载，延迟释放
            setTimeout(() => URL.revokeObjectURL(url), 10_000);
        } catch (error) {
            message.error(describe(error));
        } finally {
            setPending(null);
        }
    };

    return (
        <Drawer
            open={open}
            onClose={onClose}
            width={760}
            title={
                <div className="flex flex-col">
                    <span>{t("compshare.files.title")}</span>
                    <span className="text-[11px] text-stone-500 dark:text-stone-400">
                        {instance.name || instance.id} · {t("compshare.files.rootHint")}
                    </span>
                </div>
            }
            extra={
                <Space size="small">
                    <Tooltip title={t("compshare.files.refresh")}>
                        <Button size="small" icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => void list(dir)} />
                    </Tooltip>
                    <Popconfirm
                        title={t("compshare.files.mkdirPrompt")}
                        onConfirm={() => void run("/agent/compshare/sftp/mkdir", { path: joinPath(dir === "." ? "" : dir, String(Math.random()).slice(2, 8)) }, t("compshare.files.mkdirDone"))}
                    >
                        <Button size="small" icon={<FolderPlus className="size-4" />}>
                            {t("compshare.files.mkdir")}
                        </Button>
                    </Popconfirm>
                    <label className="inline-block">
                        <input
                            type="file"
                            className="hidden"
                            onChange={(event) => {
                                const file = event.target.files?.[0];
                                if (file) void upload(file);
                                event.target.value = "";
                            }}
                        />
                        <span className="inline-flex cursor-pointer items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-xs hover:bg-stone-50 dark:border-stone-700 dark:hover:bg-stone-800">
                            <FileUp className="size-4" />
                            {t("compshare.files.upload")}
                        </span>
                    </label>
                </Space>
            }
        >
            <div className="mb-3 flex items-center gap-2">
                <Button size="small" icon={<ArrowUp className="size-4" />} disabled={dir === "." || dir === "/root"} onClick={() => void list(parentOf(dir))}>
                    {t("compshare.files.parent")}
                </Button>
                <Input size="small" value={dir} readOnly className="font-mono text-[11px]" />
                <Input.Password size="small" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("compshare.files.passwordPlaceholder")} className="max-w-[200px]" />
                <Button size="small" onClick={() => void list(dir)}>
                    {t("compshare.files.connect")}
                </Button>
            </div>

            {loading && !entries.length ? (
                <div className="flex justify-center py-10">
                    <Spin size="small" />
                </div>
            ) : !entries.length ? (
                <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("compshare.files.empty")} />
            ) : (
                <Table<FileEntry>
                    rowKey="path"
                    size="small"
                    pagination={false}
                    dataSource={entries}
                    locale={{ emptyText: t("compshare.files.empty") }}
                    columns={[
                        {
                            title: t("compshare.files.name"),
                            dataIndex: "name",
                            render: (value: string, record) => (
                                <button
                                    type="button"
                                    className="flex max-w-full items-center gap-1.5 truncate text-left text-sm hover:text-emerald-600"
                                    onClick={() => record.isDirectory && void list(record.path)}
                                >
                                    {record.isDirectory ? <Folder className="size-4 shrink-0 text-amber-500" /> : <File className="size-4 shrink-0 text-stone-400" />}
                                    <span className="truncate">{value}</span>
                                </button>
                            ),
                        },
                        {
                            title: t("compshare.files.size"),
                            dataIndex: "size",
                            width: 96,
                            align: "right",
                            render: (value: number, record) => (record.isDirectory ? "" : formatSize(value)),
                        },
                        {
                            title: t("compshare.files.modified"),
                            dataIndex: "modifiedAt",
                            width: 160,
                        },
                        {
                            title: "",
                            width: 90,
                            align: "right",
                            render: (_, record) => (
                                <Space size="small">
                                    {!record.isDirectory ? (
                                        <Button size="small" type="text" icon={<Download className="size-4" />} loading={pending === record.path} onClick={() => void download(record)} />
                                    ) : null}
                                    <Popconfirm
                                        title={t("compshare.files.removeConfirm", { name: record.name })}
                                        okText={t("compshare.action.release")}
                                        cancelText={t("common.cancel")}
                                        okButtonProps={{ danger: true }}
                                        onConfirm={() => void run("/agent/compshare/sftp/remove", { path: record.path }, t("compshare.files.removed", { name: record.name }))}
                                    >
                                        <Button size="small" type="text" danger icon={<Trash2 className="size-4" />} />
                                    </Popconfirm>
                                </Space>
                            ),
                        },
                    ]}
                />
            )}
        </Drawer>
    );
}

type FileEntry = { name: string; path: string; isDirectory: boolean; size: number; modifiedAt: string; mode: string };

function joinPath(dir: string, name: string) {
    if (!dir || dir === ".") return name;
    return dir.endsWith("/") ? `${dir}${name}` : `${dir}/${name}`;
}

function parentOf(dir: string) {
    if (!dir || dir === "." || dir === "/root") return ".";
    const cut = dir.replace(/\/+$/, "").lastIndexOf("/");
    return cut <= 0 ? "." : dir.slice(0, cut);
}

function formatSize(bytes: number) {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / 1024 ** exp).toFixed(exp === 0 ? 0 : 1)} ${units[exp]}`;
}

async function agentPost<T>(target: { endpoint: string; token: string }, endpointPath: string, body: Record<string, unknown>): Promise<T> {
    let response: Response;
    try {
        response = await fetch(`${target.endpoint}${endpointPath}?token=${encodeURIComponent(target.token)}`, {
            method: "POST",
            headers: { accept: "application/json", "content-type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120_000),
        });
    } catch {
        throw new Error("连不上本机 Canvas Agent：请确认智能体面板已连接。");
    }
    const payload = (await response.json()) as { ok?: boolean; data?: T; error?: string };
    if (!payload.ok) throw new Error(payload.error || "操作失败");
    return payload.data as T;
}

function describe(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}
