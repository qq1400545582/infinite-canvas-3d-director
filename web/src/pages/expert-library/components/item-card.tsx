import { Zap } from "lucide-react";
import { Button, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { resolveIcon } from "./icon-map";
import { cn } from "@/lib/utils";
import type { LibraryItem, LibraryKind } from "../data/types";

const ACCENT: Record<LibraryKind, { bg: string; text: string }> = {
    expert: { bg: "bg-violet-100 dark:bg-violet-500/15", text: "text-violet-600 dark:text-violet-300" },
    skill: { bg: "bg-emerald-100 dark:bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-300" },
    connector: { bg: "bg-sky-100 dark:bg-sky-500/15", text: "text-sky-600 dark:text-sky-300" },
};

export function ItemCard({
    item,
    onOpen,
    onInvoke,
}: {
    item: LibraryItem;
    onOpen: (item: LibraryItem) => void;
    onInvoke: (item: LibraryItem) => void;
}) {
    const { t } = useTranslation();
    const Icon = resolveIcon(item.icon);
    const accent = ACCENT[item.kind];
    return (
        <div className="group flex h-full flex-col overflow-hidden rounded-xl border border-stone-200 bg-white transition duration-200 hover:-translate-y-0.5 hover:shadow-lg dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-center gap-3 px-4 pt-4">
                <span className={cn("grid size-11 shrink-0 place-items-center rounded-xl", accent.bg, accent.text)}>
                    <Icon className="size-5" />
                </span>
                <div className="min-w-0">
                    <h3 className="truncate text-sm font-semibold text-stone-950 dark:text-stone-100">{item.name}</h3>
                    <span className="text-xs text-stone-400 dark:text-stone-500">{item.category}</span>
                </div>
            </div>
            <p className="mt-3 line-clamp-2 px-4 text-xs leading-5 text-stone-600 dark:text-stone-400">{item.description}</p>
            <div className="mt-3 flex flex-wrap gap-1.5 px-4">
                {item.tags.slice(0, 3).map((tag) => (
                    <Tag key={tag} className="m-0 text-[11px]">
                        {tag}
                    </Tag>
                ))}
            </div>
            <div className="mt-auto flex items-center gap-2 px-4 py-4">
                <Button type="text" size="small" onClick={() => onOpen(item)}>
                    {t("expertLibrary.detail")}
                </Button>
                <Button type="primary" size="small" icon={<Zap className="size-3.5" />} onClick={() => onInvoke(item)} className="ml-auto">
                    {t("expertLibrary.invoke")}
                </Button>
            </div>
        </div>
    );
}
