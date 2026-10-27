import { useCallback, useMemo, useRef, useState } from "react";
import { App, Dropdown, Tooltip } from "antd";
import { ArrowUp, LayoutGrid, Plus, Sparkles } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { navigationTools } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * 首页灵感输入框 —— 按参考站（Seko）composer 的结构复刻入口与交互：
 *
 *   ① 顶部 tab     —— 参考站是「短片工作室 / 创作 Agent」；这里是 画布 / 生图 / 视频 + Agent
 *                     （前三个决定发送去哪，Agent 直接打开右侧 Agent 面板）
 *   ② 输入区       —— placeholder 用「输入“/”+ 名称引用」语法
 *   ③ 输入 “/”     —— 打开提示词选择器，选中即插入（对应参考站的 Skill 引用）
 *   ④ 左下 “+”     —— 菜单两项：上传附件（读文本文件填入）/ 从「我的资产」选择
 *   ⑤ 左下 四宫格   —— 打开提示词选择器（对应参考站的「选择 Skill」）
 *   ⑥ 模型名       —— 显示当前工作台默认模型，点击打开配置（对应「选择模型」）
 *   ⑦ 右下圆钮     —— 有内容才可点：复制提示词并跳转工作台
 *   ⑧ 卡片下方胶囊  —— 4 条灵感 + 「更多 技能 →」跳提示词库
 *
 * 所有入口都接本项目真实能力，没有点了没反应的装饰按钮。
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
    if (!raw) return "";
    const index = raw.indexOf("::");
    return index >= 0 ? raw.slice(index + 2) : raw;
}

/** 只接文本类附件：首页没有参考图挂载点，图片留给工作台处理。 */
const TEXT_ACCEPT = ".txt,.md,.markdown,.json,.csv,.yml,.yaml,.ts,.tsx,.js,.py,.html,.css";
const MAX_ATTACH_CHARS = 8000;

