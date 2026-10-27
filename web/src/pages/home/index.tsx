import { ArrowRight, FilePlus2, FileText, Menu } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { App, Image, Tag } from "antd";
import { useNavigate } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";

import { fetchPrompts, type Prompt } from "@/services/api/prompts";
import { HomeComposer } from "@/pages/home/home-composer";
import { HomeSideNav } from "@/components/layout/home-side-nav";
import { MobileNavDrawer } from "@/components/layout/mobile-nav-drawer";
import { navigationTools } from "@/constant/navigation-tools";
import i18n from "@/i18n";
import { cn } from "@/lib/utils";

/**
 * 首页（深色视觉 + 灵感输入框，配色与版式参考 Seko）。
 *
 * 边界：
 * - 只有首页是这套深色视觉；其它页面沿用原来的浅/深主题，不受影响。
 * - 原有能力全部保留：提示词 showcase（同一个 fetchPrompts 数据源 + 同一套预览弹窗）、
 *   「查看提示词库」、开始创作/打开画布等入口都在，只是重新排布。
 * - 左侧入口由 HomeSideNav 承担（lg+），小屏仍是 AppTopNav 的顶部条 + 抽屉。
 */

/** 页面底色：近黑暖灰，与参考图一致，不跟随全局明暗主题。 */
const PAGE_BG = "#0a0908";

function Highlighter({ action, color, children }: { action: "highlight" | "underline"; color: string; children?: ReactNode }) {
    return (
        <span className="relative inline-block px-1">
            {action === "highlight" ? (
                <span className="absolute inset-x-0 bottom-0 top-1 rounded-sm opacity-25" style={{ backgroundColor: color }} />
            ) : (
                <span className="absolute inset-x-0 bottom-0 h-1 rounded-full opacity-70" style={{ backgroundColor: color }} />
            )}
            <span className="relative font-medium text-white">{children}</span>
        </span>
    );
}

