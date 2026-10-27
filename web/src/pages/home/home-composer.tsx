import { useCallback, useMemo, useRef, useState } from "react";
import { App, Dropdown, Popover, Switch, Tooltip } from "antd";
import { ArrowUp, AtSign, Clapperboard, LayoutGrid, Palette, Plus } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { AssetPickerModal } from "@/components/canvas/asset-picker-modal";
import { PromptSelectDialog } from "@/components/prompts/prompt-select-dialog";
import { HomeSkillPicker } from "@/pages/home/home-skill-picker";
import { navigationTools } from "@/constant/navigation-tools";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import { useConfigStore } from "@/stores/use-config-store";

/**
 * 首页灵感输入框（对齐参考站 composer 的入口与交互）。
 *
 * 入口一览（全部接真实能力）：
 *   ① tab：我的画布 / 生图工作台 / 视频创作台 / 短剧工作室，决定发送去哪；Agent 打开右侧面板
 *   ② 输入区：placeholder 用「输入“/”+ 提示词名称可引用」
 *   ③ 输入 “/”：打开提示词选择器并插入
 *   ④ “+”：上传附件（文本文件）/ 从我的资产选择
 *   ⑤ 四宫格：提示词选择器（选择 Skill）
 *   ⑥ 模型名：当前工作台默认模型，点击开配置
 *   ⑦ 风格库：点选风格词追加到提示词
 *   ⑧ 多集：开启后以「多集连载」方式新建画布（/canvas?mode=new）
 *   ⑨ @ 主体资产：从我的资产挑文本素材插入
 *   ⑩ 发送：复制提示词并跳转
 *   ⑪ 胶囊 + 更多技能：更多技能打开专家/技能选择器，选中即把 @名称 写进输入框
 */

const TARGETS = [
    { slug: "canvas", modelKey: "textModel", to: "/canvas" },
    { slug: "image", modelKey: "imageModel", to: "/image" },
    { slug: "video", modelKey: "videoModel", to: "/video" },
    { slug: "drama", modelKey: "textModel", to: "/canvas?mode=new" },
] as const;

type TargetSlug = (typeof TARGETS)[number]["slug"];

