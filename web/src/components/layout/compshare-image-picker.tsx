import { useMemo, useState } from "react";
import { Button, Empty, Input, Modal, Select, Spin, Tabs, Tag, Tooltip } from "antd";
import { ExternalLink, Search } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { CompShareImage } from "./compshare-client";

/** 一次最多渲染的卡片数：社区镜像上千张，全量渲染会卡住页面。 */
const RENDER_LIMIT = 240;

/** 平台镜像的三个分区（对齐平台控制台的「基础镜像 / 系统镜像 / 第三方镜像」）。 */
export type PlatformGroup = "base" | "system" | "thirdparty";

/**
 * 基础镜像的框架名 → 图标色调。平台那一排彩色图标（PyTorch 橙 / TensorFlow 橙 /
 * Miniconda3 绿 / ComfyUI 蓝 …）是镜像的识别特征，这里用色调近似，
 * 避免为每个框架单独引图片资源。
 */
const FRAMEWORK_TONES: { match: RegExp; tone: string }[] = [
    { match: /pytorch/i, tone: "#ee4c2c" },
    { match: /tensorflow/i, tone: "#ff6f00" },
    { match: /miniconda|anaconda/i, tone: "#43a047" },
    { match: /cuda/i, tone: "#2e7d32" },
    { match: /comfyui/i, tone: "#0f6cbd" },
    { match: /sd-?webui|stable ?diffusion|automatic1111/i, tone: "#ff7043" },
    { match: /ollama/i, tone: "#111827" },
    { match: /vllm/i, tone: "#2563eb" },
    { match: /sglang/i, tone: "#dc2626" },
    { match: /windows/i, tone: "#0288d1" },
    { match: /ubuntu/i, tone: "#e95420" },
];

/** 从镜像名里抽出可展示的版本（形如 `Ubuntu 22.04 13.0.3-22`、`Ubuntu 22.04`）。 */
export function extractOsVersion(name: string) {
    const matched = /((?:Ubuntu|Windows)\s*[\d.]+(?:\s*[\d.\-A-Za-z]+)?)/i.exec(name);
    return matched ? matched[1].trim() : "";
}

/**
 * 推断平台镜像的分区。
 *
 * 平台接口的 `ImageType` 只有 `System` / `App` 两个枚举，**表达不了控制台那三段**
 * （基础镜像 / 系统镜像 / 第三方镜像），所以只能按「名称 + 标签 + 作者」推断：
 *
 *   · **系统镜像**：Windows-* / Ubuntu-*（纯 OS，不含框架）
 *   · **基础镜像**：PyTorch / TensorFlow / CUDA / ComfyUI / vLLM / Ollama … 这类预装框架
 *   · **第三方镜像**：其余（2026 最新开源镜像、Isaac Sim、Nyupel 等团队自建）
 */
export function platformGroupOf(image: CompShareImage): PlatformGroup {
    const name = image.name;
    // 纯系统镜像：名字以 Windows / Ubuntu 开头，且不含任何框架关键词
    const framework = FRAMEWORK_TONES.some((entry) => entry.match.test(name));
    if (/^(Windows|Ubuntu)/i.test(name) && !framework) return "system";
    if (framework) return "base";
    // 名字里带框架但前缀不是 OS，或作者不是官方 ⇒ 第三方
    if (framework) return "base";
    return "thirdparty";
}

/** 基础镜像的卡片主键：同一框架的不同版本要能各自独立展示（平台上是下拉切换）。 */
function baseKeyOf(image: CompShareImage) {
    return FRAMEWORK_TONES.find((entry) => entry.match.test(image.name))?.match.source || image.name;
}