export function HomeComposer() {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { message } = App.useApp();
    const [target, setTarget] = useState<TargetSlug>("canvas");
    const [value, setValue] = useState("");
    const [skillOpen, setSkillOpen] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const textModel = useConfigStore((state) => state.config.textModel);
    const imageModel = useConfigStore((state) => state.config.imageModel);
    const videoModel = useConfigStore((state) => state.config.videoModel);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const togglePanel = useAgentStore((state) => state.togglePanel);

    const model = useMemo(() => {
        const map: Record<TargetSlug, string> = { canvas: textModel, image: imageModel, video: videoModel };
        return modelLabel(map[target] || "");
    }, [imageModel, target, textModel, videoModel]);

    const ideas = useMemo(() => [t("home.composer.idea1"), t("home.composer.idea2"), t("home.composer.idea3"), t("home.composer.idea4")], [t]);
    const canSend = Boolean(value.trim());

    const submit = useCallback(async () => {
        const text = value.trim();
        if (!text) return;
        // 非安全上下文（局域网 IP 访问）下 clipboard 不可用 → 静默跳过，不阻断跳转。
        try {
            await navigator.clipboard.writeText(text);
            message.success(t("home.composer.copied"));
        } catch {
            /* 无剪贴板权限时只做跳转 */
        }
        navigate(`/${target}`);
    }, [message, navigate, t, target, value]);

    /** 输入 “/” 即引用提示词（对应参考站的 Skill 引用语法）。 */
    const handleChange = useCallback((next: string) => {
        setValue(next);
        const before = next.slice(0, -1);
        if (next.endsWith("/") && (before.length === 0 || /\s$/.test(before))) setSkillOpen(true);
    }, []);

    const insertPrompt = useCallback((prompt: string) => {
        // 引用时把触发用的 “/” 去掉，避免残留
        setValue((prev) => (prev.endsWith("/") ? prev.slice(0, -1) + prompt : prev ? `${prev}\n${prompt}` : prompt));
    }, []);

    const handleFile = useCallback(
        async (file: File) => {
            if (file.size > 1024 * 1024) {
                message.warning(t("home.composer.attachTooLarge"));
                return;
            }
            try {
                const text = await file.text();
                const clipped = text.slice(0, MAX_ATTACH_CHARS);
                setValue((prev) => (prev ? `${prev}\n${clipped}` : clipped));
                message.success(t("home.composer.attachDone", { name: file.name }));
            } catch {
                message.error(t("home.composer.attachFailed"));
            }
        },
        [message, t],
    );

    const plusMenu = {
        items: [
            { key: "upload", label: t("home.composer.upload") },
            { key: "assets", label: t("home.composer.fromCanvas") },
        ],
        onClick: ({ key }: { key: string }) => {
            if (key === "upload") fileRef.current?.click();
            else navigate("/assets");
        },
    };

    return (
        <div className="w-full">
            <div className="rounded-2xl border border-white/10 bg-white/[0.055] p-2.5 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
                {/* ① 目标切换（对应参考站顶部 tab） */}
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
                    <button
                        type="button"
                        onClick={togglePanel}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs text-white/55 transition hover:bg-white/[0.06] hover:text-white/85"
                    >
                        Agent
                        <span className="rounded border border-white/15 px-1 text-[9px] leading-4 text-white/40">Beta</span>
                    </button>
                </div>

                {/* ②④⑤⑥⑦ 输入区 + 工具行 */}
                <div className="mt-1.5 rounded-xl bg-black/25 p-2">
                    <textarea
                        value={value}
                        onChange={(event) => handleChange(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === "Enter" && !event.shiftKey) {
                                event.preventDefault();
                                void submit();
                            }
                        }}
                        rows={2}
                        placeholder={t("home.composer.placeholder")}
                        spellCheck={false}
                        className="w-full resize-none bg-transparent px-1.5 py-1 text-[13px] leading-6 text-white outline-none placeholder:text-white/30"
                    />

                    <div className="flex items-center justify-between gap-2 px-0.5">
                        <div className="flex min-w-0 items-center gap-0.5">
                            {/* ④ “+”：上传附件 / 从我的资产选择 */}
                            <Dropdown menu={plusMenu} trigger={["click"]} placement="topLeft">
                                <button
                                    type="button"
                                    aria-label={t("home.composer.addAttachment")}
                                    className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
                                >
                                    <Plus className="size-4" />
                                </button>
                            </Dropdown>

                            {/* ⑤ 选择 Skill（提示词） */}
                            <Tooltip title={t("home.composer.selectSkill")} placement="top" mouseEnterDelay={0.2}>
                                <button
                                    type="button"
                                    onClick={() => setSkillOpen(true)}
                                    aria-label={t("home.composer.selectSkill")}
                                    className="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg text-white/50 transition hover:bg-white/10 hover:text-white"
                                >
                                    <LayoutGrid className="size-4" />
                                </button>
                            </Tooltip>

                            {/* ⑥ 当前模型：点击打开配置 */}
                            <button
                                type="button"
                                onClick={() => openConfigDialog(false, "channels")}
                                title={t("home.composer.selectModel")}
                                className="max-w-[42%] cursor-pointer truncate rounded-lg px-1.5 py-1 text-[11px] text-white/40 transition hover:bg-white/10 hover:text-white/80"
                            >
                                {model || t("home.composer.modelUnset")}
                            </button>
                        </div>

                        {/* ⑦ 发送 */}
                        <button
                            type="button"
                            onClick={() => void submit()}
                            disabled={!canSend}
                            aria-label={t("home.composer.send")}
                            className={cn(
                                "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition",
                                canSend ? "cursor-pointer bg-white text-stone-900 hover:bg-white/90" : "cursor-not-allowed bg-white/15 text-white/40",
                            )}
                        >
                            <ArrowUp className="size-4" />
                        </button>
                    </div>
                </div>
            </div>

            {/* ⑧ 技能 / 灵感胶囊（对应参考站卡片下方那一排） */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 px-1">
                {ideas.map((idea) => (
                    <button
                        key={idea}
                        type="button"
                        onClick={() => setValue(idea)}
                        className="inline-flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/60 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
                    >
                        <Sparkles className="size-3 shrink-0 text-white/40" />
                        {idea}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => navigate("/prompts")}
                    className="inline-flex cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/45 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
                >
                    {t("home.composer.moreSkills")}
                    <span aria-hidden>→</span>
                </button>
            </div>

            <input
                ref={fileRef}
                type="file"
                accept={TEXT_ACCEPT}
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void handleFile(file);
                    event.target.value = "";
                }}
            />

            <PromptSelectDialog open={skillOpen} onOpenChange={setSkillOpen} onSelect={insertPrompt} />
        </div>
    );
}
