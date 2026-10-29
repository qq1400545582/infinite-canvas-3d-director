import { Loader2, ShieldAlert } from "lucide-react";
import { type ReactNode, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router-dom";

import { licenseEnabled } from "./config";
import { useLicenseStore } from "./use-license-store";

/**
 * 全站登录守卫。
 *
 * - 未配置授权服务（开源/自建默认）时直接放行，不影响原有功能。
 * - 未登录 → /login
 * - 试用到期 / 未付费 → /purchase
 * - 账号被禁用 → 停用提示（不跳支付页，付钱也没用）
 * - 服务不可达 → 24 小时离线宽限，超时必须联网校验
 */
export function LicenseGate({ children }: { children: ReactNode }) {
    const { t } = useTranslation();
    const location = useLocation();
    const navigate = useNavigate();
    const token = useLicenseStore((state) => state.token);
    const user = useLicenseStore((state) => state.user);
    const phase = useLicenseStore((state) => state.phase);
    const error = useLicenseStore((state) => state.error);
    const offline = useLicenseStore((state) => state.offline);
    const check = useLicenseStore((state) => state.check);
    const loadPublic = useLicenseStore((state) => state.loadPublic);
    const started = useRef(false);

    useEffect(() => {
        if (started.current) return;
        started.current = true;
        void loadPublic();
        void check();
    }, [check, loadPublic]);

    if (!licenseEnabled()) return <>{children}</>;

    const enabled = licenseEnabled();
    const checking = phase === "checking" || (enabled && phase === "idle" && Boolean(token));

    if (checking && !user) {
        return (
            <div className="flex h-dvh items-center justify-center bg-background text-stone-500 dark:text-stone-400">
                <Loader2 className="mr-2 size-4 animate-spin" />
                {t("license.gate.checking")}
            </div>
        );
    }

    if (!token) return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;

    if (phase === "error") {
        return (
            <CenteredNotice
                icon={<ShieldAlert className="size-5" />}
                title={t("license.gate.unreachableTitle")}
                desc={error || t("license.gate.unreachableDesc")}
                actionLabel={t("license.gate.retry")}
                onAction={() => void check()}
                secondaryLabel={t("license.account.serviceAddress")}
                onSecondary={() => navigate("/login?service=1")}
            />
        );
    }

    const state = user?.license.state;
    if (state === "disabled") {
        return <CenteredNotice icon={<ShieldAlert className="size-5" />} title={t("license.gate.disabledTitle")} desc={t("license.gate.disabledDesc")} actionLabel={t("license.gate.retry")} onAction={() => void check()} />;
    }

    if (state === "expired") {
        return <Navigate to="/purchase?reason=expired" replace />;
    }

    return (
        <>
            {offline ? (
                <div className="flex shrink-0 items-center justify-center gap-2 bg-amber-500/15 px-4 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                    <ShieldAlert className="size-3.5" />
                    {t("license.gate.offlineBanner")}
                </div>
            ) : null}
            {children}
        </>
    );
}

function CenteredNotice({
    icon,
    title,
    desc,
    actionLabel,
    onAction,
    secondaryLabel,
    onSecondary,
}: {
    icon: ReactNode;
    title: string;
    desc: string;
    actionLabel: string;
    onAction: () => void;
    secondaryLabel?: string;
    onSecondary?: () => void;
}) {
    return (
        <div className="flex h-dvh items-center justify-center bg-background px-6">
            <div className="w-full max-w-md rounded-2xl border border-stone-200 bg-white p-7 text-center shadow-sm dark:border-stone-800 dark:bg-stone-900">
                <div className="mx-auto flex size-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-500 dark:bg-rose-500/10">{icon}</div>
                <h2 className="mt-4 text-base font-semibold text-stone-900 dark:text-stone-100">{title}</h2>
                <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{desc}</p>
                <div className="mt-5 flex items-center justify-center gap-2">
                    <button type="button" className="license-solid rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white" onClick={onAction}>
                        {actionLabel}
                    </button>
                    {secondaryLabel && onSecondary ? (
                        <button type="button" className="rounded-lg border border-stone-200 px-4 py-2 text-sm text-stone-600 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-300 dark:hover:bg-stone-800" onClick={onSecondary}>
                            {secondaryLabel}
                        </button>
                    ) : null}
                </div>
            </div>
        </div>
    );
}