export function ImagePickerModal({
    open,
    images,
    value,
    communityTotal,
    onPick,
    onSearchRemote,
    searching,
    onClose,
}: {
    open: boolean;
    images: CompShareImage[];
    value: string;
    /** 平台侧的社区镜像总数（可能大于已加载数，因为翻页有上限） */
    communityTotal?: number;
    onPick: (image: CompShareImage) => void;
    /** 本地无结果时，用关键词到平台侧做一次精确检索（作者/名称模糊匹配） */
    onSearchRemote?: (keyword: string) => void;
    searching?: boolean;
    onClose: () => void;
}) {
    const { t } = useTranslation();
    const [keyword, setKeyword] = useState("");
    const [tag, setTag] = useState("");
    /** 基础镜像：每个框架当前选中的版本（key = baseKeyOf） */
    const [baseVariant, setBaseVariant] = useState<Record<string, string>>({});

    const platform = useMemo(() => images.filter((image) => image.source === "platform"), [images]);
    const community = useMemo(() => images.filter((image) => image.source === "community"), [images]);
    const privateImages = useMemo(() => images.filter((image) => image.source === "custom"), [images]);

    /** 搜索 + 分类过滤（三个来源共用，字段口径一致）。 */
    const match = useMemo(() => {
        const kw = keyword.trim().toLowerCase();
        return (image: CompShareImage) => {
            if (tag && !image.tags.includes(tag)) return false;
            if (!kw) return true;
            // 名称、作者、描述、标签、GPU 卡型全部参与匹配 ——
            // 用户既会用镜像名搜，也会用作者名搜
            return `${image.name} ${image.author} ${image.description} ${image.tags.join(" ")} ${image.gpuTypes.join(" ")}`.toLowerCase().includes(kw);
        };
    }, [keyword, tag]);

    const filteredPlatform = useMemo(() => platform.filter(match), [platform, match]);
    const filteredCommunity = useMemo(() => community.filter(match), [community, match]);
    const filteredPrivate = useMemo(() => privateImages.filter(match), [privateImages, match]);

    // 基础镜像：按框架聚合成「一框架一卡 + 版本下拉」（平台就是这样切换版本的）
    const baseGroups = useMemo(() => {
        const map = new Map<string, { key: string; tone: string; label: string; variants: CompShareImage[] }>();
        for (const image of filteredPlatform.filter((item) => platformGroupOf(item) === "base")) {
            const key = baseKeyOf(image);
            const tone = FRAMEWORK_TONES.find((entry) => entry.match.test(image.name))?.tone || "#64748b";
            const label = key.replace(/\\/i, "").replace(/[^A-Za-z一-龥]/g, "") || image.name;
            if (!map.has(key)) map.set(key, { key, tone, label, variants: [] });
            map.get(key)!.variants.push(image);
        }
        return [...map.values()];
    }, [filteredPlatform]);

    const systemImages = useMemo(() => filteredPlatform.filter((item) => platformGroupOf(item) === "system"), [filteredPlatform]);
    const thirdPartyImages = useMemo(() => filteredPlatform.filter((item) => platformGroupOf(item) === "thirdparty"), [filteredPlatform]);

    // 社区镜像的分类胶囊（对齐平台的分类栏）
    const tagBar = useMemo(() => {
        const counter = new Map<string, number>();
        for (const image of community) {
            for (const item of image.tags) counter.set(item, (counter.get(item) || 0) + 1);
        }
        return [...counter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14);
    }, [community]);

    const currentOf = (group: (typeof baseGroups)[number]) => {
        const chosen = baseVariant[group.key];
        return group.variants.find((item) => item.id === chosen) || group.variants[0];
    };

    const remoteHint = Boolean(keyword.trim()) && !filteredCommunity.length && !filteredPlatform.length && !filteredPrivate.length && onSearchRemote;

    const searchBar = (
        <div className="mb-3 flex flex-wrap items-center gap-2">
            <Input
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                allowClear
                prefix={<Search className="size-4 text-stone-400" />}
                placeholder={t("compshare.field.imageSearch")}
                className="max-w-sm"
            />
            <Tooltip title={t("compshare.imagePicker.openSite")}>
                <Button size="small" icon={<ExternalLink className="size-4" />} href="https://www.compshare.cn/image-community" target="_blank" rel="noreferrer">
                    {t("compshare.imagePicker.openSite")}
                </Button>
            </Tooltip>
            {remoteHint ? (
                <Button size="small" type="primary" loading={searching} onClick={() => onSearchRemote?.(keyword.trim())}>
                    {t("compshare.imagePicker.remoteSearch")}
                </Button>
            ) : null}
        </div>
    );

    const platformBody = (
        <div className="space-y-4">
            <Section title={t("compshare.imagePicker.baseImages")} hint={t("compshare.imagePicker.baseHint")}>
                {!baseGroups.length ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("compshare.field.imageEmpty")} /> : null}
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                    {baseGroups.map((group) => {
                        const current = currentOf(group);
                        return (
                            <div
                                key={group.key}
                                className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2 ${
                                    current?.id === value ? "border-emerald-500 ring-1 ring-emerald-500/40" : "border-stone-200 dark:border-stone-800"
                                }`}
                            >
                                <button type="button" onClick={() => current && onPick(current)} className="flex items-center gap-2 text-left">
                                    <span className="flex size-6 shrink-0 items-center justify-center rounded text-[11px] font-bold text-white" style={{ backgroundColor: group.tone }}>
                                        {group.label.slice(0, 2).toUpperCase()}
                                    </span>
                                    <span className="truncate text-xs font-medium text-stone-800 dark:text-stone-100">{current?.name || group.label}</span>
                                </button>
                                {group.variants.length > 1 ? (
                                    <Select
                                        size="small"
                                        value={current?.id}
                                        onChange={(next) => setBaseVariant((prev) => ({ ...prev, [group.key]: next }))}
                                        options={group.variants.map((item) => ({ value: item.id, label: extractOsVersion(item.name) || item.name }))}
                                        optionRender={(option) => <span className="text-[11px]">{option.label}</span>}
                                    />
                                ) : current ? (
                                    <span className="text-[10px] text-stone-400">{extractOsVersion(current.name)}</span>
                                ) : null}
                            </div>
                        );
                    })}
                </div>
            </Section>

            <Section title={t("compshare.imagePicker.systemImages")} hint={t("compshare.imagePicker.systemHint")}>
                <ImageGrid images={systemImages} value={value} onPick={onPick} />
            </Section>

            <Section title={t("compshare.imagePicker.thirdPartyImages")} hint={t("compshare.imagePicker.thirdPartyHint")}>
                <ImageGrid images={thirdPartyImages} value={value} onPick={onPick} />
            </Section>
        </div>
    );

    const communityBody = (
        <div>
            {tagBar.length ? (
                <div className="mb-3 flex flex-wrap gap-1.5">
                    <Tag.CheckableTag checked={!tag} onChange={() => setTag("")}>
                        {t("compshare.imagePicker.allTags")}
                    </Tag.CheckableTag>
                    {tagBar.map(([label, count]) => (
                        <Tag.CheckableTag key={label} checked={tag === label} onChange={() => setTag(tag === label ? "" : label)}>
                            {label} {count}
                        </Tag.CheckableTag>
                    ))}
                </div>
            ) : null}
            {keyword.trim() && !filteredCommunity.length ? (
                <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300">{t("compshare.imagePicker.remoteHint")}</div>
            ) : null}
            <div className="max-h-[52vh] overflow-y-auto pr-1">
                <ImageGrid images={filteredCommunity.slice(0, RENDER_LIMIT)} value={value} onPick={onPick} />
                {filteredCommunity.length > RENDER_LIMIT ? <RenderLimitNote shown={RENDER_LIMIT} total={filteredCommunity.length} /> : null}
            </div>
        </div>
    );

    const privateBody = (
        <div className="max-h-[52vh] overflow-y-auto pr-1">
            <ImageGrid images={filteredPrivate} value={value} onPick={onPick} />
        </div>
    );

    return (
        <Modal
            open={open}
            onCancel={onClose}
            footer={
                <div className="flex items-center justify-between">
                    <span className="text-xs text-stone-500">
                        {t("compshare.imagePicker.count", {
                            shown: filteredPlatform.length + filteredCommunity.length + filteredPrivate.length,
                            total: (communityTotal || images.length) + platform.length + privateImages.length,
                        })}
                    </span>
                    <div className="flex gap-2">
                        <Button onClick={onClose}>{t("compshare.imagePicker.cancel")}</Button>
                        <Button type="primary" onClick={onClose} disabled={!value}>
                            {t("compshare.imagePicker.confirm")}
                        </Button>
                    </div>
                </div>
            }
            width={980}
            title={t("compshare.imagePicker.title", { count: communityTotal || images.length })}
            destroyOnHidden
        >
            {searchBar}
            <Tabs
                defaultActiveKey="platform"
                size="small"
                items={[
                    { key: "platform", label: `${t("compshare.imageTab.platform")}（${filteredPlatform.length}）`, children: platformBody },
                    { key: "community", label: `${t("compshare.imageTab.community")}（${filteredCommunity.length}）`, children: communityBody },
                    { key: "private", label: `${t("compshare.imageTab.private")}（${filteredPrivate.length}）`, children: privateBody },
                ]}
            />
        </Modal>
    );
}

function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
    return (
        <div>
            <div className="mb-1.5">
                <span className="text-xs font-semibold text-stone-700 dark:text-stone-200">{title}</span>
                <span className="ml-2 text-[11px] text-stone-400">{hint}</span>
            </div>
            {children}
        </div>
    );
}

/** 封面卡片网格：平台镜像与社区镜像共用一套视觉（对齐平台镜像社区页）。 */
function ImageGrid({ images, value, onPick }: { images: CompShareImage[]; value: string; onPick: (image: CompShareImage) => void }) {
    const { t } = useTranslation();
    if (!images.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("compshare.field.imageEmpty")} />;
    return (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {images.map((image) => {
                const active = image.id === value;
                return (
                    <button
                        key={image.id}
                        type="button"
                        onClick={() => onPick(image)}
                        title={image.description || image.name}
                        className={`flex flex-col overflow-hidden rounded-lg border text-left transition ${active ? "border-emerald-500 ring-1 ring-emerald-500/40" : "border-stone-200 hover:border-stone-300 hover:bg-stone-50 dark:border-stone-800 dark:hover:bg-stone-800/60"}`}
                    >
                        <div className="relative flex h-20 items-center justify-center overflow-hidden bg-stone-100 dark:bg-stone-800">
                            {image.cover ? (
                                <img src={image.cover} alt={image.name} loading="lazy" className="size-full object-cover" />
                            ) : (
                                <span className="text-base font-semibold text-stone-400 dark:text-stone-600">{image.name.slice(0, 1)}</span>
                            )}
                            {active ? <span className="absolute right-1 top-1 rounded bg-emerald-600 px-1.5 py-0.5 text-[10px] font-medium text-white">{t("compshare.imagePicker.selected")}</span> : null}
                            {image.free ? <span className="absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[10px] text-white">{t("compshare.imagePicker.free")}</span> : null}
                        </div>
                        <div className="flex flex-1 flex-col gap-1 px-2 py-1.5">
                            <span className="line-clamp-2 text-xs font-medium leading-4 text-stone-800 dark:text-stone-100">{image.name}</span>
                            {image.author ? <span className="truncate text-[11px] text-stone-500">{image.author}</span> : null}
                            {image.tags.length ? (
                                <div className="flex flex-wrap gap-1">
                                    {image.tags.slice(0, 2).map((item) => (
                                        <Tag key={item} className="m-0 text-[10px]">
                                            {item}
                                        </Tag>
                                    ))}
                                </div>
                            ) : null}
                        </div>
                    </button>
                );
            })}
        </div>
    );
}

function RenderLimitNote({ shown, total }: { shown: number; total: number }) {
    const { t } = useTranslation();
    return (
        <div className="mt-3 flex items-center justify-center gap-2 text-[11px] text-stone-500">
            <Spin size="small" />
            {t("compshare.imagePicker.renderLimit", { shown, total })}
        </div>
    );
}
