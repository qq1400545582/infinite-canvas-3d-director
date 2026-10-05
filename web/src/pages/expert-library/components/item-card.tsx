import { useState, type KeyboardEvent } from "react";
import { Trash2 } from "lucide-react";
import { Popconfirm } from "antd";
import { useTranslation } from "react-i18next";

import type { LibraryItem } from "../data/types";

/** 头像首字兜底底色（与 WorkBuddy 专家中心一致：8 色循环，按首字符码取模）。 */
const AVATAR_FALLBACK_COLOR_COUNT = 8;

function avatarFallbackBackground(seedText: string) {
    const index = (seedText.charCodeAt(0) || 0) % AVATAR_FALLBACK_COLOR_COUNT + 1;
    return `var(--ec-avatar-fallback-bg-${index})`;
}

/** 运营徽标图标（特邀专家）：形状与配色逐字取自 WorkBuddy 的 VerifiedTagIcon。 */
function VerifiedTagIcon({ className }: { className?: string }) {
    return (
        <svg className={className} width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path
                d="M10.6611 6.7939C10.6611 8.2019 10.0018 9.4615 8.967 10.2976C7.3542 11.6006 4.7272 11.8148 3.0966 10.3004C2.3178 9.5771 1.946 8.5512 1.946 7.4816L1.946 3.839C1.6009 3.6672 1.2997 3.4119 1.1088 3.0442C0.8663 2.5769 0.8365 1.9979 1.0122 1.3215L1.0349 1.2555C1.0998 1.109 1.244 1.0064 1.4121 0.9932L1.4135 0.9932C1.4135 0.9932 1.4161 0.9927 1.4179 0.9925C1.4216 0.9922 1.4272 0.9923 1.434 0.9918C1.4479 0.9908 1.4682 0.9887 1.4948 0.9868C1.5486 0.9831 1.6282 0.9776 1.7321 0.9712C1.9403 0.9584 2.2472 0.9414 2.6425 0.9245C3.4331 0.8905 4.5794 0.8571 6.0073 0.8571C7.1779 0.8571 8.7085 0.864 9.7353 1.961C10.6532 2.9418 10.6611 4.3142 10.6611 5.3497L10.6611 6.7939Z"
                fill="var(--ec-operational-tag-icon-color, #3d3d3d)"
            />
            <path
                d="M6.91695 8.60489L5.23975 8.60489L3.17725 4.47989L4.85375 4.47989L6.07765 6.92769L7.30155 4.47989L8.97955 4.47989L6.91695 8.60489Z"
                fill="var(--ec-operational-tag-check-color, #f7d18f)"
            />
        </svg>
    );
}

export function ItemCard({
    item,
    onOpen,
    onInvoke,
    onRemove,
}: {
    item: LibraryItem;
    onOpen: (item: LibraryItem) => void;
    onInvoke: (item: LibraryItem) => void;
    onRemove?: (item: LibraryItem) => void;
}) {
    const { t } = useTranslation();
    const [avatarState, setAvatarState] = useState<"pending" | "loaded" | "error">("pending");

    // 标题取职称，缺省回退名称；副标题取名称（专家团优先出品方），且与标题/描述重复时不展示。
    const title = (item.profession ?? "").trim() || item.name;
    const description = item.description.trim();
    const subtitle = (item.team ? [item.author, item.name] : [item.name])
        .map((text) => (text ?? "").trim())
        .find((text) => text && text !== title && text !== description) ?? "";
    // 无职称/分类可区分时，副标题退化为分类，保证卡片信息量不为空。
    const subtitleText = subtitle || (item.category && item.category !== title ? item.category : "");
    const fallbackLabel = title || item.name;
    const tags = item.tags.slice(0, 3);
    const avatarUrl = item.avatar?.trim() || "";

    const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen(item);
        }
    };

    return (
        <article
            className="wb-ec-scope ec-expert-card"
            role="button"
            tabIndex={0}
            aria-label={item.name}
            onClick={() => onOpen(item)}
            onKeyDown={handleKeyDown}
        >
            <button
                type="button"
                className="ec-card-summon-btn ec-card-summon-btn--top"
                aria-label={t("expertLibrary.invoke")}
                onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onInvoke(item);
                }}
            >
                {t("expertLibrary.invoke")}
            </button>

            {/* 删除按钮：hover 卡片时浮现。样式用 Tailwind 内联，不动 expert-card.css（逐字复刻 WorkBuddy 结构）。 */}
            {onRemove ? (
                <Popconfirm
                    title={t("expertLibrary.remove.confirmTitle", { name: item.name })}
                    okText={t("expertLibrary.remove.ok")}
                    cancelText={t("common.cancel")}
                    okButtonProps={{ danger: true }}
                    onConfirm={() => onRemove(item)}
                >
                    <button
                        type="button"
                        className="absolute right-2 top-2 z-10 grid size-7 place-items-center rounded-md border border-stone-200 bg-white/90 text-stone-500 opacity-0 shadow-sm transition hover:border-red-300 hover:bg-red-50 hover:text-red-600 focus-visible:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 [.ec-expert-card:hover_&]:opacity-100 dark:border-stone-700 dark:bg-stone-900/90 dark:text-stone-400 dark:hover:border-red-800 dark:hover:bg-red-950/60 dark:hover:text-red-400"
                        aria-label={t("expertLibrary.remove.action", { name: item.name })}
                        title={t("expertLibrary.remove.action", { name: item.name })}
                        onClick={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                        }}
                    >
                        <Trash2 className="size-3.5" />
                    </button>
                </Popconfirm>
            ) : null}

            <div className="ec-card-main">
                <div className="ec-card-head">
                    <div className="ec-card-avatar-sq">
                        <div className="ec-avatar-sq-fallback" style={{ background: avatarFallbackBackground(fallbackLabel) }}>
                            {fallbackLabel.charAt(0)}
                        </div>
                        {avatarUrl && avatarState !== "error" ? (
                            <img
                                className={avatarState === "loaded" ? undefined : "is-pending"}
                                src={avatarUrl}
                                alt={item.name}
                                loading="eager"
                                decoding="async"
                                onLoad={() => setAvatarState("loaded")}
                                onError={() => setAvatarState("error")}
                            />
                        ) : null}
                    </div>
                    <div className="ec-card-body">
                        <div className="ec-card-title-row">
                            <div className="ec-card-role-wrap">
                                <div className="ec-card-role">{title}</div>
                            </div>
                            {item.badge ? (
                                <span className="ec-card-operational-tag" title={item.badge}>
                                    <VerifiedTagIcon className="ec-card-operational-tag__icon" />
                                    <span className="ec-card-operational-tag__text">{item.badge}</span>
                                </span>
                            ) : null}
                        </div>
                        {subtitleText ? <div className="ec-card-subtitle">{subtitleText}</div> : null}
                    </div>
                </div>
                <div className="ec-card-desc">{description}</div>
                {tags.length ? (
                    <div className="ec-card-tags">
                        {tags.map((tag) => (
                            <span key={tag} className="ec-card-tag">
                                {tag}
                            </span>
                        ))}
                    </div>
                ) : null}
            </div>
        </article>
    );
}
