import { ArrowLeft, ChevronDown, Loader2, LockKeyhole, Mail, ShieldCheck } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { App, Input } from "antd";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate } from "react-router-dom";

import { LicenseApiError, loginAccount, registerAccount, sendRegisterCode } from "@/features/license/api";
import { domainHint, licenseApiBase, licenseEnabled, setLicenseApiBase } from "@/features/license/config";
import { useLicenseStore } from "@/features/license/use-license-store";
import { cn } from "@/lib/utils";

type Mode = "login" | "register";

/**
 * 登录 / 注册页。
 *
 * 只负责收集凭据与展示服务端返回的错误；账号是否已注册、域名是否在白名单、
 * 验证码是否正确、试用天数，全部由授权服务判定。
 */
export default function AuthPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const location = useLocation();
    const setSession = useLicenseStore((state) => state.setSession);
    const settings = useLicenseStore((state) => state.settings);
    const loadPublic = useLicenseStore((state) => state.loadPublic);
    const currentToken = useLicenseStore((state) => state.token);
    const apiBaseInStore = useLicenseStore((state) => state.setApiBase);
    const [mode, setMode] = useState<Mode>("login");
    const [email, setEmail] = useState("");
    const [password, setPassword] = useState("");
    const [code, setCode] = useState("");
    const [busy, setBusy] = useState(false);
    const [sending, setSending] = useState(false);
    const [countdown, setCountdown] = useState(0);
    const [devCode, setDevCode] = useState("");
    const [serviceOpen, setServiceOpen] = useState(new URLSearchParams(location.search).has("service") || !licenseEnabled());
    const [serviceInput, setServiceInput] = useState(licenseApiBase());

    const from = ((location.state as { from?: string } | null)?.from || "/") as string;
    const requiresCode = settings?.requireEmailCode ?? true;
    const domains = useMemo(() => (settings?.emailDomains || []).slice(0, 12), [settings?.emailDomains]);

    useEffect(() => {
        void loadPublic();
    }, [loadPublic]);

    useEffect(() => {
        if (currentToken) navigate(from, { replace: true });
    }, [currentToken, from, navigate]);

    useEffect(() => {
        if (countdown <= 0) return;
        const timer = setTimeout(() => setCountdown((value) => value - 1), 1000);
        return () => clearTimeout(timer);
    }, [countdown]);

    const switchMode = (next: Mode) => {
        setMode(next);
        setCode("");
        setDevCode("");
    };

    const handleSendCode = async () => {
        if (!email.trim()) return message.warning(t("license.auth.emailRequired"));
        setSending(true);
        try {
            const result = await sendRegisterCode(email.trim());
            setCountdown(60);
            if (result.devCode) {
                setDevCode(result.devCode);
                setCode(result.devCode);
                message.success(t("license.auth.devCode", { code: result.devCode }));
            } else {
                message.success(t("license.auth.codeSent"));
            }
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.auth.codeFailed"));
        } finally {
            setSending(false);
        }
    };

    const handleSubmit = async (event: FormEvent) => {
        event.preventDefault();
        if (!email.trim() || !password) return message.warning(t("license.auth.credentialsRequired"));
        if (mode === "register" && requiresCode && !code.trim()) return message.warning(t("license.auth.codeRequired"));
        if (!licenseApiBase()) {
            setServiceOpen(true);
            return message.warning(t("license.auth.needService"));
        }
        setBusy(true);
        try {
            const result = mode === "login" ? await loginAccount(email.trim(), password) : await registerAccount(email.trim(), password, code.trim());
            setSession(result.token, result.user);
            message.success(mode === "login" ? t("license.auth.loginSuccess") : t("license.auth.registerSuccess"));
            navigate(mode === "login" ? from : "/", { replace: true });
        } catch (error) {
            if (error instanceof LicenseApiError && error.code === "email_domain_not_allowed") {
                const allowed = (error.details?.allowedDomains as string[] | undefined) || domains;
                message.error(t("license.auth.domainDenied", { domains: domainHint(allowed) }));
            } else {
                message.error(error instanceof Error ? error.message : t("license.auth.failed"));
            }
        } finally {
            setBusy(false);
        }
    };

    const saveService = () => {
        apiBaseInStore(serviceInput.trim());
        setServiceOpen(false);
        void loadPublic();
        message.success(serviceInput.trim() ? t("license.auth.serviceSaved") : t("license.auth.serviceCleared"));
    };

    return (
        <div className="relative flex min-h-dvh items-center justify-center overflow-hidden bg-background px-4 py-10">
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(#e7e5e4_1px,transparent_1px)] [background-size:18px_18px] dark:bg-[radial-gradient(rgba(245,245,244,.12)_1px,transparent_1px)]" />
            <div className="relative w-full max-w-[420px]">
                <Link to="/" className="mb-5 inline-flex items-center gap-1.5 text-xs text-stone-500 transition hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200">
                    <ArrowLeft className="size-3.5" />
                    {t("license.auth.backHome")}
                </Link>

                <div className="rounded-3xl border border-stone-200/80 bg-white/90 p-7 shadow-[0_20px_60px_-30px_rgba(28,25,23,0.35)] backdrop-blur-xl dark:border-stone-800 dark:bg-stone-900/90">
                    <div className="flex items-center gap-2.5">
                        <span
                            className="size-8 shrink-0 bg-stone-900 dark:bg-stone-100"
                            style={{ mask: "url(/logo.svg) center / contain no-repeat", WebkitMask: "url(/logo.svg) center / contain no-repeat" }}
                        />
                        <div>
                            <h1 className="text-lg font-semibold leading-tight text-stone-950 dark:text-stone-100">{t("meta.title")}</h1>
                            <p className="text-[11px] text-stone-500 dark:text-stone-400">{t("license.auth.subtitle")}</p>
                        </div>
                    </div>

                    <div className="mt-6 grid grid-cols-2 gap-1 rounded-xl bg-stone-100 p-1 dark:bg-stone-800">
                        {(["login", "register"] as Mode[]).map((item) => (
                            <button
                                key={item}
                                type="button"
                                onClick={() => switchMode(item)}
                                className={cn(
                                    "rounded-lg py-2 text-sm font-medium transition",
                                    mode === item ? "bg-white text-stone-900 shadow-sm dark:bg-stone-950 dark:text-stone-100" : "text-stone-500 hover:text-stone-800 dark:text-stone-400 dark:hover:text-stone-200",
                                )}
                            >
                                {t(item === "login" ? "license.auth.tabLogin" : "license.auth.tabRegister")}
                            </button>
                        ))}
                    </div>

                    <form className="mt-5 space-y-3" onSubmit={handleSubmit}>
                        <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">{t("license.auth.email")}</span>
                            <Input
                                size="large"
                                value={email}
                                onChange={(event) => setEmail(event.target.value)}
                                placeholder={t("license.auth.emailPlaceholder")}
                                prefix={<Mail className="size-4 text-stone-400" />}
                                autoComplete="email"
                                allowClear
                            />
                        </label>

                        <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">{t("license.auth.password")}</span>
                            <Input.Password
                                size="large"
                                value={password}
                                onChange={(event) => setPassword(event.target.value)}
                                placeholder={t("license.auth.passwordPlaceholder")}
                                prefix={<LockKeyhole className="size-4 text-stone-400" />}
                                autoComplete={mode === "login" ? "current-password" : "new-password"}
                            />
                        </label>

                        {mode === "register" && requiresCode ? (
                            <label className="block">
                                <span className="mb-1.5 block text-xs font-medium text-stone-600 dark:text-stone-300">{t("license.auth.code")}</span>
                                <div className="flex gap-2">
                                    <Input
                                        size="large"
                                        value={code}
                                        onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
                                        placeholder={t("license.auth.codePlaceholder")}
                                        prefix={<ShieldCheck className="size-4 text-stone-400" />}
                                        maxLength={6}
                                    />
                                    <button
                                        type="button"
                                        disabled={sending || countdown > 0}
                                        onClick={() => void handleSendCode()}
                                        className="shrink-0 rounded-lg border border-stone-200 px-3 text-xs font-medium text-stone-700 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-800"
                                    >
                                        {sending ? <Loader2 className="size-4 animate-spin" /> : countdown > 0 ? t("license.auth.resendIn", { seconds: countdown }) : t("license.auth.sendCode")}
                                    </button>
                                </div>
                            </label>
                        ) : null}

                        {domains.length ? (
                            <p className="text-[11px] leading-5 text-stone-400 dark:text-stone-500">{t("license.auth.domainHint", { domains: domainHint(domains) })}</p>
                        ) : null}
                        {devCode ? <p className="text-[11px] leading-5 text-emerald-600 dark:text-emerald-400">{t("license.auth.devCode", { code: devCode })}</p> : null}

                        <button
                            type="submit"
                            disabled={busy}
                            className="mt-1 inline-flex w-full items-center justify-center gap-2 license-solid rounded-xl bg-stone-900 py-2.5 text-sm font-medium text-white transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white"
                        >
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t(mode === "login" ? "license.auth.submitLogin" : "license.auth.submitRegister")}
                        </button>
                    </form>

                    {settings && settings.trialDays > 0 ? (
                        <p className="mt-4 rounded-lg bg-stone-50 px-3 py-2 text-center text-[11px] leading-5 text-stone-500 dark:bg-stone-800/60 dark:text-stone-400">
                            {t("license.auth.trialNote", { days: settings.trialDays })}
                        </p>
                    ) : null}
                </div>

                <div className="mt-4 rounded-xl border border-stone-200/70 bg-white/70 px-3 py-2 text-[11px] text-stone-500 dark:border-stone-800 dark:bg-stone-900/70 dark:text-stone-400">
                    <button type="button" className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setServiceOpen((value) => !value)}>
                        <span className="truncate">{t("license.account.serviceAddress")}: {licenseApiBase() || t("license.account.notSet")}</span>
                        <ChevronDown className={cn("size-3.5 shrink-0 transition", serviceOpen ? "rotate-180" : "")} />
                    </button>
                    {serviceOpen ? (
                        <div className="mt-2 flex gap-2">
                            <Input size="small" value={serviceInput} onChange={(event) => setServiceInput(event.target.value)} placeholder="https://license.example.com" />
                            <button type="button" className="shrink-0 rounded-md border border-stone-200 px-2 text-[11px] dark:border-stone-700" onClick={saveService}>
                                {t("license.auth.save")}
                            </button>
                        </div>
                    ) : null}
                    {serviceOpen ? <p className="mt-1.5 text-[10px] leading-4 text-stone-400">{t("license.auth.serviceHint")}</p> : null}
                    <button type="button" className="mt-1 text-[10px] text-stone-400 underline-offset-2 hover:underline" onClick={() => navigate("/admin")}>
                        {t("license.admin.entry")}
                    </button>
                </div>
            </div>
        </div>
    );
}
