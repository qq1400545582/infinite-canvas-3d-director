import { Check, Copy, Zap } from "lucide-react";
import { Button, Drawer, Tag } from "antd";
import { useTranslation } from "react-i18next";

import { resolveIcon } from "./icon-map";
import { useCopyText } from "@/hooks/use-copy-text";
import { cn } from "@/lib/utils";
import { useAgentStore } from "@/stores/use-agent-store";
import type { LibraryItem, LibraryKind } from "../data/types";

const ACCENT: Record<LibraryKind, { bg: string; text: string }> = {
    expert: { bg: "bg-violet-100 dark:bg-violet-500/15", text: "text-violet-600 dark:text-violet-300" },
    skill: { bg: "bg-emerald-100 dark:bg-emerald-500/15", text: "text-emerald-600 dark:text-emerald-300" },
    connector: { bg: "bg-sky-100 dark:bg-sky-500/15", text: "text-sky-600 dark:text-sky-300" },
};

export function DetailDrawer({
    item,
    open,
    onClose,
    onInvoke,
}: {
    item: LibraryItem | null;
    open: boolean;
    onClose: () => void;
    onInvoke: (item: LibraryItem) => void;
}) {
    const { t } = useTranslation();
    const copyText = useCopyText();
    const connected = useAgentStore((state) => state.connected);
    const Icon = item ? resolveIcon(item.icon) : null;
    const accent = item ? ACCENT[item.kind] : ACCENT.expert;
    const metaEntries = item?.meta ? Object.entries(item.meta) : [];

    return (
        <Drawer
            title={null}
            placement="right"
            width={480}
            open={open && Boolean(item)}
            onClose={onClose}
            rootClassName="expert-library-drawer"
            styles={{ body: { padding: 0 } }}
        >
            {item ? (
                <div className="flex h-full flex-col">
                    <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-5 py-5">
                        <div className="flex items-center gap-3">
                            <span className={cn("grid size-12 shrink-0 place-items-center rounded-xl", accent.bg, accent.text)}>
                                {Icon ? <Icon className="size-6" /> : null}
                            </span>
                            <div className="min-w-0">
                                <h2 className="truncate text-base font-semibold text-stone-950 dark:text-stone-100">{item.name}</h2>
                                <Tag className="mt-1">{item.category}</Tag>
                            </div>
                        </div>

                        <p className="mt-4 text-sm leading-6 text-stone-600 dark:text-stone-400">{item.description}</p>

                        {item.features.length ? (
                            <section className="mt-5">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">
                                    {t("expertLibrary.features")}
                                </div>
                                <ul className="space-y-2">
                                    {item.features.map((feature) => (
                                        <li key={feature} className="flex items-start gap-2 text-sm text-stone-700 dark:text-stone-300">
                                            <Check className="mt-0.5 size-4 shrink-0 text-emerald-500" />
                                            <span>{feature}</span>
                                        </li>
                                    ))}
                                </ul>
                            </section>
                        ) : null}

                        {item.tags.length ? (
                            <section className="mt-5">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">
                                    {t("expertLibrary.tags")}
                                </div>
                                <div className="flex flex-wrap gap-1.5">
                                    {item.tags.map((tag) => (
                                        <Tag key={tag} className="m-0 text-[11px]">
                                            {tag}
                                        </Tag>
                                    ))}
                                </div>
                            </section>
                        ) : null}

                        {metaEntries.length ? (
                            <section className="mt-5">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">
                                    {t("expertLibrary.meta")}
                                </div>
                                <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                                    {metaEntries.map(([key, value]) => (
                                        <div key={key} className="contents">
                                            <dt className="text-stone-400 dark:text-stone-500">{key}</dt>
                                            <dd className="text-stone-700 dark:text-stone-300">{value}</dd>
                                        </div>
                                    ))}
                                </dl>
                            </section>
                        ) : null}

                        <section className="mt-5">
                            <div className="mb-2 flex items-center justify-between">
                                <span className="text-xs font-semibold uppercase tracking-widest text-stone-400 dark:text-stone-500">
                                    {t("expertLibrary.callPrompt")}
                                </span>
                                <Button
                                    type="text"
                                    size="small"
                                    icon={<Copy className="size-3.5" />}
                                    onClick={() => copyText(item.callPrompt, t("expertLibrary.promptCopied"))}
                                >
                                    {t("expertLibrary.copyPrompt")}
                                </Button>
                            </div>
                            <pre className="thin-scrollbar max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-stone-200 bg-stone-50 p-3 text-xs leading-5 text-stone-700 dark:border-stone-800 dark:bg-stone-800/60 dark:text-stone-300">
                                {item.callPrompt}
                            </pre>
                        </section>
                    </div>

                    <div className="shrink-0 border-t border-stone-200 px-5 py-4 dark:border-stone-800">
                        <Button type="primary" block icon={<Zap className="size-4" />} onClick={() => onInvoke(item)}>
                            {t("expertLibrary.invoke")}
                        </Button>
                        {connected ? (
                            <p className="mt-2 text-center text-xs text-stone-400 dark:text-stone-500">{t("expertLibrary.invokeHint")}</p>
                        ) : (
                            <p className="mt-2 text-center text-xs text-amber-600 dark:text-amber-400">{t("expertLibrary.drawerPrereq")}</p>
                        )}
                    </div>
                </div>
            ) : null}
        </Drawer>
    );
}
