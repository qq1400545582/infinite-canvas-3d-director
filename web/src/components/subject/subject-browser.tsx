import { useMemo, useRef, useState } from "react";
import { App, Button, Input, Modal, Tag } from "antd";
import { Plus, Trash2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import { PUBLIC_SUBJECTS, useSubjectStore, type Subject, type SubjectType } from "@/stores/use-subject-store";

/**
 * 主体库浏览 / 选择组件（资产页与首页共用）。
 *
 * - `mode="manage"`：资产页用，支持上传个人主体、删除个人主体。
 * - `mode="pick"`：首页用，点卡片即选定并回调；不做增删。
 *
 * 选定结果写入 subject store 的 `selectedId`（localStorage 持久化），
 * 因此同一主体的描述会在后续任务中保持不变——这就是「前后一致性」的落点。
 */

/** 上传图压缩到 256px 的 jpeg dataURL，避免把原图塞进 localStorage。 */
function fileToCompressedDataUrl(file: File, max = 256): Promise<string> {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            try {
                const scale = Math.min(1, max / Math.max(img.width, img.height));
                const canvas = document.createElement("canvas");
                canvas.width = Math.max(1, Math.round(img.width * scale));
                canvas.height = Math.max(1, Math.round(img.height * scale));
                const ctx = canvas.getContext("2d");
                if (!ctx) throw new Error("canvas unavailable");
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL("image/jpeg", 0.82));
            } catch (error) {
                reject(error as Error);
            } finally {
                URL.revokeObjectURL(url);
            }
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            reject(new Error("image load failed"));
        };
        img.src = url;
    });
}

function SubjectAvatar({ subject }: { subject: Subject }) {
    if (subject.image) return <img src={subject.image} alt={subject.name} className="aspect-square w-full object-cover" />;
    // 公共主体没有形象素材：用名字首字 + 稳定色相，避免空白卡
    const hue = [...subject.name].reduce((acc, char) => acc + char.charCodeAt(0), 0) % 360;
    return (
        <div className="flex aspect-square w-full items-center justify-center text-2xl font-medium text-white/95" style={{ background: `linear-gradient(140deg, hsl(${hue} 42% 34%), hsl(${(hue + 40) % 360} 46% 52%))` }}>
            {subject.name.slice(0, 1)}
        </div>
    );
}

