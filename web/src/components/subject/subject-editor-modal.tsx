import { useEffect, useRef, useState } from "react";
import { App, Button, Input, Modal, Segmented, Select, Tooltip } from "antd";
import { ImagePlus, Mic, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { Subject, SubjectCategory } from "@/stores/use-subject-store";

/**
 * 新增 / 编辑主体弹窗（对照参考站的「添加新主体」）。
 *
 * 布局：左侧形象图上传区，右侧「名称 / 类别（角色·场景）/ 标签 / 音色 / 形象来源」。
 * 「AI 生成」形象这一档本地没有接入生成服务，明确置灰并给出说明，不做占位假按钮。
 */

export type SubjectDraft = {
    name: string;
    category: SubjectCategory;
    tags: string[];
    voice?: string;
    image: string;
    note: string;
};

/** 形象图压缩到 256px 的 jpeg dataURL，避免原图撑爆 localStorage。 */
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

export function SubjectEditorModal({ open, initial, onClose, onSubmit }: { open: boolean; initial: Subject | null; onClose: () => void; onSubmit: (draft: SubjectDraft) => void }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [image, setImage] = useState("");
    const [name, setName] = useState("");
    const [category, setCategory] = useState<SubjectCategory>("character");
    const [tags, setTags] = useState<string[]>([]);
    const [voice, setVoice] = useState("");
    const [note, setNote] = useState("");
    const imageRef = useRef<HTMLInputElement>(null);
    const voiceRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        if (!open) return;
        setImage(initial?.image ?? "");
        setName(initial?.name ?? "");
        setCategory(initial?.category ?? "character");
        setTags(initial?.tags ?? []);
        setVoice(initial?.voice ?? "");
        setNote(initial?.note ?? "");
    }, [initial, open]);

    const pickImage = async (file?: File) => {
        if (!file) return;
        try {
            setImage(await fileToCompressedDataUrl(file));
        } catch {
            message.error(t("subject.imageFailed"));
        }
    };

    const submit = () => {
        if (!image) {
            message.warning(t("subject.imageRequired"));
            return;
        }
        if (!name.trim()) {
            message.warning(t("subject.nameRequired"));
            return;
        }
        onSubmit({ name: name.trim(), category, tags, voice: voice || undefined, image, note: note.trim() });
    };

    return (
        <Modal
            title={initial ? t("subject.editTitle") : t("subject.uploadTitle")}
            open={open}
            onCancel={onClose}
            width={860}
            destroyOnHidden
            footer={
                <div className="flex justify-end gap-2">
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={submit}>
                        {t("subject.apply")}
                    </Button>
                </div>
            }
        >
            <div className="grid gap-5 pt-1 sm:grid-cols-[300px_minmax(0,1fr)]">
                {/* 左：形象图上传区 */}
                <button
                    type="button"
                    onClick={() => imageRef.current?.click()}
                    className="flex aspect-[3/4] w-full cursor-pointer flex-col items-center justify-center gap-3 overflow-hidden rounded-xl border border-dashed border-stone-300 bg-stone-100 text-stone-500 transition hover:border-stone-400 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400"
                >
                    {image ? (
                        <img src={image} alt="" className="size-full object-cover" />
                    ) : (
                        <>
                            <ImagePlus className="size-8" />
                            <span className="px-6 text-center text-xs leading-5">{t("subject.imageHint")}</span>
                        </>
                    )}
                </button>

                {/* 右：表单 */}
                <div className="min-h-0 space-y-3 overflow-y-auto pr-1">
                    <div>
                        <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.name")}</div>
                        <Input value={name} onChange={(event) => setName(event.target.value)} maxLength={24} placeholder={t("subject.namePlaceholder")} />
                    </div>

                    <div>
                        <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.category")}</div>
                        <Segmented
                            block
                            value={category}
                            onChange={(value) => setCategory(value as SubjectCategory)}
                            options={[
                                { label: t("subject.categoryCharacter"), value: "character" },
                                { label: t("subject.categoryScene"), value: "scene" },
                            ]}
                        />
                    </div>

                    <div>
                        <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.tags")}</div>
                        <Select mode="tags" className="w-full" value={tags} onChange={setTags} tokenSeparators={[",", "，"]} placeholder={t("subject.tagsPlaceholder")} />
                    </div>

                    <div>
                        <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">
                            {t("subject.voice")}
                            <Tooltip title={t("subject.voiceHint")}>
                                <Mic className="size-3.5 text-stone-400" />
                            </Tooltip>
                        </div>
                        <Button block icon={<Upload className="size-3.5" />} onClick={() => voiceRef.current?.click()}>
                            {voice || t("subject.voiceUpload")}
                        </Button>
                    </div>

                    <div>
                        <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.imageSource")}</div>
                        <Segmented
                            block
                            value="local"
                            options={[
                                { label: t("subject.imageLocal"), value: "local" },
                                {
                                    label: (
                                        <Tooltip title={t("subject.imageAiHint")}>
                                            <span className="text-stone-400">{t("subject.imageAi")}</span>
                                        </Tooltip>
                                    ),
                                    value: "ai",
                                    disabled: true,
                                },
                            ]}
                        />
                    </div>

                    <div>
                        <div className="mb-1.5 text-xs font-medium text-stone-700 dark:text-stone-300">{t("subject.note")}</div>
                        <Input.TextArea rows={3} value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder={t("subject.notePlaceholder")} />
                        <p className="mt-1 text-[11px] leading-5 text-stone-400">{t("subject.noteHint")}</p>
                    </div>
                </div>
            </div>

            <input ref={imageRef} type="file" accept="image/*" className="hidden" onChange={(event) => void pickImage(event.target.files?.[0])} />
            <input
                ref={voiceRef}
                type="file"
                accept="audio/*"
                className="hidden"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) setVoice(file.name);
                    event.target.value = "";
                }}
            />
        </Modal>
    );
}
