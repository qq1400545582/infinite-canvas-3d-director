import { useState } from "react";
import { Cloud, Plus, RefreshCw, Trash2 } from "lucide-react";
import { App, Button, Input, Modal, Popconfirm, Table } from "antd";
import { useTranslation } from "react-i18next";

import { ChannelError, describeChannelError, normalizeChannelUrl, pullChannel } from "../channel-source";
import { isCustomChannel, useUserLibrary, channelIdFromUrl, type UpdateChannel } from "../state/user-library";

/**
 * 更新渠道管理：查看渠道、手动新增自定义 JSON 目录、逐个更新、删除自定义渠道。
 *
 * 内置的 WorkBuddy 渠道由既有「立即拉取」逻辑处理（走 Agent 同步端点、技能真落盘），
 * 这里只显示与刷新它的状态，不允许删除 —— 保证「更新」永远至少有一个可用渠道。
 */
export function ChannelManagerModal({ open, onClose, onRefreshWorkbuddy }: { open: boolean; onClose: () => void; onRefreshWorkbuddy: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const channels = useUserLibrary((state) => state.channels);
    const [name, setName] = useState("");
    const [url, setUrl] = useState("");
    const [adding, setAdding] = useState(false);
    const [busy, setBusy] = useState<string | null>(null);

    const reset = () => {
        setName("");
        setUrl("");
    };

    const handleAdd = async () => {
        let normalized = "";
        try {
            normalized = normalizeChannelUrl(url);
        } catch (error) {
            message.error(describeChannelError(error));
            return;
        }
        const channel: UpdateChannel = {
            id: channelIdFromUrl(normalized),
            name: name.trim() || new URL(normalized).hostname,
            kind: "json",
            url: normalized,
        };
        // 先试拉再落盘：地址填错（网页而非 JSON、跨域受限）当场可见，
        // 且不会把无效渠道存进列表让用户反复点。
        setBusy(channel.id);
        try {
            const result = await pullChannel(channel);
            useUserLibrary.getState().saveChannel(channel);
            reset();
            message.success(t("expertLibrary.channel.addedAndPulled", { name: channel.name, count: result.count }));
        } catch (error) {
            message.error(describeChannelError(error));
        } finally {
            setBusy(null);
        }
    };

    const handlePull = async (channel: UpdateChannel) => {
        setBusy(channel.id);
        try {
            const result = await pullChannel(channel);
            message.success(t("expertLibrary.channel.pulled", { name: channel.name, count: result.count }));
        } catch (error) {
            message.error(describeChannelError(error), 8);
        } finally {
            setBusy(null);
        }
    };

    return (
        <Modal open={open} onCancel={onClose} onOk={onClose} okText={t("common.close")} cancelButtonProps={{ style: { display: "none" } }} title={t("expertLibrary.channel.title")} width={720}>
            <div className="flex flex-col gap-4">
                <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("expertLibrary.channel.hint")}</div>

                <Table<UpdateChannel>
                    rowKey="id"
                    size="small"
                    pagination={false}
                    dataSource={channels}
                    locale={{ emptyText: t("expertLibrary.channel.empty") }}
                    columns={[
                        {
                            title: t("expertLibrary.channel.name"),
                            dataIndex: "name",
                            render: (value: string, record) => (
                                <div className="flex flex-col">
                                    <span className="font-medium text-stone-800 dark:text-stone-100">{value}</span>
                                    {record.url ? <span className="text-[11px] text-stone-400">{record.url}</span> : null}
                                    {record.lastAt ? (
                                        <span className="text-[11px] text-stone-400">
                                            {new Date(record.lastAt).toLocaleString()}
                                            {record.lastSummary ? ` · ${record.lastSummary}` : ""}
                                        </span>
                                    ) : null}
                                </div>
                            ),
                        },
                        {
                            title: t("expertLibrary.channel.kind"),
                            dataIndex: "kind",
                            width: 130,
                            render: (kind: UpdateChannel["kind"]) => (kind === "json" ? <span className="text-xs text-sky-600 dark:text-sky-400">{t("expertLibrary.channel.custom")}</span> : <span className="text-xs text-stone-500">{t("expertLibrary.channel.builtin")}</span>),
                        },
                        {
                            title: "",
                            width: 120,
                            align: "right",
                            render: (_, record) => (
                                <div className="flex items-center justify-end gap-1">
                                    {record.kind === "workbuddy" ? (
                                        <Button type="text" size="small" icon={<RefreshCw className="size-4" />} onClick={onRefreshWorkbuddy} title={t("expertLibrary.channel.refreshBuiltin")} />
                                    ) : (
                                        <Button type="text" size="small" loading={busy === record.id} icon={<RefreshCw className="size-4" />} onClick={() => void handlePull(record)} title={t("expertLibrary.channel.pull")} />
                                    )}
                                    {isCustomChannel(record) ? (
                                        <Popconfirm
                                            title={t("expertLibrary.channel.removeConfirm", { name: record.name })}
                                            okText={t("expertLibrary.remove.ok")}
                                            cancelText={t("common.cancel")}
                                            okButtonProps={{ danger: true }}
                                            onConfirm={() => useUserLibrary.getState().removeChannel(record.id)}
                                        >
                                            <Button type="text" size="small" danger icon={<Trash2 className="size-4" />} />
                                        </Popconfirm>
                                    ) : null}
                                </div>
                            ),
                        },
                    ]}
                />

                <div className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                    <div className="mb-2 flex items-center gap-1.5 text-sm font-medium text-stone-700 dark:text-stone-200">
                        {adding ? <Plus className="size-4" /> : <Cloud className="size-4" />}
                        {adding ? t("expertLibrary.channel.addCustom") : t("expertLibrary.channel.add")}
                    </div>
                    {adding ? (
                        <div className="flex flex-col gap-2">
                            <Input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("expertLibrary.channel.namePlaceholder")} />
                            <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com/skills.json" />
                            <div className="flex items-center gap-2">
                                <Button type="primary" onClick={() => void handleAdd()}>
                                    {t("expertLibrary.channel.saveAndPull")}
                                </Button>
                                <Button onClick={reset}>{t("common.cancel")}</Button>
                            </div>
                        </div>
                    ) : (
                        <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
                            {t("expertLibrary.channel.add")}
                        </Button>
                    )}
                </div>
            </div>
        </Modal>
    );
}
