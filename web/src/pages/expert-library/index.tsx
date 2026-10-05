import { useMemo, useState } from "react";
import { CloudDownload, Plus, Plug, RefreshCw, RotateCcw, Search, Sparkles, UserPlus } from "lucide-react";
import { App, Button, Empty, Input, Popconfirm, Segmented, Tag, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { DetailDrawer } from "./components/detail-drawer";
import { ItemCard } from "./components/item-card";
// 副作用引入：专家库卡片样式（结构/数值取自 WorkBuddy 专家中心，作用域隔离在 .wb-ec-scope 内）。
import "./expert-card.css";
import { launchAgentAssistant } from "./agent-launcher";
import { invokeItem } from "./invoke-mode";
import { pullWorkbuddyUpdates, PullError } from "./pull-updates";
import { describeChannelError, pullChannel, type PullProgress } from "./channel-source";
import { registerLibraryNodes, subscribeLibraryNodes } from "./library-nodes";
// 副作用引入：把三类能力挂到「节点插件」管理器的标签页，并接入智能体输入框的 `/` 调用。
import "./plugin-manager-tabs";
import "./composer-callables";
import {
    ALL_OPTION,
    SELF_MEDIA_CATEGORY,
    MY_CONNECTORS_CATEGORY,
    MY_EXPERTS_CATEGORY,
    useLibraryFilter,
    useLibraryItems,
} from "./use-expert-library";
import { useUserLibrary, removeLibraryItem, LIBTV_CHANNEL, LIBTV_CHANNEL_ID } from "./state/user-library";
import { AddSkillModal, type AddSkillTab } from "./components/add-skill-modal";
import { ChannelManagerModal } from "./components/channel-manager-modal";
import { ConnectorManagerModal } from "./components/connector-manager-modal";
import { SelfMediaMonitor } from "./components/self-media-monitor";
import { CreateExpertModal } from "./components/create-expert-modal";
import type { LibraryItem, LibraryKind } from "./data/types";

// 在模块加载时把专家 / 技能 / 连接器全部注册为画布节点（路由为 eager import，故应用启动即生效），
// 并订阅用户数据变化，使用户新建的「我的专家」与已安装的技能自动同步为画布节点。
registerLibraryNodes();
subscribeLibraryNodes();

const { CheckableTag } = Tag;

export default function ExpertLibraryPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const [kind, setKind] = useState<LibraryKind>("expert");
    const [keyword, setKeyword] = useState("");
    const [category, setCategory] = useState<string>(ALL_OPTION);
    const [selected, setSelected] = useState<LibraryItem | null>(null);
    const [addSkillOpen, setAddSkillOpen] = useState(false);
    const [addSkillTab, setAddSkillTab] = useState<AddSkillTab>("import");
    const [createExpertOpen, setCreateExpertOpen] = useState(false);
    const [connectorOpen, setConnectorOpen] = useState(false);
    const [channelOpen, setChannelOpen] = useState(false);

    const userExperts = useUserLibrary((state) => state.experts);
    const installs = useUserLibrary((state) => state.installs);
    const userConnectors = useUserLibrary((state) => state.connectors);
    const catalogAt = useUserLibrary((state) => state.catalog.at);
    const removed = useUserLibrary((state) => state.removed);
    const channelItems = useUserLibrary((state) => state.channelItems);
    const [pulling, setPulling] = useState(false);

    const items = useLibraryItems(kind);
    const { categories, filtered } = useLibraryFilter(items, keyword, category);
    const kindLabel = t(`expertLibrary.tabs.${kind}`);

    const myExpertsCount = useMemo(() => userExperts.length, [userExperts]);
    const installedCount = useMemo(() => installs.length, [installs]);
    const myConnectorsCount = useMemo(() => userConnectors.length, [userConnectors]);
    const removedCount = useMemo(() => removed.experts.length + removed.skills.length + removed.connectors.length, [removed]);

    // 自媒体（LibTV）实时拉取：与「拉取 WorkBuddy 更新」同一套语义（手动触发 + 进度可见 + 失败可行动）
    const isSelfMediaView = kind === "skill" && category === SELF_MEDIA_CATEGORY;
    const selfMediaLiveCount = useMemo(() => (channelItems[LIBTV_CHANNEL_ID] || []).length, [channelItems]);
    const [selfMediaPulling, setSelfMediaPulling] = useState(false);
    const [selfMediaProgress, setSelfMediaProgress] = useState<PullProgress | null>(null);
    const handleSelfMediaUpdate = async () => {
        if (selfMediaPulling) return;
        setSelfMediaPulling(true);
        setSelfMediaProgress({ page: 0, count: 0 });
        try {
            const result = await pullChannel(LIBTV_CHANNEL, (info) => setSelfMediaProgress(info));
            setSelfMediaProgress(null);
            message.success(t("selfMedia.updated", { count: result.count }));
        } catch (error) {
            setSelfMediaProgress(null);
            message.error(describeChannelError(error), 8);
        } finally {
            setSelfMediaPulling(false);
        }
    };

    /**
     * 删除一个库条目：用户自建/本地安装真删，目录条目移入隐藏清单（可恢复）。
     * 删除后画布节点会自动重注册（store 订阅），已放置的节点退化为默认卡片而不会崩。
     */
    const handleRemove = (item: LibraryItem) => {
        removeLibraryItem(item);
        setSelected((current) => (current && current.id === item.id && current.kind === item.kind ? null : current));
        message.success(t("expertLibrary.remove.removed", { name: item.name }));
    };

    const handleRestoreAll = () => {
        useUserLibrary.getState().restoreAll();
        message.success(t("expertLibrary.remove.restoredAll"));
    };

    const showAgentSetupGuide = () => {
        const guide = modal.info({
            title: t("expertLibrary.agentSetup.title"),
            okText: t("expertLibrary.agentSetup.confirm"),
            width: 540,
            content: (
                <div className="flex flex-col gap-3 text-sm leading-6 text-stone-600 dark:text-stone-400">
                    <p>{t("expertLibrary.agentSetup.desc")}</p>
                    <Button
                        type="primary"
                        icon={<Plug className="size-4" />}
                        onClick={() => {
                            guide.destroy();
                            launchAgentAssistant();
                        }}
                    >
                        一键启动 Canvas Agent
                    </Button>
                    <div>
                        <div className="font-semibold text-stone-800 dark:text-stone-200">{t("expertLibrary.agentSetup.step1Title")}</div>
                        <p>{t("expertLibrary.agentSetup.step1")}</p>
                    </div>
                    <div>
                        <div className="font-semibold text-stone-800 dark:text-stone-200">{t("expertLibrary.agentSetup.step2Title")}</div>
                        <p>{t("expertLibrary.agentSetup.step2")}</p>
                    </div>
                    <div>
                        <div className="font-semibold text-stone-800 dark:text-stone-200">{t("expertLibrary.agentSetup.step3Title")}</div>
                        <p>{t("expertLibrary.agentSetup.step3")}</p>
                    </div>
                    <p className="rounded-lg bg-amber-50 p-2.5 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300">
                        {t("expertLibrary.agentSetup.note")}
                    </p>
                </div>
            ),
        });
    };

    const handleInvoke = async (item: LibraryItem) => {
        const result = await invokeItem(item);
        if (result === "no-agent") showAgentSetupGuide();
        else if (result === "placed") message.success("已作为节点放置到画布");
        else if (result === "no-canvas") message.warning("请先打开一个画布，再选择「作为节点调用」");
        else if (result === "connected") message.success(t("expertLibrary.invoked"));
    };

    const handleTabChange = (value: string | number) => {
        setKind(value as LibraryKind);
        setCategory(ALL_OPTION);
    };

    const openAddSkill = (tab: AddSkillTab) => {
        setAddSkillTab(tab);
        setAddSkillOpen(true);
    };

    /** 立即拉取 WorkBuddy 内专家/技能/连接器的最新内容（经本机 Canvas Agent 同步）。 */
    const handlePull = async () => {
        if (pulling) return;
        setPulling(true);
        try {
            const summary = await pullWorkbuddyUpdates();
            const parts: string[] = [];
            if (summary.skills.added.length) parts.push(t("expertLibrary.pull.skillsAdded", { count: summary.skills.added.length }));
            if (summary.experts.added || summary.experts.updated) {
                parts.push(t("expertLibrary.pull.expertsChanged", { added: summary.experts.added, updated: summary.experts.updated }));
            }
            if (summary.connectors.added || summary.connectors.updated) {
                parts.push(t("expertLibrary.pull.connectorsChanged", { added: summary.connectors.added, updated: summary.connectors.updated }));
            }
            if (parts.length) message.success(parts.join("；"));
            else message.success(t("expertLibrary.pull.upToDate"));
            if (summary.skills.conflicts.length) {
                message.warning(t("expertLibrary.pull.conflicts", { count: summary.skills.conflicts.length }), 6);
            }
            if (summary.experts.bodiesFailed.length) {
                message.warning(t("expertLibrary.pull.bodiesFailed", { count: summary.experts.bodiesFailed.length }), 6);
            }
        } catch (error) {
            if (error instanceof PullError && error.code === "no-agent") showAgentSetupGuide();
            else message.error(error instanceof Error ? error.message : t("expertLibrary.pull.failed"));
        } finally {
            setPulling(false);
        }
    };

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 lg:py-8 dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
                <div className="mx-auto max-w-7xl">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("expertLibrary.title")}</h1>
                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("expertLibrary.subtitle")}</p>
                        </div>
                        <div className="flex items-center gap-2">
                            <Tooltip title={catalogAt ? t("expertLibrary.pull.lastAt", { time: new Date(catalogAt).toLocaleString() }) : t("expertLibrary.pull.tooltip")}>
                                <Button icon={<RefreshCw className="size-4" />} loading={pulling} onClick={() => void handlePull()}>
                                    {t("expertLibrary.pull.title")}
                                </Button>
                            </Tooltip>
                            <Tooltip title={t("expertLibrary.channel.manageHint")}>
                                <Button icon={<CloudDownload className="size-4" />} onClick={() => setChannelOpen(true)}>
                                    {t("expertLibrary.channel.manage")}
                                </Button>
                            </Tooltip>
                            <Segmented
                                value={kind}
                                onChange={handleTabChange}
                                options={[
                                    { label: t("expertLibrary.tabs.expert"), value: "expert" },
                                    { label: t("expertLibrary.tabs.skill"), value: "skill" },
                                    { label: t("expertLibrary.tabs.connector"), value: "connector" },
                                ]}
                            />
                        </div>
                    </div>

                    <div className="mt-5 grid items-start gap-5 lg:grid-cols-[220px_minmax(0,1fr)] lg:gap-6">
                        <aside className="thin-scrollbar max-h-72 overflow-y-auto border-b border-stone-200 pb-5 lg:sticky lg:top-0 lg:max-h-[calc(100dvh-6rem)] lg:border-b-0 lg:border-r lg:pb-8 lg:pr-5 dark:border-stone-800">
                            <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">
                                {t("expertLibrary.category")}
                            </div>
                            <div className="flex flex-wrap gap-1.5">
                                <CheckableTag checked={category === ALL_OPTION} onChange={() => setCategory(ALL_OPTION)}>
                                    {t("common.all")}
                                </CheckableTag>
                                {categories.map((option) => (
                                    <CheckableTag key={option.name} checked={category === option.name} onChange={() => setCategory(option.name)}>
                                        {option.name}
                                        <span className="ml-1 text-[10px] opacity-60">{option.count}</span>
                                    </CheckableTag>
                                ))}
                            </div>
                        </aside>

                        <section className="min-w-0">
                            {/* 自媒体（LibTV）技能的实时监控：只在选中「自媒体」分类时出现，不打扰其它分类 */}
                            {kind === "skill" && isSelfMediaView ? (
                                <SelfMediaMonitor pulling={selfMediaPulling} progress={selfMediaProgress} liveCount={selfMediaLiveCount} onUpdate={() => void handleSelfMediaUpdate()} />
                            ) : null}
                            <div className="flex flex-wrap items-center justify-between gap-3">
                                <div className="flex items-center gap-2">
                                    <Input
                                        size="large"
                                        prefix={<Search className="size-4 text-stone-400" />}
                                        value={keyword}
                                        placeholder={t("expertLibrary.search")}
                                        onChange={(event) => setKeyword(event.target.value)}
                                        className="max-w-md"
                                    />
                                    {kind === "expert" && myExpertsCount > 0 ? (
                                        <Tag color="purple" className="m-0 shrink-0">
                                            {t("expertLibrary.myExperts.count", { count: myExpertsCount })}
                                        </Tag>
                                    ) : null}
                                    {kind === "skill" && installedCount > 0 ? (
                                        <Tag color="green" className="m-0 shrink-0">
                                            {t("expertLibrary.addSkill.installedCount", { count: installedCount })}
                                        </Tag>
                                    ) : null}
                                    {kind === "connector" && myConnectorsCount > 0 ? (
                                        <Tag color="cyan" className="m-0 shrink-0">
                                            {t("expertLibrary.myConnectors.count", { count: myConnectorsCount })}
                                        </Tag>
                                    ) : null}
                                </div>

                                <div className="flex items-center gap-2">
                                    {removedCount > 0 ? (
                                        <Tooltip title={t("expertLibrary.remove.restoreAllHint")}>
                                            <span>
                                                <Popconfirm
                                                    title={t("expertLibrary.remove.restoreAllConfirm")}
                                                    okText={t("expertLibrary.remove.restoreAll")}
                                                    cancelText={t("common.cancel")}
                                                    onConfirm={handleRestoreAll}
                                                >
                                                    <Button icon={<RotateCcw className="size-4" />}>
                                                        {t("expertLibrary.remove.restoreAll")} ({removedCount})
                                                    </Button>
                                                </Popconfirm>
                                            </span>
                                        </Tooltip>
                                    ) : null}
                                    {kind === "expert" ? (
                                        <>
                                            <Button
                                                icon={<UserPlus className="size-4" />}
                                                disabled={myExpertsCount === 0}
                                                onClick={() => setCategory(MY_EXPERTS_CATEGORY)}
                                            >
                                                {t("expertLibrary.myExperts.title")}
                                            </Button>
                                            <Button type="primary" icon={<Sparkles className="size-4" />} onClick={() => setCreateExpertOpen(true)}>
                                                {t("expertLibrary.myExperts.create")}
                                            </Button>
                                        </>
                                    ) : null}
                                    {kind === "skill" ? (
                                        <Button type="primary" icon={<Plus className="size-4" />} onClick={() => openAddSkill("import")}>
                                            {t("expertLibrary.addSkill.title")}
                                        </Button>
                                    ) : null}
                                    {kind === "connector" ? (
                                        <>
                                            <Button
                                                icon={<Plug className="size-4" />}
                                                disabled={myConnectorsCount === 0}
                                                onClick={() => setCategory(MY_CONNECTORS_CATEGORY)}
                                            >
                                                {t("expertLibrary.myConnectors.title")}
                                            </Button>
                                            <Button type="primary" icon={<Plug className="size-4" />} onClick={() => setConnectorOpen(true)}>
                                                {t("expertLibrary.addConnector.title")}
                                            </Button>
                                        </>
                                    ) : null}
                                    <span className="shrink-0 text-xs text-stone-500 dark:text-stone-400">
                                        {t("expertLibrary.total", { count: filtered.length, kind: kindLabel })}
                                    </span>
                                </div>
                            </div>

                            {filtered.length ? (
                                <div className="ec-expert-grid mt-5">
                                    {filtered.map((item) => (
                                        <ItemCard key={`${item.kind}:${item.id}`} item={item} onOpen={setSelected} onInvoke={handleInvoke} onRemove={handleRemove} />
                                    ))}
                                </div>
                            ) : (
                                <Empty
                                    image={Empty.PRESENTED_IMAGE_SIMPLE}
                                    description={t("expertLibrary.empty", { kind: kindLabel })}
                                    className="py-16"
                                />
                            )}
                        </section>
                    </div>
                </div>
            </main>

            <DetailDrawer
                item={selected}
                open={Boolean(selected)}
                onClose={() => setSelected(null)}
                onInvoke={handleInvoke}
                onRemove={handleRemove}
            />

            <AddSkillModal
                open={addSkillOpen}
                initialTab={addSkillTab}
                onClose={() => setAddSkillOpen(false)}
                onInstalled={(skills) => useUserLibrary.getState().recordInstalls(skills)}
                onRequireAgent={showAgentSetupGuide}
            />

            <CreateExpertModal
                open={createExpertOpen}
                onClose={() => setCreateExpertOpen(false)}
                onCreated={(item) => useUserLibrary.getState().addExpert(item)}
                onRequireAgent={showAgentSetupGuide}
            />

            <ConnectorManagerModal open={connectorOpen} onClose={() => setConnectorOpen(false)} />

            <ChannelManagerModal
                open={channelOpen}
                onClose={() => setChannelOpen(false)}
                onRefreshWorkbuddy={() => {
                    setChannelOpen(false);
                    void handlePull();
                }}
            />
        </div>
    );
}
