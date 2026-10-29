import { BadgeCheck, CalendarClock, CreditCard, LogOut, UserRound } from "lucide-react";
import { Dropdown } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { cn } from "@/lib/utils";

import { licenseEnabled } from "./config";
import { daysLeft, licenseUsable, useLicenseStore } from "./use-license-store";

/**
 * 顶栏 / 侧栏的账号入口。
 *
 * - 未启用授权体系（没配服务地址的开源自建）时完全不渲染，不影响原有界面。
 * - 未登录显示「登录」；已登录显示首字母头像 + 剩余天数徽标。
 * - 点击展开：剩余时长、购买续费、退出登录。
 */
export function AccountButton({ tone = "light", className }: { tone?: "light" | "dark"; className?: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const token = useLicenseStore((state) => state.token);
    const user = useLicenseStore((state) => state.user);
    const signOut = useLicenseStore((state) => state.signOut);

    if (!licenseEnabled()) return null;

    const dark = tone === "dark";
    const base = cn(
        "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md transition",
        dark ? "text-white hover:bg-white/[0.18] hover:ring-1 hover:ring-white/30" : "text-stone-600 hover:bg-black/5 hover:text-stone-950 dark:text-stone-300 dark:hover:bg-white/10 dark:hover:text-white",
        className,
    );

    if (!token || !user) {
        return (
            <button type="button" className={cn(base, "px-2 text-xs font-medium")} onClick={() => navigate("/login")} aria-label={t("license.account.login")} title={t("license.account.login")}>
                <UserRound className="size-4" />
                <span className={dark ? "" : "hidden sm:inline"}>{t("license.account.login")}</span>
            </button>
        );
    }

    const usable = licenseUsable(user);
    const left = daysLeft(user);
    const initial = (user.email || "?").slice(0, 1).toUpperCase();
    const badge = usable ? (left === null ? "" : String(Math.ceil(left))) : t("license.account.expiredShort");

    return (
        <Dropdown
            trigger={["click"]}
            placement="bottomRight"
            menu={{
                items: [
                    { key: "email", label: <span className="text-xs text-stone-500">{user.email}</span>, disabled: true },
                    { type: "divider" },
                    {
                        key: "status",
                        disabled: true,
                        label: (
                            <span className="inline-flex items-center gap-1.5 text-xs">
                                {usable ? <BadgeCheck className="size-3.5 text-emerald-500" /> : <CalendarClock className="size-3.5 text-amber-500" />}
                                {user.license.state === "active"
                                    ? t("license.account.activeUntil", { date: (user.license.until || "").slice(0, 10) })
                                    : user.license.state === "trial"
                                      ? t("license.account.trialLeft", { days: left ?? 0 })
                                      : t("license.account.expired")}
                            </span>
                        ),
                    },
                    { key: "purchase", icon: <CreditCard className="size-3.5" />, label: t("license.account.purchase") },
                    { type: "divider" },
                    { key: "logout", icon: <LogOut className="size-3.5" />, label: t("license.account.logout") },
                ],
                onClick: ({ key }) => {
                    if (key === "purchase") navigate("/purchase");
                    if (key === "logout") {
                        signOut();
                        navigate("/login");
                    }
                },
            }}
        >
            <button type="button" className={cn(base, "relative size-8")} aria-label={user.email} title={`${user.email}${badge ? ` · ${badge}` : ""}`}>
                <span className={cn("flex size-6 items-center justify-center rounded-full text-[11px] font-semibold", dark ? "bg-white/20 text-white" : "license-solid bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900")}>{initial}</span>
                {badge ? <span className={cn("absolute -right-0.5 -top-0.5 rounded-full px-1 text-[9px] leading-4", usable ? "bg-emerald-500 text-white" : "bg-amber-500 text-white")}>{badge}</span> : null}
            </button>
        </Dropdown>
    );
}
