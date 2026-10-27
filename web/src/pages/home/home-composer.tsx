import { useCallback, useMemo, useState } from "react";
import { App, Tooltip } from "antd";
import { ArrowUp, FileText, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { navigationTools } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * 首页灵感输入框（复刻 Seko 的玻璃质感 composer）。
 *
 * 真实行为（不是装饰）：
 * - 顶部 tab 选择要进入的工作台（画布 / 生图 / 视频），右侧同步显示该工作台当前的默认模型。
 * - 输入内容后回车或点发送：先尝试把提示词写进剪贴板，再跳到对应工作台，
 *   这样落地页直接粘贴即可用。
 *   ⚠️ 不往 image/video 页面加 URL 参数解析——那属于其它模块，本轮只改首页。
 * - 下方胶囊是示例灵感，点击填入输入框。
 */

const TARGETS = [
    { slug: "canvas", modelKey: "textModel" },
    { slug: "image", modelKey: "imageModel" },
    { slug: "video", modelKey: "videoModel" },
] as const;

type TargetSlug = (typeof TARGETS)[number]["slug"];

/** 渠道模型值是 `<channelId>::<modelName>` 编码，展示时只取名字部分。 */
function modelLabel(value: string): string {
    const raw = (value || "").trim();
    if (!raw) return "—";
    const index = raw.indexOf("::");
    return index >= 0 ? raw.slice(index + 2) : raw;
}

export function HomeComposer() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [target, setTarget] = useState<TargetSlug>("canvas");
    const [value, setValue] = useState("");
    const textModel = useConfigStore((state) => state.config.textModel);
    const imageModel = useConfigStore((state) => state.config.imageModel);
    const videoModel = useConfigStore((state) => state.config.videoModel);

    const model = useMemo(() => {
        const map: Record<TargetSlug, string> = { canvas: textModel, image: imageModel, video: videoModel };
        return modelLabel(map[target] || "");
    }, [imageModel, target, textModel, videoModel]);

    const ideas = useMemo(() => [t("home.composer.idea1"), t("home.composer.idea2"), t("home.composer.idea3"), t("home.composer.idea4")], [t]);

    const submit = useCallback(async () => {
        const text = value.trim();
        if (!text) {
            message.warning(t("home.composer.empty"));
            return;
        }
        // 非安全上下文（局域网 IP 访问）下 clipboard 不可用 → 静默跳过，不阻断跳转。
        try {
            await navigator.clipboard.writeText(text);
            message.success(t("home.composer.copied"));
        } catch {
            /* 忽略：没有剪贴板权限时只做跳转 */
        }
        navigate(`/${target}`);
    }, [message, navigate, t, target, value]);

    return (
        <div className="w-full">
            <div className="rounded-2xl border border-white/10 bg-white/[0.055] p-2.5 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
                {/* 目标工作台切换 */}
                <div className="hide-scrollbar flex items-center gap-1 overflow-x-auto px-0.5">
                    {TARGETS.map((item) => {
                        const tool = navigationTools.find((entry) => entry.slug === item.slug);
                        const Icon = tool?.icon;
                        const active = item.slug === target;
                        return (
                            <button
                                key={item.slug}
                                type="button"
                                onClick={() => setTarget(item.slug)}
                                className={cn(
                                    "inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs transition",
                                    active ? "bg-white/[0.12] font-medium text-white" : "text-white/55 hover:bg-white/[0.06] hover:text-white/85",
                                )}
                            >
                                {Icon ? <Icon className="size-3.5" /> : null}
                                {t(`navigation.${item.slug}`)}
                            </button>
                        );
                    })}
                </div>

                {/* 参考图里的绿色引导条：说明「输入一句 → 自动进对应工作台」这条真实链路 */}
                <div className="mx-0.5 mt-1.5 flex items-center gap-1.5 rounded-md bg-emerald-400/[0.09] px-2 py-1 text-[11px] leading-5 text-emerald-300/90">
                    <Sparkles className="size-3 shrink-0" />
                    <span className="truncate">{t("home.composer.tip")}</span>
                </div>

                <textarea
                    value={value}
                    onChange={(event) => setValue(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void submit();
                        }
                    }}
                    rows={3}
                    placeholder={t("home.composer.placeholder")}
                    spellCheck={false}
                    className="mt-1.5 w-full resize-none bg-transparent px-2 py-1.5 text-[13px] leading-6 text-white outline-none placeholder:text-white/30"
                />

                <div className="flex items-center justify-between gap-2 px-0.5 pt-0.5">
                    <div className="flex min-w-0 items-center gap-1">
                        <Tooltip title={t("home.composer.fromLibrary")} placement="top" mouseEnterDelay={0.2}>
                            <button
                                type="button"
                                onClick={() => navigate("/prompts")}
                                aria-label={t("home.composer.fromLibrary")}
                                className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
                            >
                                <FileText className="size-4" />
                            </button>
                        </Tooltip>
                        <span className="truncate text-[11px] text-white/40">{model}</span>
                    </div>

                    <button
                        type="button"
                        onClick={() => void submit()}
                        aria-label={t("home.composer.send")}
                        className={cn(
                            "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full transition",
                            value.trim() ? "bg-white text-stone-900 hover:bg-white/90" : "cursor-not-allowed bg-white/15 text-white/40",
                        )}
                    >
                        <ArrowUp className="size-4" />
                    </button>
                </div>
            </div>

            {/* 示例灵感：点击填入，不改变任何入口 */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                {ideas.map((idea) => (
                    <button
                        key={idea}
                        type="button"
                        onClick={() => setValue(idea)}
                        className="cursor-pointer rounded-full border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[11px] text-white/60 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
                    >
                        {idea}
                    </button>
                ))}
            </div>
        </div>
    );
}
