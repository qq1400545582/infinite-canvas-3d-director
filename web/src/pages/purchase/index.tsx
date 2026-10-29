import { ArrowLeft, BadgeCheck, CalendarClock, CircleAlert, ExternalLink, Loader2, LogOut, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { App } from "antd";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";

import { createOrder, fetchOrder } from "@/features/license/api";
import { licenseEnabled } from "@/features/license/config";
import { daysLeft, licenseUsable, useLicenseStore } from "@/features/license/use-license-store";
import { cn } from "@/lib/utils";

/**
 * 套餐购买页 —— 试用到期后唯一可进入的页面。
 *
 * 支付流程：创建订单 → 打开易支付收银台 → 轮询订单状态（服务端以易支付异步通知为准）。
 * 前端不判断“支付成功”，只展示服务端返回的订单状态。
 */
export default function PurchasePage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [params] = useSearchParams();
    const plans = useLicenseStore((state) => state.plans);
    const user = useLicenseStore((state) => state.user);
    const token = useLicenseStore((state) => state.token);
    const settings = useLicenseStore((state) => state.settings);
    const loadPublic = useLicenseStore((state) => state.loadPublic);
    const refresh = useLicenseStore((state) => state.refresh);
    const signOut = useLicenseStore((state) => state.signOut);
    const [busyPlan, setBusyPlan] = useState("");
    const [pendingOrder, setPendingOrder] = useState(params.get("order") || "");
    const [checking, setChecking] = useState(false);

    const expiredReason = params.get("reason") === "expired";
    const left = daysLeft(user);
    const usable = licenseUsable(user);
    const freeMode = settings ? !settings.paywallEnabled : false;

    useEffect(() => {
        void loadPublic();
        if (token) void refresh().catch(() => {});
    }, [loadPublic, refresh, token]);

    const checkOrder = useCallback(
        async (outTradeNo: string, silent = false) => {
            if (!token || !outTradeNo) return false;
            setChecking(true);
            try {
                const data = await fetchOrder(token, outTradeNo);
                if (data.order.status === "paid") {
                    setPendingOrder("");
                    useLicenseStore.getState().patchUser(data.user);
                    message.success(t("license.purchase.paidSuccess"));
                    return true;
                }
                if (!silent) message.info(t("license.purchase.stillPending"));
                return false;
            } catch (error) {
                if (!silent) message.error(error instanceof Error ? error.message : t("license.purchase.checkFailed"));
                return false;
            } finally {
                setChecking(false);
            }
        },
        [message, t, token],
    );

    // 有待确认订单时，每 4 秒查一次状态，最多 5 分钟
    useEffect(() => {
        if (!pendingOrder || !token) return;
        let tries = 0;
        const timer = setInterval(() => {
            tries += 1;
            void checkOrder(pendingOrder, true).then((paid) => {
                if (paid || tries >= 75) clearInterval(timer);
            });
        }, 4000);
        return () => clearInterval(timer);
    }, [checkOrder, pendingOrder, token]);

    const buy = async (planId: string) => {
        if (!token) {
            navigate("/login");
            return;
        }
        setBusyPlan(planId);
        try {
            const order = await createOrder(token, planId);
            setPendingOrder(order.outTradeNo);
            const opened = window.open(order.payUrl, "_blank", "noopener,noreferrer");
            if (!opened) {
                message.info(t("license.purchase.popupBlocked"));
            }
            message.success(t("license.purchase.orderCreated", { name: order.planName }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.purchase.orderFailed"));
        } finally {
            setBusyPlan("");
        }
    };

    const statusText = useMemo(() => {
        if (!user) return t("license.purchase.notLoggedIn");
        if (freeMode) return t("license.purchase.freeMode");
        if (user.license.state === "active") return t("license.purchase.activeUntil", { date: (user.license.until || "").slice(0, 10) });
        if (user.license.state === "trial") return t("license.purchase.trialLeft", { days: left ?? 0 });
        if (user.license.state === "disabled") return t("license.purchase.disabled");
        return t("license.purchase.expired");
    }, [freeMode, left, t, user]);

    return (
        <div className="min-h-dvh bg-background px-4 py-8 text-stone-800 dark:text-stone-100">
            <div className="mx-auto w-full max-w-5xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <button
                        type="button"
                        className="inline-flex items-center gap-1.5 text-xs text-stone-500 transition hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200"
                        onClick={() => (usable ? navigate("/") : navigate("/login"))}
                    >
                        <ArrowLeft className="size-3.5" />
                        {usable ? t("license.purchase.backToApp") : t("license.auth.backHome")}
                    </button>
                    <div className="flex items-center gap-2">
                        <span className="max-w-[200px] truncate rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-300">{user?.email || t("license.purchase.guest")}</span>
                        {token ? (
                            <button
                                type="button"
                                className="inline-flex items-center gap-1 rounded-full border border-stone-200 px-3 py-1 text-xs text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800"
                                onClick={() => {
                                    signOut();
                                    navigate("/login");
                                }}
                            >
                                <LogOut className="size-3" />
                                {t("license.account.logout")}
                            </button>
                        ) : null}
                    </div>
                </div>

                <div className="mt-6 rounded-3xl border border-stone-200/80 bg-white p-6 shadow-[0_20px_60px_-40px_rgba(28,25,23,0.45)] dark:border-stone-800 dark:bg-stone-900">
                    <div className="flex flex-wrap items-start justify-between gap-4">
                        <div>
                            <h1 className="text-xl font-semibold text-stone-950 dark:text-stone-100">{t("license.purchase.title")}</h1>
                            <p className="mt-1 text-sm text-stone-500 dark:text-stone-400">{t("license.purchase.subtitle")}</p>
                        </div>
                        <div
                            className={cn(
                                "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
                                usable ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
                            )}
                        >
                            {usable ? <BadgeCheck className="size-3.5" /> : <CalendarClock className="size-3.5" />}
                            {statusText}
                        </div>
                    </div>

                    {expiredReason && !usable ? (
                        <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                            <CircleAlert className="mt-0.5 size-3.5 shrink-0" />
                            {t("license.purchase.expiredNotice", { days: settings?.trialDays ?? 3 })}
                        </div>
                    ) : null}
                    {settings?.notice ? <div className="mt-3 rounded-xl bg-stone-50 px-3 py-2.5 text-xs leading-5 text-stone-600 dark:bg-stone-800/60 dark:text-stone-300">{settings.notice}</div> : null}

                    {pendingOrder ? (
                        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-200 bg-sky-50 px-3 py-2.5 text-xs text-sky-800 dark:border-sky-500/30 dark:bg-sky-500/10 dark:text-sky-200">
                            <span className="inline-flex items-center gap-1.5">
                                <Loader2 className={cn("size-3.5", "animate-spin")} />
                                {t("license.purchase.waitingPay", { order: pendingOrder })}
                            </span>
                            <button type="button" className="inline-flex items-center gap-1 rounded-md border border-sky-300 px-2 py-1 transition hover:bg-sky-100 dark:border-sky-400/40 dark:hover:bg-sky-500/20" onClick={() => void checkOrder(pendingOrder)}>
                                <RefreshCw className={cn("size-3", checking ? "animate-spin" : "")} />
                                {t("license.purchase.checkPaid")}
                            </button>
                        </div>
                    ) : null}

                    {!licenseEnabled() ? (
                        <div className="mt-5 rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">{t("license.purchase.notConfigured")}</div>
                    ) : plans.length === 0 ? (
                        <div className="mt-5 rounded-xl border border-dashed border-stone-300 px-4 py-6 text-center text-sm text-stone-500 dark:border-stone-700 dark:text-stone-400">{t("license.purchase.noPlans")}</div>
                    ) : (
                        <div className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {(() => {
                                // 主推套餐 = 第一个带角标的（角标文案由后台配置），只高亮一张，避免出现两个黑框
                                const highlightedId = plans.find((item) => item.badge)?.id;
                                return plans.map((plan) => {
                                    const highlight = plan.id === highlightedId;
                                return (
                                    <div
                                        key={plan.id}
                                        className={cn(
                                            "relative flex flex-col rounded-2xl border p-5 transition",
                                            highlight
                                                ? "border-stone-900 shadow-[0_18px_40px_-24px_rgba(28,25,23,0.6)] dark:border-stone-100"
                                                : "border-stone-200 hover:border-stone-300 dark:border-stone-800 dark:hover:border-stone-700",
                                        )}
                                    >
                                        {plan.badge ? (
                                            <span className="absolute -top-2.5 left-5 license-solid rounded-full bg-stone-900 px-2 py-0.5 text-[10px] font-medium text-white dark:bg-stone-100 dark:text-stone-900">{plan.badge}</span>
                                        ) : null}
                                        <div className="text-sm font-medium text-stone-950 dark:text-stone-100">{plan.name}</div>
                                        <div className="mt-2 flex items-end gap-1.5">
                                            <span className="text-2xl font-semibold tracking-tight text-stone-950 dark:text-stone-100">¥{plan.price}</span>
                                            {plan.originalPrice ? <span className="pb-1 text-xs text-stone-400 line-through">¥{plan.originalPrice}</span> : null}
                                        </div>
                                        <div className="mt-1 text-[11px] text-stone-500 dark:text-stone-400">{t("license.purchase.days", { days: plan.days })}</div>
                                        <p className="mt-3 min-h-[36px] flex-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{plan.desc}</p>
                                        <button
                                            type="button"
                                            disabled={Boolean(busyPlan)}
                                            onClick={() => void buy(plan.id)}
                                            className={cn(
                                                "mt-4 inline-flex items-center justify-center gap-1.5 rounded-xl py-2 text-sm font-medium transition disabled:opacity-60",
                                                highlight
                                                    ? "license-solid bg-stone-900 text-white hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                                                    : "border border-stone-300 text-stone-800 hover:bg-stone-50 dark:border-stone-700 dark:text-stone-100 dark:hover:bg-stone-800",
                                            )}
                                        >
                                            {busyPlan === plan.id ? <Loader2 className="size-4 animate-spin" /> : <ExternalLink className="size-3.5" />}
                                            {t("license.purchase.buy")}
                                        </button>
                                    </div>
                                );
                                });
                            })()}
                        </div>
                    )}

                    <p className="mt-5 text-[11px] leading-5 text-stone-400 dark:text-stone-500">{t("license.purchase.payNote")}</p>
                    {settings?.supportEmail ? (
                        <p className="mt-1 text-[11px] text-stone-400 dark:text-stone-500">
                            {t("license.purchase.support", { email: settings.supportEmail })}
                        </p>
                    ) : null}
                </div>

                <div className="mt-4 text-center text-[11px] text-stone-400">
                    <Link to="/admin" className="hover:underline">
                        {t("license.admin.entry")}
                    </Link>
                </div>
            </div>
        </div>
    );
}
