import { useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Popover, Select, Tag, Tooltip } from "antd";
import { Pencil, Plus, Search, Star, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { SubjectEditorModal, type SubjectDraft } from "@/components/subject/subject-editor-modal";
import { cn } from "@/lib/utils";
import { PUBLIC_SUBJECTS, publicSubjectList, useSubjectStore, type Subject, type SubjectCategory, type SubjectType } from "@/stores/use-subject-store";

/**
 * 主体库（资产页管理 / 首页选择共用）。
 *
 * 列表对照参考站：顶部「个人添加 / 公共主体」两个 tab，右侧类别筛选与搜索；
 * 卡片是人物图 + 名称 + 星标，公共主体图上左下角叠着三视图（悬停放大）。
 * 点卡片进入详情：左侧大图，右侧类别 / 主体描述 / 三视图 / 「使用主体创作」。
 */

const CARD_ASPECT = "aspect-[203/238]";

function SubjectCard({ subject, active, onOpen, onStar }: { subject: Subject; active: boolean; onOpen: () => void; onStar: () => void }) {
    const { t } = useTranslation();
    const cover = subject.image;

    const turnPopover = subject.turn ? (
        <div className="w-[520px]">
            <img src={subject.turn} alt={t("subject.turnAround")} className="w-full rounded-md" />
            <div className="mt-1.5 text-center text-[11px] text-stone-400">{t("subject.turnAround")}</div>
        </div>
    ) : null;

    return (
        <div className="group relative">
            <button
                type="button"
                onClick={onOpen}
                className={cn(
                    "block w-full cursor-pointer overflow-hidden rounded-xl border bg-stone-100 text-left transition dark:bg-stone-900",
                    active ? "border-stone-900 ring-1 ring-stone-900 dark:border-stone-100 dark:ring-stone-100" : "border-stone-200 hover:border-stone-400 dark:border-stone-700 dark:hover:border-stone-500",
                )}
            >
                <span className="relative block">
                    {cover ? (
                        <img src={cover} alt={subject.name} className={cn(CARD_ASPECT, "w-full object-cover transition duration-300 group-hover:scale-[1.02]")} />
                    ) : (
                        <span className={cn(CARD_ASPECT, "flex w-full items-center justify-center text-2xl text-stone-400")}>{subject.name.slice(0, 1)}</span>
                    )}

                    {/* 三视图：独立叠一层（不烤进卡片图），缩放时始终从超清原图取样，任何 DPR 下都清晰 */}
                    {subject.turn ? (
                        <Popover content={turnPopover} placement="right" mouseEnterDelay={0.25} arrow={false}>
                            <span
                                role="presentation"
                                className="absolute bottom-[4.5%] left-[4.5%] w-[64%] cursor-zoom-in overflow-hidden rounded-md bg-white/95 p-[2px] shadow-[0_2px_10px_rgba(0,0,0,0.22)] ring-1 ring-black/10 transition hover:ring-2 hover:ring-white"
                            >
                                <img src={subject.turn} alt={t("subject.turnAround")} loading="lazy" className="block w-full rounded-[4px]" />
                            </span>
                        </Popover>
                    ) : null}
                </span>

                <div className="flex items-center justify-between gap-1 px-2 py-1.5">
                    <span className="truncate text-xs font-medium text-stone-900 dark:text-stone-100">{subject.name}</span>
                    <span
                        role="button"
                        tabIndex={-1}
                        aria-label={t("subject.star")}
                        onClick={(event) => {
                            event.stopPropagation();
                            onStar();
                        }}
                        className="inline-flex shrink-0 items-center justify-center rounded p-0.5 transition hover:bg-stone-200 dark:hover:bg-stone-800"
                    >
                        <Star className={cn("size-3.5", subject.starred ? "fill-amber-400 text-amber-400" : "text-stone-400")} />
                    </span>
                </div>
            </button>
        </div>
    );
}

export function SubjectBrowser({ mode, onPicked, keyword = "" }: { mode: "manage" | "pick"; onPicked?: (subject: Subject) => void; keyword?: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const personal = useSubjectStore((state) => state.personal);
    const selectedId = useSubjectStore((state) => state.selectedId);
    const addPersonal = useSubjectStore((state) => state.addPersonal);
    const updatePersonal = useSubjectStore((state) => state.updatePersonal);
    const removePersonal = useSubjectStore((state) => state.removePersonal);
    const toggleStar = useSubjectStore((state) => state.toggleStar);
    const select = useSubjectStore((state) => state.select);

    const [type, setType] = useState<SubjectType>("public");
    const [category, setCategory] = useState<SubjectCategory | "all">("all");
    // 页面级搜索框与库内搜索框取并集：任意一个有输入都生效
    const [localKeyword, setLocalKeyword] = useState("");
    const effectiveKeyword = keyword.trim() || localKeyword.trim();
    const [detail, setDetail] = useState<Subject | null>(null);
    const [editorOpen, setEditorOpen] = useState(false);
    const [editing, setEditing] = useState<Subject | null>(null);
    const batchRef = useRef<HTMLInputElement>(null);

    const list = useMemo(() => {
        // 「公共主体」= 系统内置 + 用户主动公开的个人主体
        const source = type === "personal" ? personal : publicSubjectList(personal);
        const key = effectiveKeyword.toLowerCase();
        return source.filter((item) => {
            if (category !== "all" && item.category !== category) return false;
            if (!key) return true;
            return `${item.name} ${item.note} ${(item.tags || []).join(" ")}`.toLowerCase().includes(key);
        });
    }, [category, effectiveKeyword, personal, type]);

    const selected = useMemo(() => personal.find((item) => item.id === selectedId) ?? PUBLIC_SUBJECTS.find((item) => item.id === selectedId) ?? null, [personal, selectedId]);

    const applyDraft = (draft: SubjectDraft) => {
        if (editing) {
            updatePersonal(editing.id, draft);
            setDetail((prev) => (prev && prev.id === editing.id ? { ...prev, ...draft } : prev));
            message.success(t("subject.updated"));
        } else {
            addPersonal({ ...draft, starred: false });
            message.success(t("subject.created"));
        }
        setEditing(null);
        setEditorOpen(false);
    };

    const handleBatch = async (files: FileList | null) => {
        if (!files?.length) return;
        let done = 0;
        for (const file of Array.from(files).slice(0, 20)) {
            if (!file.type.startsWith("image/")) continue;
            try {
                const dataUrl = await new Promise<string>((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => resolve(String(reader.result));
                    reader.onerror = () => reject(new Error("read failed"));
                    reader.readAsDataURL(file);
                });
                if (dataUrl.length > 1_400_000) continue; // 单张过大跳过，避免撑爆 localStorage
                addPersonal({ name: file.name.replace(/\.[^.]+$/, "").slice(0, 24), category: "character", tags: [], image: dataUrl, note: "", starred: false, visibility: "private", voice: undefined });
                done++;
            } catch {
                /* 单张失败跳过 */
            }
        }
        message.success(done ? t("subject.batchDone", { count: done }) : t("subject.batchEmpty"));
    };

    const pick = (subject: Subject) => {
        select(subject.id);
        onPicked?.(subject);
        setDetail(null);
        message.success(t("subject.selected", { name: subject.name }));
    };

    return (
        <div className="w-full">
            {/* 顶栏：分类 tab + 类别筛选 + 搜索 + 上传 */}
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex items-center gap-4">
                    {(["personal", "public"] as SubjectType[]).map((item) => (
                        <button
                            key={item}
                            type="button"
                            onClick={() => setType(item)}
                            className={cn(
                                "cursor-pointer border-b-2 pb-1 text-sm transition",
                                type === item
                                    ? "border-stone-900 font-medium text-stone-900 dark:border-stone-100 dark:text-stone-100"
                                    : "border-transparent text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200",
                            )}
                        >
                            {item === "personal" ? t("subject.personalAdd") : t("subject.publicSubjects")}
                        </button>
                    ))}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Select
                        size="small"
                        value={category}
                        onChange={setCategory}
                        className="min-w-[96px]"
                        options={[
                            { label: t("subject.categoryAll"), value: "all" },
                            { label: t("subject.categoryCharacter"), value: "character" },
                            { label: t("subject.categoryScene"), value: "scene" },
                        ]}
                    />
                    <Input
                        size="small"
                        allowClear
                        value={localKeyword}
                        onChange={(event) => setLocalKeyword(event.target.value)}
                        placeholder={t("subject.searchPlaceholder")}
                        prefix={<Search className="size-3.5 text-stone-400" />}
                        className="w-[200px]"
                    />
                    {mode === "manage" ? (
                        <>
                            <Button size="small" icon={<Upload className="size-3.5" />} onClick={() => batchRef.current?.click()}>
                                {t("subject.batchUpload")}
                            </Button>
                            <Button
                                size="small"
                                type="primary"
                                icon={<Plus className="size-3.5" />}
                                onClick={() => {
                                    setType("personal");
                                    setEditing(null);
                                    setEditorOpen(true);
                                }}
                            >
                                {t("subject.upload")}
                            </Button>
                        </>
                    ) : null}
                </div>
            </div>

            {selected ? (
                <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                    {t("subject.current", { name: selected.name })} · {selected.note || t("subject.noNote")}
                </div>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6">
                {list.map((subject) => (
                    <SubjectCard
                        key={subject.id}
                        subject={subject}
                        active={subject.id === selectedId}
                        onOpen={() => setDetail(subject)}
                        onStar={() => {
                            if (subject.type === "personal") toggleStar(subject.id);
                            else message.info(t("subject.starPublicHint"));
                        }}
                    />
                ))}
            </div>

            {!list.length ? (
                <div className="py-16 text-center text-xs text-stone-400 dark:text-stone-500">{type === "personal" ? t("subject.personalEmpty") : t("subject.publicEmpty")}</div>
            ) : null}

            {/* 详情：左大图 + 右信息（对照参考站） */}
            <Modal open={Boolean(detail)} onCancel={() => setDetail(null)} footer={null} width={980} destroyOnHidden className="subject-detail-modal" closeIcon={false}>
                {detail ? (
                    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
                        <div className="flex items-center justify-center overflow-hidden rounded-xl bg-stone-100 dark:bg-stone-900">
                            {/* 不拉满容器：源图分辨率有限，过度放大会更糊 */}
                            <img src={detail.hero || detail.image} alt={detail.name} className="max-h-[460px] w-auto max-w-full object-contain" />
                        </div>

                        <div className="flex min-h-0 flex-col">
                            <div className="flex items-start justify-between gap-3">
                                <h3 className="text-base font-semibold text-stone-900 dark:text-stone-100">{detail.name}</h3>
                                {detail.type === "personal" && detail.visibility === "public" ? <Tag className="m-0 text-[10px]">{t("subject.visibilityPublic")}</Tag> : null}
                                <div className="flex items-center gap-1">
                                    <Tooltip title={t("subject.star")}>
                                        <button
                                            type="button"
                                            onClick={() => (detail.type === "personal" ? toggleStar(detail.id) : message.info(t("subject.starPublicHint")))}
                                            className="cursor-pointer rounded p-1 transition hover:bg-stone-100 dark:hover:bg-stone-800"
                                        >
                                            <Star className={cn("size-4", detail.starred ? "fill-amber-400 text-amber-400" : "text-stone-400")} />
                                        </button>
                                    </Tooltip>
                                    <button
                                        type="button"
                                        onClick={() => setDetail(null)}
                                        aria-label={t("common.close")}
                                        className="cursor-pointer rounded p-1 text-stone-400 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-stone-800"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>

                            <div className="mt-3 flex items-center justify-between gap-2 text-xs">
                                <span className="text-stone-500 dark:text-stone-400">{t("subject.category")}</span>
                                <span className="text-stone-800 dark:text-stone-200">{detail.category === "scene" ? t("subject.categoryScene") : t("subject.categoryCharacter")}</span>
                            </div>

                            <div className="mt-4">
                                <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.description")}</div>
                                <p className="text-xs leading-6 text-stone-600 dark:text-stone-300">{detail.note || t("subject.noNote")}</p>
                                <p className="mt-1.5 text-[11px] text-stone-400">{detail.type === "public" ? t("subject.aiGenerated") : t("subject.userProvided")}</p>
                            </div>

                            <div className="mt-4">
                                <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.turnAround")}</div>
                                {detail.turn ? (
                                    <Popover content={<img src={detail.turn} alt="" className="w-[720px] rounded-md" />} placement="left" mouseEnterDelay={0.2} arrow={false}>
                                        <img src={detail.turn} alt={t("subject.turnAround")} className="w-full cursor-zoom-in rounded-lg bg-stone-100 transition hover:opacity-90 dark:bg-stone-900" />
                                    </Popover>
                                ) : (
                                    <div className="rounded-lg border border-dashed border-stone-200 px-3 py-6 text-center text-[11px] text-stone-400 dark:border-stone-700">{t("subject.noTurnAround")}</div>
                                )}
                            </div>

                            {detail.tags?.length ? (
                                <div className="mt-4 flex flex-wrap gap-1.5">
                                    {detail.tags.map((tag) => (
                                        <Tag key={tag} className="m-0 text-[11px]">
                                            {tag}
                                        </Tag>
                                    ))}
                                </div>
                            ) : null}

                            <div className="mt-auto flex items-center gap-2 pt-6">
                                <Button type="primary" block onClick={() => pick(detail)}>
                                    ✦ {t("subject.useToCreate")}
                                </Button>
                                {detail.type === "personal" && mode === "manage" ? (
                                    <>
                                        <Button
                                            icon={<Pencil className="size-3.5" />}
                                            onClick={() => {
                                                setEditing(detail);
                                                setEditorOpen(true);
                                            }}
                                        >
                                            {t("common.edit")}
                                        </Button>
                                        <Button
                                            danger
                                            icon={<Trash2 className="size-3.5" />}
                                            aria-label={t("common.delete")}
                                            onClick={() => {
                                                removePersonal(detail.id);
                                                setDetail(null);
                                            }}
                                        />
                                    </>
                                ) : null}
                            </div>
                        </div>
                    </div>
                ) : null}
            </Modal>

            <SubjectEditorModal
                open={editorOpen}
                initial={editing}
                onClose={() => {
                    setEditorOpen(false);
                    setEditing(null);
                }}
                onSubmit={applyDraft}
            />

            <input
                ref={batchRef}
                type="file"
                accept="image/*"
                multiple
                className="hidden"
                onChange={(event) => {
                    void handleBatch(event.target.files);
                    event.target.value = "";
                }}
            />
        </div>
    );
}
