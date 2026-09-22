import { useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Empty, Input, Modal, Popconfirm, Segmented, Switch, Tag } from "antd";
import {
    ArrowLeft,
    Check,
    CircleAlert,
    Link2,
    LoaderCircle,
    Pencil,
    Plug,
    Plus,
    Search,
    Server,
    Trash2,
    Upload,
} from "lucide-react";
import { useTranslation } from "react-i18next";

import { fetchLinkedConnectors, parseConnectorText, type ConnectorParseErrorCode } from "../connector-source";
import type { ConnectorConfig, ConnectorTransport } from "../data/types";
import { connectorEndpoint, useUserLibrary } from "../state/user-library";

type ConnectorView = "list" | "form" | "import" | "link";

type Pair = { key: string; value: string };

type FormState = {
    name: string;
    transport: ConnectorTransport;
    command: string;
    args: string;
    url: string;
    pairs: Pair[];
    description: string;
    enabled: boolean;
};

const EMPTY_FORM: FormState = {
    name: "",
    transport: "stdio",
    command: "",
    args: "",
    url: "",
    pairs: [],
    description: "",
    enabled: true,
};

/**
 * 「连接器管理」弹窗：为专家库的连接器 Tab 提供**自定义连接器**能力。
 *
 * 面板形态对齐「MCP 服务管理」：顶部搜索 + 配置入口，列表展示已配置服务并支持
 * 启用 / 停用 / 编辑 / 删除；配置项对齐 MCP 约定（stdio 用 command+args+env，
 * SSE/HTTP 用 url+headers），并支持粘贴 MCP 配置文本或从 GitHub / Gitee 链接导入。
 *
 * 配置只落 localStorage（专家库自身的用户数据），不在页面内建立常驻连接；
 * 画布智能体在「调用」时按提示词按需接入，因此不会与其它模块的 Agent 生命周期耦合。
 */
