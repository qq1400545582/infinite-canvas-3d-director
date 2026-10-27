import { useMemo, useState } from "react";
import { Input, Modal } from "antd";
import { ArrowUpRight, Search } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";

import { useLibraryItems } from "@/pages/expert-library/use-expert-library";
import { cn } from "@/lib/utils";

/**
 * 首页「更多 技能」打开的专家 / 技能选择器。
 *
 * 数据直接复用专家库的 `useLibraryItems("expert")`（内置目录 + 我的专家 + 已装技能），
 * 只读、不写任何状态，所以不会影响专家库页面本身。
 * 选中后把 `@名称` 写进首页输入框，实现「选中即可在输入框内调用」。
 */

const LIMIT = 60;

export function HomeSkillPicker({ open, onOpenChange, onSelect }: { open: boolean; onOpenChange: (open: boolean) => void; onSelect: (name: string) => void }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const items = useLibraryItems("expert");
    const [keyword, setKeyword] = useState("");

    const filtered = useMemo(() => {
        const key = keyword.trim().toLowerCase();
        const list = key
            ? items.filter((item) => [item.name, item.profession, item.description, ...(item.tags || [])].filter(Boolean).join(" ").toLowerCase().includes(key))
            : items;
        return list.slice(0, LIMIT);
    }, [items, keyword]);

    return (
        <Modal
            title={t("home.composer.skillPickerTitle")}
            open={open}
            onCancel={() => onOpenChange(false)}
            footer={null}
            width={760}
            centered
            destroyOnHidden
            styles={{ body: { paddingTop: 8 } }}
        >
            <Input
                allowClear
                value={keyword}
                onChange={(event) => setKeyword(event.target.value)}
                placeholder={t("home.composer.skillPickerSearch")}
                prefix={<Search className="size-4 text-stone-400" />}
                className="mb-3"
            />

            <div className="thin-scrollbar grid max-h-[52dvh] min-h-0 grid-cols-1 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                {filtered.map((item) => (
                    <button
                        key={item.id}
                        type="button"
                        onClick={() => {
                            onSelect(item.name);
                            onOpenChange(false);
                        }}
                        className={cn(
                            "flex cursor-pointer items-start gap-2.5 rounded-lg border border-stone-200 p-2.5 text-left transition",
                            "hover:border-stone-400 hover:bg-stone-50 dark:border-stone-700 dark:hover:border-stone-500 dark:hover:bg-stone-800/60",
                        )}
                    >
                        {item.avatar ? (
                            <img src={item.avatar} alt={item.name} className="size-8 shrink-0 rounded-full object-cover" />
                        ) : (
                            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-stone-100 text-xs font-medium text-stone-500 dark:bg-stone-800 dark:text-stone-300">
                                {item.name.slice(0, 1)}
                            </span>
                        )}
                        <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-medium text-stone-900 dark:text-stone-100">{item.profession || item.name}</span>
                            <span className="mt-0.5 block truncate text-[11px] text-stone-500 dark:text-stone-400">{item.name}</span>
                            {item.description ? <span className="mt-1 line-clamp-2 block text-[11px] leading-4 text-stone-400 dark:text-stone-500">{item.description}</span> : null}
                        </span>
                    </button>
                ))}
                {filtered.length === 0 ? <div className="col-span-full py-10 text-center text-xs text-stone-400">{t("home.composer.skillPickerEmpty")}</div> : null}
            </div>

            <div className="mt-3 flex items-center justify-between border-t border-stone-200 pt-2.5 dark:border-stone-800">
                <span className="text-[11px] text-stone-400 dark:text-stone-500">{t("home.composer.skillPickerHint")}</span>
                <button
                    type="button"
                    onClick={() => {
                        onOpenChange(false);
                        navigate("/experts");
                    }}
                    className="inline-flex cursor-pointer items-center gap-1 text-[11px] text-stone-500 transition hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                >
                    {t("home.composer.openExpertLibrary")}
                    <ArrowUpRight className="size-3" />
                </button>
            </div>
        </Modal>
    );
}
