import { useState } from "react";
import { ExternalLink, Play, TerminalSquare } from "lucide-react";
import { App, Button } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { canvasThemes } from "@/lib/canvas-theme";
import { registerPluginManagerTab } from "@/lib/canvas/plugin-manager-tabs";
import { useThemeStore } from "@/stores/use-theme-store";
import { DetailDrawer } from "./components/detail-drawer";
import { resolveIcon } from "./components/icon-map";
import { invokeItem } from "./invoke-mode";
import { launchAgentAssistant } from "./agent-launcher";
import { useLibraryItems } from "./use-expert-library";
import type { LibraryItem, LibraryKind } from "./data/types";

/**
 * 把「专家 / 技能 / 连接器」作为额外标签页挂到「节点插件」管理器里。
 *
 * 实现方式：通过 `@/lib/canvas/plugin-manager-tabs` 的扩展点注册，
 * 插件管理器自身只多了一行「渲染已注册标签页」，原有三个标签页与插件安装 /
 * 启用 / 卸载逻辑完全不受影响。
 *
 * 每个标签页复用专家库既有能力：`useLibraryItems` 取数、`DetailDrawer` 看详情、
 * `invokeInCanvas` 在画布智能体里调用 —— 不新增第二套数据或调用逻辑。
 */

function LibraryTabLabel({ kind }: { kind: LibraryKind }) {
    const { t } = useTranslation();
    return <>{t(`expertLibrary.tabs.${kind}`)}</>;
}

function LibraryPluginPanel({ kind }: { kind: LibraryKind }) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const navigate = useNavigate();
    const items = useLibraryItems(kind);
    const [selected, setSelected] = useState<LibraryItem | null>(null);

    const kindLabel = t(`expertLibrary.tabs.${kind}`);

    // 与专家库页面保持一致：未检测到本机 Canvas Agent 时给出启动引导（含一键启动）。
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
                        icon={<TerminalSquare className="size-4" />}
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
        else if (result === "placed") message.success(t("expertLibrary.pluginTabs.placed"));
        else if (result === "no-canvas") message.warning(t("expertLibrary.pluginTabs.noCanvas", { defaultValue: "请先打开一个画布，再选择「作为节点调用」" }));
        else if (result === "connected") message.success(t("expertLibrary.invoked"));
    };

    return (
        <div className="space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="text-xs leading-5" style={{ color: theme.node.muted }}>
                    <div>{t(`expertLibrary.pluginTabs.kindHint.${kind}`)}</div>
                    <div className="mt-0.5">{t("expertLibrary.pluginTabs.count", { count: items.length, kind: kindLabel })}</div>
                </div>
                <Button type="text" size="small" icon={<ExternalLink className="size-4" />} onClick={() => navigate("/experts")}>
                    {t("expertLibrary.pluginTabs.openLibrary")}
                </Button>
            </div>

            <div className="thin-scrollbar max-h-[46vh] space-y-2 overflow-auto">
                {items.length === 0 ? (
                    <div className="py-10 text-center text-sm" style={{ color: theme.node.muted }}>
                        {t("expertLibrary.pluginTabs.empty", { kind: kindLabel })}
                    </div>
                ) : (
                    items.map((item) => {
                        const Icon = resolveIcon(item.icon);
                        return (
                            <div
                                key={`${item.kind}:${item.id}`}
                                className="flex items-center gap-3 rounded-xl border px-3 py-2.5"
                                style={{ borderColor: theme.node.stroke, background: theme.node.fill }}
                            >
                                <span className="grid size-9 shrink-0 place-items-center rounded-lg" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                                    <Icon className="size-4" />
                                </span>
                                <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(item)}>
                                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium" style={{ color: theme.node.text }}>
                                        <span className="truncate">{item.name}</span>
                                        <span className="shrink-0 rounded-full px-1.5 py-0.5 text-[10px]" style={{ background: theme.toolbar.activeBg, color: theme.node.muted }}>
                                            {item.category}
                                        </span>
                                    </div>
                                    <div className="mt-0.5 truncate text-xs" style={{ color: theme.node.muted }}>
                                        {item.description}
                                    </div>
                                </button>
                                <Button type="primary" size="small" icon={<Play className="size-4" />} onClick={() => void handleInvoke(item)}>
                                    {t("expertLibrary.pluginTabs.invoke")}
                                </Button>
                            </div>
                        );
                    })
                )}
            </div>

            <DetailDrawer item={selected} open={Boolean(selected)} onClose={() => setSelected(null)} onInvoke={handleInvoke} />
        </div>
    );
}

const PLUGIN_TAB_KINDS: LibraryKind[] = ["expert", "skill", "connector"];

// 模块加载即注册（专家库路由为 eager import，应用启动时就会执行到这里）。
for (const kind of PLUGIN_TAB_KINDS) {
    registerPluginManagerTab({
        key: `expert-library-${kind}`,
        label: <LibraryTabLabel kind={kind} />,
        children: <LibraryPluginPanel kind={kind} />,
    });
}