export default function IndexPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [primaryTool] = navigationTools;
    const [promptShowcase, setPromptShowcase] = useState<Prompt[]>([]);
    const [previewIndex, setPreviewIndex] = useState(0);
    const [previewOpen, setPreviewOpen] = useState(false);
    // 首页不渲染 AppTopNav，小屏的导航入口由这里接管（同一个抽屉组件，功能不变）。
    const [mobileNavOpen, setMobileNavOpen] = useState(false);

    useEffect(() => {
        void fetchPrompts({ pageSize: 12 })
            .then((data) => setPromptShowcase(data.items))
            .catch((error) => message.error(error instanceof Error ? error.message : i18n.t("home.promptError")));
    }, [message]);

    return (
        // lg+ 由左侧图标栏承担入口；小屏仍显示顶部条（AppTopNav 在首页 lg:hidden）。
        <div className="flex h-full min-h-0" style={{ backgroundColor: PAGE_BG }}>
            <HomeSideNav />
            <main className="relative min-w-0 flex-1 overflow-y-auto overflow-x-hidden text-white">
                {/* 小屏导航入口（lg+ 由左侧图标栏替代） */}
                <button
                    type="button"
                    onClick={() => setMobileNavOpen(true)}
                    aria-label={t("topNav.openMenu")}
                    className="absolute left-3 top-3 z-30 inline-flex size-9 items-center justify-center rounded-[10px] text-white/70 transition hover:bg-white/10 hover:text-white lg:hidden"
                >
                    <Menu className="size-5" />
                </button>
                {/* 顶部氛围光：抽象化的暖色光晕，代替参考图里的模糊人物背景。 */}
                <div className="pointer-events-none absolute inset-x-0 top-0 h-[620px] overflow-hidden">
                    <div className="absolute left-1/2 top-[-140px] h-[520px] w-[980px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(255,132,60,0.5),transparent_66%)] blur-[100px]" />
                    <div className="absolute left-[14%] top-6 size-[320px] rounded-full bg-[radial-gradient(circle,rgba(255,86,48,0.34),transparent_70%)] blur-[80px]" />
                    <div className="absolute right-[12%] top-16 size-[300px] rounded-full bg-[radial-gradient(circle,rgba(255,196,120,0.26),transparent_70%)] blur-[80px]" />
                    <div className="absolute inset-0 bg-gradient-to-b from-transparent via-[#0a0908]/45 to-[#0a0908]" />
                </div>

                <section className="relative mx-auto w-full max-w-6xl px-6 pb-24 pt-16 sm:pt-20">
                    <div className="flex flex-col items-center text-center">
                        <h1 className="max-w-4xl text-balance text-3xl font-medium tracking-tight text-white sm:text-4xl">{t("home.heroTitle")}</h1>
                        <p className="mt-4 max-w-2xl text-balance text-sm leading-7 text-white/50">
                            <Trans i18nKey="home.description" components={{ canvas: <Highlighter action="underline" color="#FF9800" />, content: <Highlighter action="highlight" color="#87CEFA" /> }} />
                        </p>

                        <div className="mt-9 w-full max-w-3xl">
                            <HomeComposer />
                        </div>

                        <div className="mt-6 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-xs text-white/45">
                            <button type="button" className="cursor-pointer transition hover:text-white" onClick={() => navigate(`/${primaryTool.slug}`)}>
                                {t("home.start")}
                            </button>
                            <span className="text-white/20">·</span>
                            <button type="button" className="cursor-pointer transition hover:text-white" onClick={() => navigate("/canvas")}>
                                {t("home.openCanvas")}
                            </button>
                        </div>
                    </div>

                    {/* 特色功能：左侧两张功能卡 + 右侧提示词卡（沿用原有 showcase 数据） */}
                    <section className="relative mt-20">
                        <div className="mb-5 flex items-end justify-between gap-4">
                            <h2 className="text-sm font-medium text-white/90">{t("home.features")}</h2>
                            <button
                                type="button"
                                onClick={() => navigate("/prompts")}
                                className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-white/45 transition hover:text-white"
                            >
                                {t("home.viewPrompts")}
                                <ArrowRight className="size-3" />
                            </button>
                        </div>

                        <div className="grid gap-4 lg:grid-cols-[220px_1fr]">
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
                                <button
                                    type="button"
                                    onClick={() => navigate("/canvas?mode=new")}
                                    className="flex cursor-pointer flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.045] p-4 text-left transition hover:border-white/20 hover:bg-white/[0.08]"
                                >
                                    <FilePlus2 className="size-5 text-white/70" />
                                    <div className="mt-8">
                                        <div className="text-[13px] font-medium text-white">{t("home.featureNewCanvas")}</div>
                                        <div className="mt-1 text-[11px] leading-5 text-white/40">{t("home.featureNewCanvasHint")}</div>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    onClick={() => navigate("/prompts")}
                                    className="flex cursor-pointer flex-col justify-between rounded-xl border border-white/[0.08] bg-white/[0.045] p-4 text-left transition hover:border-white/20 hover:bg-white/[0.08]"
                                >
                                    <FileText className="size-5 text-white/70" />
                                    <div className="mt-8">
                                        <div className="text-[13px] font-medium text-white">{t("navigation.prompts")}</div>
                                        <div className="mt-1 text-[11px] leading-5 text-white/40">{t("home.featurePromptsHint")}</div>
                                    </div>
                                </button>
                            </div>

                            <div className="grid auto-rows-[150px] grid-cols-2 gap-4 sm:grid-cols-3">
                                {/* 提示词来源需要联网拉取；拿不到时给占位，避免看起来像坏掉 */}
                                {promptShowcase.length === 0 ? (
                                    <div className="col-span-2 flex items-center justify-center rounded-xl border border-dashed border-white/[0.08] text-[11px] text-white/30 sm:col-span-3">
                                        {t("home.showcaseEmpty")}
                                    </div>
                                ) : null}
                                {promptShowcase.slice(0, 6).map((item, index) => (
                                    <button
                                        key={item.id}
                                        type="button"
                                        onClick={() => {
                                            setPreviewIndex(index);
                                            setPreviewOpen(true);
                                        }}
                                        className={cn(
                                            "group relative cursor-pointer overflow-hidden rounded-xl border border-white/[0.08] bg-white/[0.04] text-left transition hover:border-white/20",
                                            index === 0 && "col-span-2 row-span-2 sm:col-span-2",
                                        )}
                                    >
                                        <img src={item.coverUrl} alt={item.title} className="h-full w-full object-cover transition duration-500 group-hover:scale-[1.04]" />
                                        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent p-3 text-white">
                                            <div className="mb-1.5 flex flex-wrap gap-1">
                                                {item.tags.slice(0, 2).map((tag) => (
                                                    <Tag key={tag} variant="filled" className="m-0 bg-white/15 text-[10px] text-white/90 backdrop-blur">
                                                        {tag}
                                                    </Tag>
                                                ))}
                                            </div>
                                            <h3 className="truncate text-xs font-medium">{item.title}</h3>
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </div>
                    </section>
                </section>

                <Image.PreviewGroup
                    preview={{
                        open: previewOpen,
                        current: previewIndex,
                        onOpenChange: setPreviewOpen,
                        onChange: setPreviewIndex,
                    }}
                >
                    <div className="hidden">
                        {promptShowcase.map((item) => (
                            <Image key={item.id} src={item.coverUrl} alt={item.title} />
                        ))}
                    </div>
                </Image.PreviewGroup>
            </main>

            <MobileNavDrawer open={mobileNavOpen} activeToolSlug={undefined} onClose={() => setMobileNavOpen(false)} />
        </div>
    );
}
