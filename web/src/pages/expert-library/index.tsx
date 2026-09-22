import { useMemo, useState } from "react";
import { Plus, Plug, Search, Sparkles, UserPlus } from "lucide-react";
import { App, Button, Empty, Input, Segmented, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { DetailDrawer } from "./components/detail-drawer";
import { ItemCard } from "./components/item-card";
import { launchAgentAssistant } from "./agent-launcher";
import { invokeItem } from "./invoke-mode";
import { registerLibraryNodes, subscribeLibraryNodes } from "./library-nodes";
// 副作用引入：把三类能力挂到「节点插件」管理器的标签页，并接入智能体输入框的 `/` 调用。
import "./plugin-manager-tabs";
import "./composer-callables";
import {
    ALL_OPTION,
    MY_CONNECTORS_CATEGORY,
    MY_EXPERTS_CATEGORY,
    useLibraryFilter,
    useLibraryItems,
} from "./use-expert-library";
import { useUserLibrary } from "./state/user-library";
import { AddSkillModal, type AddSkillTab } from "./components/add-skill-modal";
import { ConnectorManagerModal } from "./components/connector-manager-modal";
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

    const userExperts = useUserLibrary((state) => state.experts);
    const installs = useUserLibrary((state) => state.installs);
    const userConnectors = useUserLibrary((state) => state.connectors);

    const items = useLibraryItems(kind);
    const { categories, filtered } = useLibraryFilter(items, keyword, category);
    const kindLabel = t(`expertLibrary.tabs.${kind}`);

    const myExpertsCount = useMemo(() => userExperts.length, [userExperts]);
    const installedCount = useMemo(() => installs.length, [installs]);
    const myConnectorsCount = useMemo(() => userConnectors.length, [userConnectors]);

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

    return (
        <div className="flex h-full flex-col overflow-hidden bg-background text-stone-800 dark:text-stone-100">
            <main className="min-h-0 flex-1 overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-4 py-6 [background-size:16px_16px] sm:px-6 lg:py-8 dark:bg-[radial-gradient(rgba(245,245,244,.16)_1px,transparent_1px)]">
                <div className="mx-auto max-w-7xl">
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                        <div>
                            <h1 className="text-2xl font-semibold text-stone-950 dark:text-stone-100">{t("expertLibrary.title")}</h1>
                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("expertLibrary.subtitle")}</p>
                        </div>
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
                                    <CheckableTag key={option} checked={category === option} onChange={() => setCategory(option)}>
                                        {option}
                                    </CheckableTag>
                                ))}
                            </div>
                        </aside>

                        <section className="min-w-0">
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
                                <div className="mt-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
                                    {filtered.map((item) => (
                                        <ItemCard key={`${item.kind}:${item.id}`} item={item} onOpen={setSelected} onInvoke={handleInvoke} />
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
        </div>
    );
}
