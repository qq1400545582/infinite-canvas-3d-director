import { Bot } from "lucide-react";
import { Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { DesktopDownloadButton } from "@/components/layout/desktop-download-button";
import { UserStatusActions } from "@/components/layout/user-status-actions";
import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";

/**
 * 首页左侧导航（参考 Seko 的侧边栏布局）：品牌区 → 分组菜单 → 底部工具区。
 *
 * 边界：
 * - 只在首页渲染，且只在 md 及以上显示（`hidden md:flex`）；小屏继续用 AppTopNav 的
 *   顶部条 + MobileNavDrawer，避免侧栏在手机上挤占宽度。
 * - 入口与原来的顶部导航**完全一致**（我的画布 / 生图工作台 / 视频创作台 / 提示词库 /
 *   专家库 / 我的资产 / 配置），只是从横向改为纵向并按用途分组。
 * - 右侧原有的 Agent、下载桌面端、语言/主题/版本/GitHub 等操作收敛到底部工具区，不丢功能。
 */

/** 分组：只调整视觉组织，不增删任何入口。 */
const GROUPS = [
    { key: "create", slugs: ["canvas", "image", "video"] },
    { key: "resources", slugs: ["prompts", "experts", "assets"] },
    { key: "settings", slugs: ["config"] },
] as const;

export function HomeSideNav() {
    const { t } = useTranslation();
    const { pathname } = useLocation();
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    const activeSlug = pathname.split("/").filter(Boolean)[0];

    const itemBase = "group flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-sm leading-6 transition-colors";
    const itemIdle = "text-stone-600 hover:bg-stone-200/60 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-800/60 dark:hover:text-stone-100";
    // 选中项做成「浮起的小卡片」，这是 Seko 侧栏最明显的视觉特征。
    const itemActive = "bg-white font-medium text-stone-950 shadow-[0_1px_2px_rgba(0,0,0,0.06)] ring-1 ring-stone-200/80 dark:bg-stone-800 dark:text-stone-50 dark:ring-stone-700/70";

    return (
        <aside className="hidden w-64 shrink-0 flex-col border-r border-stone-200/80 bg-stone-50/70 lg:flex dark:border-stone-800 dark:bg-stone-950/40">
            <Link
                to="/"
                className="flex h-14 shrink-0 items-center gap-2 px-4 text-sm font-semibold leading-none tracking-tight text-stone-950 transition hover:text-stone-600 dark:text-stone-100 dark:hover:text-stone-300"
            >
                <span
                    className="size-5 shrink-0 bg-current"
                    style={{
                        mask: "url(/logo.svg) center / contain no-repeat",
                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                    }}
                />
                <span className="text-base font-medium">{t("meta.title")}</span>
            </Link>

            <nav className="hide-scrollbar min-h-0 flex-1 overflow-y-auto px-3 pb-4">
                {GROUPS.map((group, groupIndex) => {
                    const tools = navigationTools.filter((tool) => (group.slugs as readonly string[]).includes(tool.slug));
                    if (!tools.length) return null;
                    return (
                        <div key={group.key}>
                            <div className={cn("px-2.5 text-[11px] font-medium tracking-wide text-stone-400 dark:text-stone-500", groupIndex === 0 ? "mb-1 pt-1" : "mb-1 pt-4")}>
                                {t(`home.sidebar.${group.key}`)}
                            </div>
                            <div className="space-y-0.5">
                                {tools.map((tool) => {
                                    const Icon = tool.icon;
                                    const active = tool.slug === activeSlug;
                                    return (
                                        <Link key={tool.slug} to={`/${tool.slug}`} className={cn(itemBase, active ? itemActive : itemIdle)}>
                                            <Icon className="size-4 shrink-0" />
                                            <span className="truncate">{t(`navigation.${tool.slug as NavigationToolSlug}`)}</span>
                                        </Link>
                                    );
                                })}
                            </div>
                        </div>
                    );
                })}
            </nav>

            <div className="shrink-0 border-t border-stone-200/80 p-3 dark:border-stone-800">
                <Tooltip title={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")} placement="right">
                    <button type="button" className={cn(itemBase, itemIdle, "w-full")} onClick={togglePanel} aria-label={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")}>
                        <Bot className="size-4 shrink-0" />
                        <span className="truncate">Agent</span>
                        <span className={cn("ml-auto size-1.5 shrink-0 rounded-full", panelOpen ? "bg-emerald-500" : "bg-stone-300 dark:bg-stone-600")} />
                    </button>
                </Tooltip>
                <div className="mt-1 flex items-center justify-between gap-1">
                    {/* 配置已经在菜单里，底部工具区不再重复一个设置入口。 */}
                    <UserStatusActions showConfig={false} />
                    <DesktopDownloadButton />
                </div>
            </div>
        </aside>
    );
}
