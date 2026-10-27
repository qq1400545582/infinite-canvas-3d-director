import { Popover } from "antd";
import { Palette } from "lucide-react";
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

export function HomeStyleLibrary({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (styleName: string) => void }) {
    const { t } = useTranslation();

    const content = (
        <div className="w-[620px] max-w-[calc(100vw-160px)] rounded-[14px] border border-white/10 bg-[rgba(22,20,18,0.96)] p-3 shadow-[0_30px_80px_-20px_rgba(0,0,0,0.9)] backdrop-blur-xl">
            <div className="mb-2.5 flex items-center justify-between">
                <span className="text-xs font-medium text-white/85">{t("home.composer.stylePickerTitle")}</span>
                <span className="text-[11px] text-white/35">{t("home.composer.stylePickerCount", { count: STYLE_PRESETS.length })}</span>
            </div>

            <div className="thin-scrollbar grid max-h-[330px] grid-cols-5 gap-2 overflow-y-auto pr-1">
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
                            className="group flex cursor-pointer flex-col overflow-hidden rounded-lg bg-white/[0.04] text-left ring-1 ring-transparent transition hover:bg-white/[0.09] hover:ring-white/20 focus-visible:ring-white/40 focus-visible:outline-none"
                            title={name}
                        >
                            <span className="relative block aspect-[4/3] w-full overflow-hidden" style={{ background: preset.preview }}>
                                {/* 顶部柔光 + 底部压暗：让色块读起来像「画面预览」而不是色卡 */}
                                <span className="absolute inset-0 bg-[radial-gradient(circle_at_28%_18%,rgba(255,255,255,0.30),transparent_60%)]" />
                                <span className="absolute inset-0 bg-[radial-gradient(circle_at_80%_75%,rgba(255,255,255,0.12),transparent_55%)]" />
                                <span className="absolute inset-0 bg-gradient-to-t from-black/50 via-black/10 to-transparent" />
                            </span>
                            <span className="truncate px-1.5 py-1 text-center text-[10px] leading-4 text-white/70 transition group-hover:text-white">{name}</span>
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
                className={cn(
                    "inline-flex cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] transition",
                    open ? "bg-white/[0.12] text-white" : "text-white/55 hover:bg-white/10 hover:text-white",
                )}
            >
                <Palette className="size-3.5" />
                {t("home.composer.styleLibrary")}
            </button>
        </Popover>
    );
}