export function ConnectorManagerModal({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved?: (configs: ConnectorConfig[]) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const connectors = useUserLibrary((state) => state.connectors);

    const [view, setView] = useState<ConnectorView>("list");
    const [keyword, setKeyword] = useState("");
    const [form, setForm] = useState<FormState>(EMPTY_FORM);
    const [editing, setEditing] = useState<string | null>(null);
    const [importText, setImportText] = useState("");
    const [link, setLink] = useState("");
    const [linkLoading, setLinkLoading] = useState(false);
    const [parsed, setParsed] = useState<ConnectorConfig[] | null>(null);
    const [error, setError] = useState<ConnectorParseErrorCode | "invalidUrl" | "unsupported" | "network" | "notFound" | null>(null);

    // 每次打开都回到列表首页，避免上次的编辑态残留
    useEffect(() => {
        if (!open) return;
        setView("list");
        setKeyword("");
        setForm(EMPTY_FORM);
        setEditing(null);
        setImportText("");
        setLink("");
        setParsed(null);
        setError(null);
    }, [open]);

    const filtered = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        if (!kw) return connectors;
        return connectors.filter((config) => [config.name, config.description || "", config.command || "", config.url || ""].join(" ").toLowerCase().includes(kw));
    }, [connectors, keyword]);

    const transportLabel = (transport: ConnectorTransport) => t(`expertLibrary.addConnector.transport${transport === "stdio" ? "Stdio" : transport === "sse" ? "Sse" : "Http"}`);

    const toForm = (config: ConnectorConfig): FormState => ({
        name: config.name,
        transport: config.transport,
        command: config.command || "",
        args: (config.args || []).join("\n"),
        url: config.url || "",
        pairs: Object.entries(config.env || {}).map(([key, value]) => ({ key, value })),
        description: config.description || "",
        enabled: config.enabled,
    });

    const pairsToRecord = (pairs: Pair[]) => {
        const out: Record<string, string> = {};
        for (const pair of pairs) if (pair.key.trim()) out[pair.key.trim()] = pair.value;
        return out;
    };

    /* ---------------------------------------------------------------- *
     * 保存：手工表单 / 文本导入 / 链接导入
     * ---------------------------------------------------------------- */

    const persist = (configs: ConnectorConfig[], messageKey: string) => {
        const store = useUserLibrary.getState();
        for (const config of configs) store.addConnector(config);
        onSaved?.(configs);
        message.success(t(messageKey, { count: configs.length }));
    };

    const handleSaveForm = () => {
        const name = form.name.trim();
        const command = form.command.trim();
        const url = form.url.trim();
        if (!name) {
            message.warning(t("expertLibrary.addConnector.fieldNameRequired"));
            return;
        }
        if (form.transport === "stdio" && !command) {
            message.warning(t("expertLibrary.addConnector.fieldCommandRequired"));
            return;
        }
        if (form.transport !== "stdio" && !/^https?:\/\//i.test(url)) {
            message.warning(t("expertLibrary.addConnector.fieldUrlRequired"));
            return;
        }
        const env = pairsToRecord(form.pairs);
        const config: ConnectorConfig = {
            name,
            transport: form.transport,
            ...(form.transport === "stdio"
                ? { command, ...(form.args.trim() ? { args: form.args.split("\n").map((line) => line.trim()).filter(Boolean) } : {}) }
                : { url }),
            ...(Object.keys(env).length ? { env } : {}),
            ...(form.description.trim() ? { description: form.description.trim() } : {}),
            enabled: form.enabled,
            at: Date.now(),
            from: "manual",
        };
        const store = useUserLibrary.getState();
        if (editing && editing !== name) store.removeConnector(editing);
        persist([config], editing ? "expertLibrary.addConnector.updated" : "expertLibrary.addConnector.savedCount");
        setView("list");
        setForm(EMPTY_FORM);
        setEditing(null);
    };

    const handleImport = () => {
        const outcome = parseConnectorText(importText, { from: "import" });
        if (!outcome.ok) {
            setError(outcome.code);
            setParsed(null);
            return;
        }
        setError(null);
        setParsed(outcome.configs);
        message.success(t("expertLibrary.addConnector.parsedCount", { count: outcome.configs.length }));
    };

    const handleLink = async () => {
        const target = link.trim();
        if (!target) {
            setError("invalidUrl");
            return;
        }
        setLinkLoading(true);
        setError(null);
        setParsed(null);
        const outcome = await fetchLinkedConnectors(target);
        setLinkLoading(false);
        if (!outcome.ok) {
            // `RemoteErrorCode` 含 noSkills，但连接器场景不会出现，归一到 notFound 以复用文案。
            setError(outcome.code === "noSkills" ? "notFound" : outcome.code);
            return;
        }
        setParsed(outcome.configs);
        message.success(t("expertLibrary.addConnector.parsedCount", { count: outcome.configs.length }));
    };

    /* ---------------------------------------------------------------- *
     * 列表行
     * ---------------------------------------------------------------- */

    const row = (config: ConnectorConfig) => {
        const endpoint = connectorEndpoint(config);
        return (
            <li
                key={config.name}
                className="flex items-center gap-3 rounded-xl border border-stone-200 px-3 py-2.5 dark:border-stone-800"
            >
                <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400">
                    {config.transport === "stdio" ? <Server className="size-4" /> : <Plug className="size-4" />}
                </span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{config.name}</span>
                        <Tag className="m-0 text-[11px]" color={config.transport === "stdio" ? "blue" : "green"}>
                            {transportLabel(config.transport)}
                        </Tag>
                        {!config.enabled ? (
                            <Tag className="m-0 text-[11px]">
                                {t("expertLibrary.addConnector.disabledTag")}
                            </Tag>
                        ) : null}
                    </div>
                    <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500 dark:text-stone-400">{endpoint || "—"}</div>
                    {config.description ? <div className="mt-0.5 truncate text-xs text-stone-400 dark:text-stone-500">{config.description}</div> : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                    <Switch
                        size="small"
                        checked={config.enabled}
                        onChange={(checked) => {
                            useUserLibrary.getState().setConnectorEnabled(config.name, checked);
                            onSaved?.([{ ...config, enabled: checked }]);
                            message.success(t(checked ? "expertLibrary.addConnector.enabledToast" : "expertLibrary.addConnector.disabledToast", { name: config.name }));
                        }}
                    />
                    <Button
                        type="text"
                        size="small"
                        icon={<Pencil className="size-4" />}
                        title={t("expertLibrary.addConnector.edit")}
                        onClick={() => {
                            setForm(toForm(config));
                            setEditing(config.name);
                            setView("form");
                        }}
                    />
                    <Popconfirm
                        title={t("expertLibrary.addConnector.removeConfirm")}
                        okText={t("expertLibrary.addConnector.remove")}
                        cancelText={t("common.cancel")}
                        onConfirm={() => {
                            useUserLibrary.getState().removeConnector(config.name);
                            message.success(t("expertLibrary.addConnector.removed", { name: config.name }));
                        }}
                    >
                        <Button type="text" size="small" danger icon={<Trash2 className="size-4" />} title={t("expertLibrary.addConnector.remove")} />
                    </Popconfirm>
                </div>
            </li>
        );
    };

    /* ---------------------------------------------------------------- *
     * 三个视图
     * ---------------------------------------------------------------- */

    const listView = (
        <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
                <Input
                    allowClear
                    value={keyword}
                    prefix={<Search className="size-4 text-stone-400" />}
                    placeholder={t("expertLibrary.addConnector.search")}
                    onChange={(event) => setKeyword(event.target.value)}
                    className="min-w-40 flex-1"
                />
                <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { setForm(EMPTY_FORM); setEditing(null); setView("form"); }}>
                    {t("expertLibrary.addConnector.configure")}
                </Button>
                <Button icon={<Upload className="size-4" />} onClick={() => setView("import")}>
                    {t("expertLibrary.addConnector.importText")}
                </Button>
                <Button icon={<Link2 className="size-4" />} onClick={() => setView("link")}>
                    {t("expertLibrary.addConnector.importLink")}
                </Button>
            </div>

            {connectors.length ? (
                <>
                    <div className="text-xs text-stone-500 dark:text-stone-400">
                        {t("expertLibrary.addConnector.count", { count: filtered.length })}
                    </div>
                    <ul className="thin-scrollbar flex max-h-[46vh] flex-col gap-2 overflow-y-auto">
                        {filtered.length ? filtered.map(row) : <li className="py-6 text-center text-sm text-stone-400 dark:text-stone-500">{t("expertLibrary.addConnector.noMatch")}</li>}
                    </ul>
                </>
            ) : (
                <div className="flex flex-col items-center gap-3 py-10">
                    <span className="grid size-12 place-items-center rounded-2xl bg-stone-100 text-stone-400 dark:bg-stone-800 dark:text-stone-500">
                        <Plug className="size-6" />
                    </span>
                    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("expertLibrary.addConnector.empty")} />
                    <p className="-mt-3 text-center text-xs text-stone-500 dark:text-stone-400">{t("expertLibrary.addConnector.emptyHint")}</p>
                    <Button type="primary" onClick={() => { setForm(EMPTY_FORM); setEditing(null); setView("form"); }}>
                        {t("expertLibrary.addConnector.configure")}
                    </Button>
                </div>
            )}
        </div>
    );

    const pairsEditor = (
        <div className="flex flex-col gap-2">
            <div className="text-sm text-stone-700 dark:text-stone-300">
                {t(form.transport === "stdio" ? "expertLibrary.addConnector.fieldEnv" : "expertLibrary.addConnector.fieldHeaders")}
            </div>
            {form.pairs.map((pair, index) => (
                <div key={index} className="flex items-center gap-2">
                    <Input
                        value={pair.key}
                        placeholder={t("expertLibrary.addConnector.pairKey")}
                        onChange={(event) => setForm((prev) => ({ ...prev, pairs: prev.pairs.map((item, i) => (i === index ? { ...item, key: event.target.value } : item)) }))}
                    />
                    <Input
                        value={pair.value}
                        placeholder={t("expertLibrary.addConnector.pairValue")}
                        onChange={(event) => setForm((prev) => ({ ...prev, pairs: prev.pairs.map((item, i) => (i === index ? { ...item, value: event.target.value } : item)) }))}
                    />
                    <Button
                        type="text"
                        danger
                        icon={<Trash2 className="size-4" />}
                        onClick={() => setForm((prev) => ({ ...prev, pairs: prev.pairs.filter((_, i) => i !== index) }))}
                    />
                </div>
            ))}
            <Button size="small" type="dashed" icon={<Plus className="size-4" />} className="self-start" onClick={() => setForm((prev) => ({ ...prev, pairs: [...prev.pairs, { key: "", value: "" }] }))}>
                {t("expertLibrary.addConnector.addPair")}
            </Button>
        </div>
    );

    const formView = (
        <div className="flex flex-col gap-4">
            <button type="button" className="inline-flex items-center gap-1.5 self-start text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200" onClick={() => setView("list")}>
                <ArrowLeft className="size-4" />
                {t("expertLibrary.addConnector.back")}
            </button>
            <div className="text-sm font-medium text-stone-800 dark:text-stone-100">
                {editing ? t("expertLibrary.addConnector.editTitle") : t("expertLibrary.addConnector.createTitle")}
            </div>

            <div className="grid grid-cols-1 gap-x-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1.5">
                    <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.fieldName")}</span>
                    <Input value={form.name} placeholder={t("expertLibrary.addConnector.fieldNamePlaceholder")} onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))} />
                </label>
                <div className="flex flex-col gap-1.5">
                    <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.fieldTransport")}</span>
                    <Segmented
                        value={form.transport}
                        onChange={(value) => setForm((prev) => ({ ...prev, transport: value as ConnectorTransport }))}
                        options={[
                            { label: t("expertLibrary.addConnector.transportStdio"), value: "stdio" },
                            { label: t("expertLibrary.addConnector.transportSse"), value: "sse" },
                            { label: t("expertLibrary.addConnector.transportHttp"), value: "http" },
                        ]}
                    />
                </div>
            </div>

            {form.transport === "stdio" ? (
                <>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.fieldCommand")}</span>
                        <Input value={form.command} placeholder={t("expertLibrary.addConnector.fieldCommandPlaceholder")} onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))} />
                    </label>
                    <label className="flex flex-col gap-1.5">
                        <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.fieldArgs")}</span>
                        <Input.TextArea
                            autoSize={{ minRows: 2, maxRows: 5 }}
                            value={form.args}
                            placeholder={t("expertLibrary.addConnector.fieldArgsPlaceholder")}
                            onChange={(event) => setForm((prev) => ({ ...prev, args: event.target.value }))}
                        />
                    </label>
                </>
            ) : (
                <label className="flex flex-col gap-1.5">
                    <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.fieldUrl")}</span>
                    <Input value={form.url} placeholder={t("expertLibrary.addConnector.fieldUrlPlaceholder")} onChange={(event) => setForm((prev) => ({ ...prev, url: event.target.value }))} />
                </label>
            )}

            {pairsEditor}

            <label className="flex flex-col gap-1.5">
                <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.fieldDescription")}</span>
                <Input.TextArea
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    value={form.description}
                    placeholder={t("expertLibrary.addConnector.fieldDescriptionPlaceholder")}
                    onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
                />
            </label>

            <div className="flex items-center gap-2">
                <Switch size="small" checked={form.enabled} onChange={(checked) => setForm((prev) => ({ ...prev, enabled: checked }))} />
                <span className="text-sm text-stone-700 dark:text-stone-300">{t("expertLibrary.addConnector.enabled")}</span>
            </div>

            <div className="flex items-center gap-2">
                <Button type="primary" icon={<Check className="size-4" />} onClick={handleSaveForm}>
                    {editing ? t("expertLibrary.addConnector.update") : t("expertLibrary.addConnector.save")}
                </Button>
                <Button onClick={() => setView("list")}>{t("common.cancel")}</Button>
            </div>
        </div>
    );

    const parsedPreview = parsed?.length ? (
        <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
                <span className="text-xs text-stone-500 dark:text-stone-400">{t("expertLibrary.addConnector.parsedCount", { count: parsed.length })}</span>
                <Button
                    type="primary"
                    size="small"
                    onClick={() => {
                        persist(parsed, "expertLibrary.addConnector.savedCount");
                        setView("list");
                        setParsed(null);
                        setImportText("");
                        setLink("");
                    }}
                >
                    {t("expertLibrary.addConnector.saveAll")}
                </Button>
            </div>
            <ul className="thin-scrollbar flex max-h-52 flex-col gap-1.5 overflow-y-auto">
                {parsed.map((config) => (
                    <li key={config.name} className="flex items-start gap-2 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <Plug className="mt-0.5 size-4 shrink-0 text-stone-400" />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                                <span className="truncate text-sm font-medium text-stone-800 dark:text-stone-100">{config.name}</span>
                                <Tag className="m-0 text-[11px]" color={config.transport === "stdio" ? "blue" : "green"}>
                                    {transportLabel(config.transport)}
                                </Tag>
                            </div>
                            <div className="mt-0.5 truncate font-mono text-[11px] text-stone-500 dark:text-stone-400">{connectorEndpoint(config) || "—"}</div>
                        </div>
                    </li>
                ))}
            </ul>
        </div>
    ) : null;

    const errorBanner = error ? <Alert type="error" showIcon message={t(`expertLibrary.addConnector.errors.${error}`)} /> : null;

    const importView = (
        <div className="flex flex-col gap-4">
            <button type="button" className="inline-flex items-center gap-1.5 self-start text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200" onClick={() => setView("list")}>
                <ArrowLeft className="size-4" />
                {t("expertLibrary.addConnector.back")}
            </button>
            <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("expertLibrary.addConnector.importHint")}</div>
            <Input.TextArea
                className="!font-mono !text-xs !leading-5"
                autoSize={{ minRows: 7, maxRows: 12 }}
                value={importText}
                placeholder={t("expertLibrary.addConnector.importPlaceholder")}
                onChange={(event) => setImportText(event.target.value)}
            />
            {errorBanner}
            <div>
                <Button type="primary" onClick={handleImport}>
                    {t("expertLibrary.addConnector.parse")}
                </Button>
            </div>
            {parsedPreview}
        </div>
    );

    const linkView = (
        <div className="flex flex-col gap-4">
            <button type="button" className="inline-flex items-center gap-1.5 self-start text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200" onClick={() => setView("list")}>
                <ArrowLeft className="size-4" />
                {t("expertLibrary.addConnector.back")}
            </button>
            <div className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("expertLibrary.addConnector.linkHint")}</div>
            <div className="flex flex-wrap gap-2">
                {[
                    { icon: <Server className="size-3.5" />, text: "https://github.com/owner/repo" },
                    { icon: <Link2 className="size-3.5" />, text: "…/blob/main/.mcp.json" },
                    { icon: <Link2 className="size-3.5" />, text: "https://example.com/mcp.json" },
                ].map((example) => (
                    <button
                        key={example.text}
                        type="button"
                        className="inline-flex items-center gap-1.5 rounded-full border border-stone-200 px-2.5 py-1 text-[11px] text-stone-500 transition hover:border-stone-300 hover:text-stone-700 dark:border-stone-700 dark:text-stone-400 dark:hover:text-stone-200"
                        onClick={() => setLink(example.text)}
                    >
                        {example.icon}
                        {example.text}
                    </button>
                ))}
            </div>
            <div className="flex gap-2">
                <Input
                    value={link}
                    prefix={<Link2 className="size-4 text-stone-400" />}
                    placeholder={t("expertLibrary.addConnector.linkPlaceholder")}
                    onChange={(event) => setLink(event.target.value)}
                    onPressEnter={() => void handleLink()}
                />
                <Button type="primary" loading={linkLoading} onClick={() => void handleLink()}>
                    {linkLoading ? <LoaderCircle className="size-4 animate-spin" /> : t("expertLibrary.addConnector.resolve")}
                </Button>
            </div>
            {errorBanner}
            {parsedPreview}
        </div>
    );

    return (
        <Modal title={t("expertLibrary.addConnector.title")} open={open} onCancel={onClose} footer={null} width={640} centered destroyOnHidden>
            <div className="flex flex-col gap-4">
                <p className="text-xs leading-5 text-stone-500 dark:text-stone-400">{t("expertLibrary.addConnector.subtitle")}</p>
                <div className="flex items-start gap-2 rounded-lg border px-3 py-2 text-xs leading-5" style={{ borderColor: "#f59e0b55", background: "#f59e0b14", color: "inherit" }}>
                    <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
                    <span>{t("expertLibrary.addConnector.note")}</span>
                </div>
                <div className={view === "list" ? "block" : "hidden"}>{listView}</div>
                {view === "form" ? formView : null}
                {view === "import" ? importView : null}
                {view === "link" ? linkView : null}
            </div>
        </Modal>
    );
}