export function SubjectBrowser({ mode, onPicked, keyword = "" }: { mode: "manage" | "pick"; onPicked?: (subject: Subject) => void; keyword?: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const personal = useSubjectStore((state) => state.personal);
    const selectedId = useSubjectStore((state) => state.selectedId);
    const addPersonal = useSubjectStore((state) => state.addPersonal);
    const removePersonal = useSubjectStore((state) => state.removePersonal);
    const select = useSubjectStore((state) => state.select);

    const [type, setType] = useState<SubjectType>("personal");
    const [createOpen, setCreateOpen] = useState(false);
    const [draftImage, setDraftImage] = useState("");
    const [draftName, setDraftName] = useState("");
    const [draftNote, setDraftNote] = useState("");
    const fileRef = useRef<HTMLInputElement>(null);

    const list = useMemo(() => {
        const source = type === "personal" ? personal : PUBLIC_SUBJECTS;
        const key = keyword.trim().toLowerCase();
        if (!key) return source;
        return source.filter((item) => `${item.name} ${item.note}`.toLowerCase().includes(key));
    }, [keyword, personal, type]);

    const selected = useMemo(
        () => personal.find((item) => item.id === selectedId) ?? PUBLIC_SUBJECTS.find((item) => item.id === selectedId) ?? null,
        [personal, selectedId],
    );

    const pick = (subject: Subject) => {
        select(subject.id);
        onPicked?.(subject);
        message.success(t("subject.selected", { name: subject.name }));
    };

    const handleFile = async (file?: File) => {
        if (!file) return;
        try {
            const dataUrl = await fileToCompressedDataUrl(file);
            setDraftImage(dataUrl);
        } catch {
            message.error(t("subject.imageFailed"));
        }
    };

    const saveDraft = () => {
        if (!draftImage) {
            message.warning(t("subject.imageRequired"));
            return;
        }
        if (!draftName.trim()) {
            message.warning(t("subject.nameRequired"));
            return;
        }
        addPersonal({ name: draftName, note: draftNote, image: draftImage });
        setCreateOpen(false);
        setDraftImage("");
        setDraftName("");
        setDraftNote("");
        message.success(t("subject.created"));
    };

    return (
        <div className="w-full">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <div className="flex flex-wrap gap-2">
                    {(["personal", "public"] as SubjectType[]).map((item) => (
                        <Tag.CheckableTag key={item} checked={type === item} className={cn("prompt-filter-tag", type === item && "is-active")} onChange={() => setType(item)}>
                            {item === "personal" ? t("subject.personal") : t("subject.public")}
                        </Tag.CheckableTag>
                    ))}
                </div>
                {mode === "manage" && type === "personal" ? (
                    <Button size="small" icon={<Plus className="size-3.5" />} onClick={() => setCreateOpen(true)}>
                        {t("subject.upload")}
                    </Button>
                ) : null}
            </div>

            {selected ? (
                <div className="mt-3 rounded-lg border border-stone-200 bg-stone-50 px-3 py-2 text-xs text-stone-600 dark:border-stone-800 dark:bg-stone-900 dark:text-stone-300">
                    {t("subject.current", { name: selected.name })} · {selected.note}
                </div>
            ) : null}

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {list.map((subject) => {
                    const active = subject.id === selectedId;
                    return (
                        <div
                            key={subject.id}
                            className={cn(
                                "group relative overflow-hidden rounded-xl border bg-white text-left transition dark:bg-stone-900",
                                active ? "border-stone-900 ring-1 ring-stone-900 dark:border-stone-100 dark:ring-stone-100" : "border-stone-200 hover:border-stone-400 dark:border-stone-700 dark:hover:border-stone-500",
                            )}
                        >
                            <button type="button" className="block w-full cursor-pointer" onClick={() => pick(subject)}>
                                <SubjectAvatar subject={subject} />
                                <div className="px-2.5 py-2">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate text-xs font-medium text-stone-900 dark:text-stone-100">{subject.name}</span>
                                        {active ? <span className="shrink-0 rounded bg-stone-900 px-1 text-[9px] leading-4 text-white dark:bg-stone-100 dark:text-stone-900">{t("subject.inUse")}</span> : null}
                                    </div>
                                    <p className="mt-1 line-clamp-2 text-[11px] leading-4 text-stone-500 dark:text-stone-400">{subject.note}</p>
                                </div>
                            </button>
                            {mode === "manage" && subject.type === "personal" ? (
                                <button
                                    type="button"
                                    onClick={() => removePersonal(subject.id)}
                                    aria-label={t("common.delete")}
                                    className="absolute right-1.5 top-1.5 hidden size-6 cursor-pointer items-center justify-center rounded-md bg-black/55 text-white transition hover:bg-black/75 group-hover:flex"
                                >
                                    <Trash2 className="size-3.5" />
                                </button>
                            ) : null}
                        </div>
                    );
                })}
            </div>

            {!list.length ? (
                <div className="py-14 text-center text-xs text-stone-400 dark:text-stone-500">{type === "personal" ? t("subject.personalEmpty") : t("subject.publicEmpty")}</div>
            ) : null}

            <Modal title={t("subject.uploadTitle")} open={createOpen} onCancel={() => setCreateOpen(false)} onOk={saveDraft} okText={t("common.save")} cancelText={t("common.cancel")} destroyOnHidden>
                <div className="flex flex-col gap-3 pt-1">
                    <div className="flex items-center gap-3">
                        <div className="size-20 shrink-0 overflow-hidden rounded-lg border border-dashed border-stone-300 dark:border-stone-700">
                            {draftImage ? <img src={draftImage} alt="" className="size-full object-cover" /> : null}
                        </div>
                        <Button icon={<Upload className="size-4" />} onClick={() => fileRef.current?.click()}>
                            {t("subject.pickImage")}
                        </Button>
                    </div>
                    <Input placeholder={t("subject.namePlaceholder")} value={draftName} onChange={(event) => setDraftName(event.target.value)} maxLength={24} />
                    <Input.TextArea rows={3} placeholder={t("subject.notePlaceholder")} value={draftNote} onChange={(event) => setDraftNote(event.target.value)} maxLength={160} />
                    <p className="text-[11px] leading-5 text-stone-400">{t("subject.noteHint")}</p>
                </div>
                <input
                    ref={fileRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(event) => {
                        void handleFile(event.target.files?.[0]);
                        event.target.value = "";
                    }}
                />
            </Modal>
        </div>
    );
}
