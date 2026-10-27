import { Popover } from "antd";
import { Check, Palette, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { STYLE_PRESETS } from "@/pages/home/style-presets";
import { cn } from "@/lib/utils";

/**
 * 首页画风库（参考站「画风列表」面板的布局复刻）。
 *
 * - 触发：输入框工具行里的「风格库」按钮，点击后在输入框下方展开。
 * - 布局：标题 + 5 列网格 + 卡片（风格预览 + 名称），超出高度内部滚动。
 * - 行为：点任意风格即把该风格词追加到提示词并收起面板。
 */

const PANEL_WIDTH = 620;

export function HomeStyleLibrary({
    open,
    onOpenChange,
    value,
    onSelect,
    onClear,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    /** 已选风格名；有值时按钮直接显示它，不再显示「风格库」 */
    value: string | null;
    onSelect: (styleName: string) => void;
    onClear: () => void;
}) {
    const { t } = useTranslation();

    const content = (
        <div className="w-[620px] max-w-[calc(100vw-160px)] rounded-[14px] border border-white/10 bg-[rgba(22,20,18,0.96)] p-3 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl">
            <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-medium text-white/85">{t("home.composer.stylePickerTitle")}</span>
                <span className="text-[11px] text-white/35">{t("home.composer.stylePickerCount", { count: STYLE_PRESETS.length })}</span>
            </div>

            <div className="thin-scrollbar grid max-h-[352px] grid-cols-5 gap-2 overflow-y-auto pr-1">
                {STYLE_PRESETS.map((preset) => {
                    const name = t(`home.composer.styles.${preset.id}`);
                    return (
                        <button
                            key={preset.id}
                            type="button"
                            onClick={() => {
                                onSelect(name);
                                onOpenChange(false);
                            }}
                            className="group relative cursor-pointer overflow-hidden rounded-lg bg-white/[0.04] ring-1 ring-transparent transition hover:ring-white/25 focus-visible:ring-white/40 focus-visible:outline-none"
                            title={name}
                        >
                            <img
                                src={`/styles/${preset.id}.jpg`}
                                alt={name}
                                loading="lazy"
                                draggable={false}
                                className="aspect-[153/124] w-full object-cover transition duration-300 group-hover:scale-[1.04]"
                            />
                            {/* 名称压在图片底部（与参考站一致），不额外占一行高度 */}
                            <span className="pointer-events-none absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/85 via-black/45 to-transparent px-1.5 pb-1 pt-6 text-center text-[10px] leading-4 text-white/90">
                                {name}
                            </span>
                            {value === name ? (
                                <span className="pointer-events-none absolute right-1 top-1 inline-flex size-4 items-center justify-center rounded-full bg-white text-stone-900">
                                    <Check className="size-2.5" strokeWidth={3} />
                                </span>
                            ) : null}
                        </button>
                    );
                })}
            </div>
        </div>
    );

    return (
        <Popover
            open={open}
            onOpenChange={onOpenChange}
            trigger="click"
            placement="bottomRight"
            arrow={false}
            content={content}
            styles={{
                // 面板外观全部由内层 div 负责，去掉 antd 默认的白底/内边距，避免深色面板套一层浅色边框
                content: { background: "transparent", padding: 0, boxShadow: "none" },
            }}
        >
            <button
                type="button"
                onClick={() => onOpenChange(!open)}
                title={value ? `${t("home.composer.styleLibrary")}：${value}` : t("home.composer.styleLibrary")}
                className={cn(
                    "inline-flex max-w-[130px] cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] transition",
                    value
                        ? "bg-white/[0.14] text-white ring-1 ring-white/25"
                        : open
                          ? "bg-white/[0.12] text-white"
                          : "text-white/55 hover:bg-white/10 hover:text-white",
                )}
            >
                <Palette className="size-3.5 shrink-0" />
                <span className="truncate">{value || t("home.composer.styleLibrary")}</span>
                {value ? (
                    <span
                        role="button"
                        tabIndex={-1}
                        aria-label={t("home.composer.clearStyle")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onClear();
                        }}
                        className="inline-flex shrink-0 items-center justify-center rounded-full p-0.5 transition hover:bg-white/20"
                    >
                        <X className="size-3" />
                    </span>
                ) : null}
            </button>
        </Popover>
    );
}