/** 多集连载：走画布新建（分集更适合在画布上铺开），没有独立路由。 */
const MULTI_TO = "/canvas?mode=new";

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
    const [expertOpen, setExpertOpen] = useState(false);
    const [assetOpen, setAssetOpen] = useState(false);
    const [multiEpisode, setMultiEpisode] = useState(false);
    const fileRef = useRef<HTMLInputElement>(null);
    const textModel = useConfigStore((state) => state.config.textModel);
    const imageModel = useConfigStore((state) => state.config.imageModel);
    const videoModel = useConfigStore((state) => state.config.videoModel);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const togglePanel = useAgentStore((state) => state.togglePanel);

    const model = useMemo(() => {
        const map: Record<TargetSlug, string> = { canvas: textModel, image: imageModel, video: videoModel, drama: textModel };
        return modelLabel(map[target] || "");
    }, [imageModel, target, textModel, videoModel]);

    const ideas = useMemo(() => [t("home.composer.idea1"), t("home.composer.idea2"), t("home.composer.idea3"), t("home.composer.idea4")], [t]);
    const styles = useMemo(() => t("home.composer.styleList").split(",").map((item) => item.trim()).filter(Boolean), [t]);
    const canSend = Boolean(value.trim());

    const append = useCallback((text: string) => {
        setValue((prev) => (prev ? `${prev}${/[，,、\s]$/.test(prev) ? "" : "，"}${text}` : text));
    }, []);

    const submit = useCallback(async () => {
        const text = value.trim();
        if (!text) return;
        const destination = multiEpisode ? MULTI_TO : TARGETS.find((item) => item.slug === target)!.to;
        // 非安全上下文（局域网 IP 访问）下 clipboard 不可用 → 静默跳过，不阻断跳转。
        try {
            await navigator.clipboard.writeText(text);
            message.success(t("home.composer.copied"));
        } catch {
            /* 无剪贴板权限时只做跳转 */
        }
        navigate(destination);
    }, [message, multiEpisode, navigate, t, target, value]);

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

    /** 选中专家/技能 → 以 `@名称` 的形式写进输入框，可在提示词里直接引用。 */
    const insertExpert = useCallback((name: string) => {
        setValue((prev) => (prev ? `${prev}${/\s$/.test(prev) ? "" : " "}@${name}` : `@${name}`));
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

    const styleContent = (
        <div className="grid max-w-[220px] grid-cols-2 gap-1">
            {styles.map((style) => (
                <button
                    key={style}
                    type="button"
                    onClick={() => append(style)}
                    className="cursor-pointer rounded-md px-2 py-1 text-left text-xs text-stone-600 transition hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800"
                >
                    {style}
                </button>
            ))}
        </div>
    );

    return (
        <div className="w-full">
            <div className="rounded-2xl border border-white/10 bg-white/[0.055] p-2.5 shadow-[0_30px_90px_-30px_rgba(0,0,0,0.95)] backdrop-blur-2xl">
                {/* ① 目标切换 + Agent */}
                <div className="hide-scrollbar flex items-center gap-1 overflow-x-auto px-0.5">
                    {TARGETS.map((item) => {
                        const active = item.slug === target;
                        const Icon = item.slug === "drama" ? Clapperboard : navigationTools.find((entry) => entry.slug === item.slug)?.icon;
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
                                {item.slug === "drama" ? t("home.composer.drama") : t(`navigation.${item.slug}`)}
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

                {/* ② 输入区 */}
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

                    <div className="flex flex-wrap items-center justify-between gap-2 px-0.5">
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
                                className="max-w-[38%] cursor-pointer truncate rounded-lg px-1.5 py-1 text-[11px] text-white/40 transition hover:bg-white/10 hover:text-white/80"
                            >
                                {model || t("home.composer.modelUnset")}
                            </button>
                        </div>

                        <div className="flex shrink-0 items-center gap-1.5">
                            {/* ⑦ 风格库 */}
                            <Popover content={styleContent} trigger="click" placement="topRight">
                                <button
                                    type="button"
                                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white"
                                >
                                    <Palette className="size-3.5" />
                                    {t("home.composer.styleLibrary")}
                                </button>
                            </Popover>

                            {/* ⑧ 多集 */}
                            <Tooltip title={t("home.composer.multiEpisodeHint")} placement="top" mouseEnterDelay={0.2}>
                                <label className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-1 py-1 text-[11px] text-white/50 transition hover:text-white/80">
                                    <Switch size="small" checked={multiEpisode} onChange={setMultiEpisode} aria-label={t("home.composer.multiEpisode")} />
                                    {t("home.composer.multiEpisode")}
                                </label>
                            </Tooltip>

                            {/* ⑨ @ 主体资产 */}
                            <Tooltip title={t("home.composer.subjectAssetHint")} placement="top" mouseEnterDelay={0.2}>
                                <button
                                    type="button"
                                    onClick={() => setAssetOpen(true)}
                                    className="inline-flex cursor-pointer items-center gap-1 rounded-lg px-1.5 py-1 text-[11px] text-white/50 transition hover:bg-white/10 hover:text-white"
                                >
                                    <AtSign className="size-3.5" />
                                    {t("home.composer.subjectAsset")}
                                </button>
                            </Tooltip>

                            {/* ⑩ 发送 */}
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
            </div>

            {/* ⑪ 技能 / 灵感胶囊 */}
            <div className="mt-3 flex flex-wrap items-center justify-center gap-1.5 px-1">
                {ideas.map((idea) => (
                    <button
                        key={idea}
                        type="button"
                        onClick={() => setValue(idea)}
                        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/60 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
                    >
                        <span className="size-1 shrink-0 rounded-full bg-white/30" />
                        {idea}
                    </button>
                ))}
                <button
                    type="button"
                    onClick={() => setExpertOpen(true)}
                    className="inline-flex shrink-0 cursor-pointer items-center gap-1 whitespace-nowrap rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/45 transition hover:border-white/20 hover:bg-white/10 hover:text-white"
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

            <HomeSkillPicker open={expertOpen} onOpenChange={setExpertOpen} onSelect={insertExpert} />

            <AssetPickerModal
                open={assetOpen}
                onClose={() => setAssetOpen(false)}
                onInsert={(payload) => {
                    setAssetOpen(false);
                    if (payload.kind === "text") {
                        setValue((prev) => (prev ? `${prev}\n${payload.content}` : payload.content));
                        return;
                    }
                    // 首页没有参考图挂载点：如实告知，而不是静默失败。
                    message.info(t("home.composer.assetMediaUnsupported"));
                }}
            />
        </div>
    );
}
