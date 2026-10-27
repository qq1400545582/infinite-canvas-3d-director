import { Bot } from "lucide-react";
import { Tooltip } from "antd";
import { Link, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AnimatedThemeToggler } from "@/components/ui/animated-theme-toggler";
import { GitHubLink } from "@/components/layout/github-link";
import { VersionReleaseModal } from "@/components/layout/version-release-modal";
import { navigationTools, type NavigationToolSlug } from "@/constant/navigation-tools";
import { changeAppLocale, type AppLocale } from "@/i18n";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

/**
 * 首页左侧导航 —— 窄图标栏（参考 Seko 左侧 rail）。
 *
 * 边界：
 * - 只由首页渲染，且只在 lg+ 显示；小屏继续用 AppTopNav 的顶部条 + MobileNavDrawer。
 * - 入口与原来的顶部导航**完全一致**（我的画布 / 生图工作台 / 视频创作台 / 提示词库 /
 *   专家库 / 我的资产 / 配置），只是收成图标，名称用 Tooltip 显示。
 * - 首页是固定深色视觉，所以这里不复用 UserStatusActions（它跟随全局明暗），改为自带
 *   白色系配色渲染同样的能力：Agent / 主题 / 语言 / 版本 / GitHub，功能不丢。
 */

const ICON_BTN = "inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-[10px] text-white/60 transition hover:bg-white/10 hover:text-white";

export function HomeSideNav() {
    const { t, i18n } = useTranslation();
    const { pathname } = useLocation();
    const theme = useThemeStore((state) => state.theme);
    const setTheme = useThemeStore((state) => state.setTheme);
    const panelOpen = useAgentStore((state) => state.panelOpen);
    const togglePanel = useAgentStore((state) => state.togglePanel);
    const activeSlug = pathname.split("/").filter(Boolean)[0];

    const locale = i18n.resolvedLanguage as AppLocale;
    const nextLocale = locale === "zh-CN" ? "en-US" : "zh-CN";
    const languageLabel = t("topNav.switchLanguage", { language: t(nextLocale === "zh-CN" ? "locale.zhCN" : "locale.enUS") });
    const themeLabel = t(theme === "dark" ? "topNav.lightTheme" : "topNav.darkTheme");

    return (
        <aside className="hidden w-16 shrink-0 flex-col items-center border-r border-white/[0.06] bg-black/30 py-3 lg:flex">
            <Link to="/" className="mb-3 flex size-9 shrink-0 items-center justify-center rounded-[10px] text-white transition hover:bg-white/10" aria-label={t("meta.title")}>
                <span
                    className="size-5 bg-current"
                    style={{
                        mask: "url(/logo.svg) center / contain no-repeat",
                        WebkitMask: "url(/logo.svg) center / contain no-repeat",
                    }}
                />
            </Link>

            <nav className="flex min-h-0 flex-1 flex-col items-center gap-1 overflow-y-auto">
                {navigationTools.map((tool) => {
                    const Icon = tool.icon;
                    const active = tool.slug === activeSlug;
                    const label = t(`navigation.${tool.slug as NavigationToolSlug}`);
                    return (
                        <Tooltip key={tool.slug} title={label} placement="right" mouseEnterDelay={0.2}>
                            <Link to={`/${tool.slug}`} aria-label={label} className={cn(ICON_BTN, active ? "bg-white/[0.14] text-white" : "")}>
                                <Icon className="size-[18px]" />
                            </Link>
                        </Tooltip>
                    );
                })}
            </nav>

            {/* 底部：与顶部导航右侧那组操作一一对应，只是换成图标形态。 */}
            <div className="mt-2 flex shrink-0 flex-col items-center gap-1 border-t border-white/[0.08] pt-2">
                <Tooltip title={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")} placement="right" mouseEnterDelay={0.2}>
                    <button type="button" className={cn(ICON_BTN, "relative")} onClick={togglePanel} aria-label={t(panelOpen ? "topNav.closeAgent" : "topNav.openAgent")}>
                        <Bot className="size-[18px]" />
                        <span className={cn("absolute right-1.5 top-1.5 size-1.5 rounded-full", panelOpen ? "bg-emerald-400" : "bg-white/25")} />
                    </button>
                </Tooltip>

                <Tooltip title={themeLabel} placement="right" mouseEnterDelay={0.2}>
                    <AnimatedThemeToggler theme={theme} onThemeChange={setTheme} className={ICON_BTN} aria-label={themeLabel} title={themeLabel} />
                </Tooltip>

                <Tooltip title={languageLabel} placement="right" mouseEnterDelay={0.2}>
                    <button type="button" className={cn(ICON_BTN, "text-[11px] font-semibold")} onClick={() => void changeAppLocale(nextLocale)} aria-label={languageLabel}>
                        {locale === "zh-CN" ? "中" : "EN"}
                    </button>
                </Tooltip>

                <Tooltip title={t("version.viewUpdates")} placement="right" mouseEnterDelay={0.2}>
                    <VersionReleaseModal className={cn(ICON_BTN, "text-[10px] font-medium tracking-tight")} />
                </Tooltip>

                <GitHubLink className={cn(ICON_BTN, "bg-transparent text-base hover:bg-white/10")} />
            </div>
        </aside>
    );
}
