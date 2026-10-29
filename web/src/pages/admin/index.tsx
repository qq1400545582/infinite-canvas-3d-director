import { CheckCircle2, CircleAlert, Loader2, LogOut, Plus, RefreshCw, Search, Trash2, Users } from "lucide-react";
import { type FormEvent, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { App, Input, Modal, Select, Switch } from "antd";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import {
    adminDeletePlan,
    adminGetSettings,
    adminListOrders,
    adminListPlans,
    adminListUsers,
    adminLogin,
    adminMarkPaid,
    adminOverview,
    adminPutSettings,
    adminSavePlan,
    adminTestMail,
    adminUserAction,
    type AdminOrder,
    type AdminPlan,
    type AdminSettings,
    type AdminUser,
} from "@/features/license/api";
import { licenseApiBase, licenseEnabled, setLicenseApiBase } from "@/features/license/config";
import { cn } from "@/lib/utils";

/**
 * 运营后台（/admin）。
 *
 * 与用户端完全隔离：独立口令登录、独立令牌（12 小时）、独立数据源。
 * 这里改的每一项都直接落服务端，用户端下次校验即生效。
 */

const TOKEN_KEY = "infinite-canvas:license_admin_token";
const TABS = ["overview", "plans", "settings", "users", "orders"] as const;
type Tab = (typeof TABS)[number];

function fmt(value?: string | null) {
    if (!value) return "-";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")} ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

export default function AdminPage() {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const navigate = useNavigate();
    const [token, setToken] = useState(() => localStorage.getItem(TOKEN_KEY) || "");
    const [password, setPassword] = useState("");
    const [busy, setBusy] = useState(false);
    const [tab, setTab] = useState<Tab>("overview");
    const [serviceInput, setServiceInput] = useState(licenseApiBase());

    const login = async (event: FormEvent) => {
        event.preventDefault();
        if (!password) return;
        setBusy(true);
        try {
            const result = await adminLogin(password);
            localStorage.setItem(TOKEN_KEY, result.token);
            setToken(result.token);
            setPassword("");
            if (result.defaultPassword) message.warning(t("license.admin.defaultPasswordWarning"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.loginFailed"));
        } finally {
            setBusy(false);
        }
    };

    const logout = () => {
        localStorage.removeItem(TOKEN_KEY);
        setToken("");
    };

    if (!token) {
        return (
            <div className="flex min-h-dvh items-center justify-center bg-background px-4">
                <div className="w-full max-w-sm rounded-2xl border border-stone-200 bg-white p-6 shadow-sm dark:border-stone-800 dark:bg-stone-900">
                    <h1 className="text-base font-semibold text-stone-950 dark:text-stone-100">{t("license.admin.title")}</h1>
                    <p className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("license.admin.subtitle")}</p>
                    <form className="mt-5 space-y-3" onSubmit={login}>
                        <Input.Password size="large" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("license.admin.passwordPlaceholder")} autoComplete="current-password" />
                        <button type="submit" disabled={busy} className="inline-flex w-full items-center justify-center gap-2 license-solid rounded-lg bg-stone-900 py-2.5 text-sm font-medium text-white transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white">
                            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                            {t("license.admin.enter")}
                        </button>
                    </form>
                    <div className="mt-4 space-y-2 border-t border-stone-100 pt-3 text-[11px] text-stone-500 dark:border-stone-800 dark:text-stone-400">
                        <div className="flex gap-2">
                            <Input size="small" value={serviceInput} onChange={(event) => setServiceInput(event.target.value)} placeholder="https://license.example.com" />
                            <button type="button" className="shrink-0 rounded-md border border-stone-200 px-2 dark:border-stone-700" onClick={() => setLicenseApiBase(serviceInput)}>
                                {t("license.auth.save")}
                            </button>
                        </div>
                        {!licenseEnabled() ? <p className="text-amber-600 dark:text-amber-400">{t("license.admin.needService")}</p> : null}
                        <button type="button" className="underline-offset-2 hover:underline" onClick={() => navigate("/login")}>
                            {t("license.admin.backToLogin")}
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className="min-h-dvh bg-background px-4 py-6 text-stone-800 dark:text-stone-100">
            <div className="mx-auto w-full max-w-6xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                        <h1 className="text-lg font-semibold text-stone-950 dark:text-stone-100">{t("license.admin.title")}</h1>
                        <p className="text-xs text-stone-500 dark:text-stone-400">{licenseApiBase()}</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <button type="button" className="inline-flex items-center gap-1 rounded-full border border-stone-200 px-3 py-1 text-xs dark:border-stone-700" onClick={() => navigate("/")}>
                            {t("license.admin.backToApp")}
                        </button>
                        <button type="button" className="inline-flex items-center gap-1 rounded-full border border-stone-200 px-3 py-1 text-xs dark:border-stone-700" onClick={logout}>
                            <LogOut className="size-3" />
                            {t("license.account.logout")}
                        </button>
                    </div>
                </div>

                <div className="mt-4 flex flex-wrap gap-1 rounded-xl border border-stone-200 bg-white p-1 dark:border-stone-800 dark:bg-stone-900">
                    {TABS.map((item) => (
                        <button
                            key={item}
                            type="button"
                            onClick={() => setTab(item)}
                            className={cn(
                                "rounded-lg px-3 py-1.5 text-xs font-medium transition",
                                tab === item ? "license-solid bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900" : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800",
                            )}
                        >
                            {t(`license.admin.tabs.${item}`)}
                        </button>
                    ))}
                </div>

                <div className="mt-4">
                    {tab === "overview" ? <OverviewTab token={token} /> : null}
                    {tab === "plans" ? <PlansTab token={token} /> : null}
                    {tab === "settings" ? <SettingsTab token={token} /> : null}
                    {tab === "users" ? <UsersTab token={token} /> : null}
                    {tab === "orders" ? <OrdersTab token={token} /> : null}
                </div>
            </div>
        </div>
    );
}

/* ---------------- 概览 ---------------- */

function OverviewTab({ token }: { token: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [data, setData] = useState<Awaited<ReturnType<typeof adminOverview>> | null>(null);
    const [loading, setLoading] = useState(false);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            setData(await adminOverview(token));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.loadFailed"));
        } finally {
            setLoading(false);
        }
    }, [message, t, token]);

    useEffect(() => {
        void load();
    }, [load]);

    const cards = useMemo(
        () => [
            { key: "users", label: t("license.admin.stat.users"), value: data?.users ?? 0 },
            { key: "trialing", label: t("license.admin.stat.trialing"), value: data?.trialing ?? 0 },
            { key: "active", label: t("license.admin.stat.active"), value: data?.active ?? 0 },
            { key: "expired", label: t("license.admin.stat.expired"), value: data?.expired ?? 0 },
            { key: "disabled", label: t("license.admin.stat.disabled"), value: data?.disabled ?? 0 },
            { key: "todaySignups", label: t("license.admin.stat.today"), value: data?.todaySignups ?? 0 },
            { key: "paidOrders", label: t("license.admin.stat.paidOrders"), value: data?.paidOrders ?? 0 },
            { key: "revenue", label: t("license.admin.stat.revenue"), value: `¥${data?.revenue ?? "0.00"}` },
        ],
        [data, t],
    );

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-stone-700 dark:text-stone-200">{t("license.admin.tabs.overview")}</h2>
                <button type="button" className="inline-flex items-center gap-1 rounded-md border border-stone-200 px-2 py-1 text-xs dark:border-stone-700" onClick={() => void load()}>
                    <RefreshCw className={cn("size-3", loading ? "animate-spin" : "")} />
                    {t("license.admin.refresh")}
                </button>
            </div>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                {cards.map((card) => (
                    <div key={card.key} className="rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900">
                        <div className="text-[11px] text-stone-500 dark:text-stone-400">{card.label}</div>
                        <div className="mt-1 text-xl font-semibold text-stone-950 dark:text-stone-100">{card.value}</div>
                    </div>
                ))}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
                <StatusLine ok={Boolean(data?.smtpConfigured)} title={t("license.admin.smtp.title")} okText={t("license.admin.smtp.ok")} badText={t("license.admin.smtp.missing")} hint={t("license.admin.smtp.hint")} />
                <StatusLine ok={Boolean(data?.devEchoCode)} warn title={t("license.admin.devEcho.title")} okText={t("license.admin.devEcho.on")} badText={t("license.admin.devEcho.off")} hint={t("license.admin.devEcho.hint")} />
            </div>
        </div>
    );
}

function StatusLine({ ok, warn, title, okText, badText, hint }: { ok: boolean; warn?: boolean; title: string; okText: string; badText: string; hint: string }) {
    const positive = warn ? !ok : ok;
    return (
        <div className="rounded-xl border border-stone-200 bg-white px-4 py-3 dark:border-stone-800 dark:bg-stone-900">
            <div className="flex items-center gap-2 text-xs font-medium text-stone-800 dark:text-stone-100">
                {positive ? <CheckCircle2 className="size-4 text-emerald-500" /> : <CircleAlert className="size-4 text-amber-500" />}
                {title}
                <span className="ml-auto text-[11px] font-normal text-stone-500 dark:text-stone-400">{ok ? okText : badText}</span>
            </div>
            <p className="mt-1.5 text-[11px] leading-5 text-stone-500 dark:text-stone-400">{hint}</p>
        </div>
    );
}

/* ---------------- 套餐 ---------------- */

const EMPTY_PLAN: Partial<AdminPlan> = { name: "", days: 31, price: "29.00", originalPrice: "", desc: "", badge: "", active: true, sort: 10 };

function PlansTab({ token }: { token: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [plans, setPlans] = useState<AdminPlan[]>([]);
    const [editing, setEditing] = useState<Partial<AdminPlan> | null>(null);
    const [saving, setSaving] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState<AdminPlan | null>(null);

    const load = useCallback(async () => {
        try {
            setPlans((await adminListPlans(token)).plans);
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.loadFailed"));
        }
    }, [message, t, token]);

    useEffect(() => {
        void load();
    }, [load]);

    const save = async () => {
        if (!editing) return;
        setSaving(true);
        try {
            const result = await adminSavePlan(token, editing, editing.id);
            setPlans(result.plans);
            setEditing(null);
            message.success(t("license.admin.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    const remove = async (plan: AdminPlan) => {
        try {
            const result = await adminDeletePlan(token, plan.id);
            setPlans(result.plans);
            message.success(result.archived ? t("license.admin.planArchived") : t("license.admin.planDeleted"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.saveFailed"));
        } finally {
            setConfirmDelete(null);
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-stone-700 dark:text-stone-200">{t("license.admin.tabs.plans")}</h2>
                <button type="button" className="inline-flex items-center gap-1 license-solid rounded-md bg-stone-900 px-2.5 py-1 text-xs text-white dark:bg-stone-100 dark:text-stone-900" onClick={() => setEditing({ ...EMPTY_PLAN })}>
                    <Plus className="size-3" />
                    {t("license.admin.newPlan")}
                </button>
            </div>

            <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
                <table className="w-full min-w-[720px] text-left text-xs">
                    <thead className="bg-stone-50 text-[11px] text-stone-500 dark:bg-stone-800/60 dark:text-stone-400">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("license.admin.plan.name")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.plan.days")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.plan.price")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.plan.sort")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.plan.status")}</th>
                            <th className="px-3 py-2 text-right font-medium">{t("license.admin.actions")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {plans.map((plan) => (
                            <tr key={plan.id} className="border-t border-stone-100 dark:border-stone-800">
                                <td className="px-3 py-2">
                                    <div className="font-medium text-stone-900 dark:text-stone-100">{plan.name}</div>
                                    <div className="text-[11px] text-stone-400">{plan.desc}</div>
                                </td>
                                <td className="px-3 py-2">{plan.days}</td>
                                <td className="px-3 py-2">¥{plan.price}</td>
                                <td className="px-3 py-2">{plan.sort}</td>
                                <td className="px-3 py-2">
                                    <span className={cn("rounded-full px-2 py-0.5 text-[10px]", plan.active ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400")}>
                                        {plan.active ? t("license.admin.plan.on") : t("license.admin.plan.off")}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-right">
                                    <button type="button" className="rounded-md px-2 py-1 text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800" onClick={() => setEditing({ ...plan })}>
                                        {t("license.admin.edit")}
                                    </button>
                                    <button type="button" className="ml-1 rounded-md px-2 py-1 text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-500/10" onClick={() => setConfirmDelete(plan)}>
                                        <Trash2 className="size-3.5" />
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {plans.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-3 py-6 text-center text-stone-400">
                                    {t("license.purchase.noPlans")}
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>

            <Modal
                open={Boolean(editing)}
                title={editing?.id ? t("license.admin.plan.editTitle") : t("license.admin.plan.newTitle")}
                onCancel={() => setEditing(null)}
                onOk={() => void save()}
                confirmLoading={saving}
                okText={t("license.admin.save")}
                cancelText={t("license.admin.cancel")}
                destroyOnHidden
            >
                {editing ? (
                    <div className="space-y-3 pt-1">
                        <Field label={t("license.admin.plan.name")}>
                            <Input value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder={t("license.admin.plan.namePlaceholder")} />
                        </Field>
                        <div className="grid grid-cols-2 gap-3">
                            <Field label={t("license.admin.plan.days")}>
                                <Input type="number" value={editing.days} onChange={(event) => setEditing({ ...editing, days: Number(event.target.value) })} />
                            </Field>
                            <Field label={t("license.admin.plan.price")}>
                                <Input value={editing.price} onChange={(event) => setEditing({ ...editing, price: event.target.value })} />
                            </Field>
                            <Field label={t("license.admin.plan.originalPrice")}>
                                <Input value={editing.originalPrice} onChange={(event) => setEditing({ ...editing, originalPrice: event.target.value })} />
                            </Field>
                            <Field label={t("license.admin.plan.badge")}>
                                <Input value={editing.badge} onChange={(event) => setEditing({ ...editing, badge: event.target.value })} placeholder={t("license.admin.plan.badgePlaceholder")} />
                            </Field>
                        </div>
                        <Field label={t("license.admin.plan.desc")}>
                            <Input.TextArea rows={2} value={editing.desc} onChange={(event) => setEditing({ ...editing, desc: event.target.value })} />
                        </Field>
                        <div className="flex items-center gap-6">
                            <Field label={t("license.admin.plan.sort")}>
                                <Input type="number" value={editing.sort} onChange={(event) => setEditing({ ...editing, sort: Number(event.target.value) })} />
                            </Field>
                            <label className="flex items-center gap-2 pt-5 text-xs text-stone-600 dark:text-stone-300">
                                <Switch size="small" checked={editing.active} onChange={(checked) => setEditing({ ...editing, active: checked })} />
                                {t("license.admin.plan.active")}
                            </label>
                        </div>
                    </div>
                ) : null}
            </Modal>

            <Modal
                open={Boolean(confirmDelete)}
                title={t("license.admin.plan.deleteTitle")}
                onCancel={() => setConfirmDelete(null)}
                onOk={() => confirmDelete && void remove(confirmDelete)}
                okText={t("license.admin.confirm")}
                cancelText={t("license.admin.cancel")}
                okButtonProps={{ danger: true }}
            >
                <p className="text-sm text-stone-600 dark:text-stone-300">{t("license.admin.plan.deleteHint", { name: confirmDelete?.name || "" })}</p>
            </Modal>
        </div>
    );
}

/* ---------------- 设置 ---------------- */

function SettingsTab({ token }: { token: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [settings, setSettings] = useState<AdminSettings | null>(null);
    const [smtp, setSmtp] = useState(false);
    const [domains, setDomains] = useState("");
    const [saving, setSaving] = useState(false);
    const [testTo, setTestTo] = useState("");
    const [testing, setTesting] = useState(false);

    useEffect(() => {
        void (async () => {
            try {
                const data = await adminGetSettings(token);
                setSettings(data.settings);
                setSmtp(data.smtpConfigured);
                setDomains((data.settings.emailDomains || []).join("\n"));
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("license.admin.loadFailed"));
            }
        })();
    }, [message, t, token]);

    const testMail = async () => {
        setTesting(true);
        try {
            const result = await adminTestMail(token, testTo);
            message.success(t("license.admin.testMail.ok", { ms: result.ms }));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.loadFailed"));
        } finally {
            setTesting(false);
        }
    };

    const save = async () => {
        if (!settings) return;
        setSaving(true);
        try {
            const result = await adminPutSettings(token, {
                ...settings,
                emailDomains: domains.split(/[\s,;、]+/).map((item) => item.trim()).filter(Boolean),
            });
            setSettings(result.settings);
            setDomains((result.settings.emailDomains || []).join("\n"));
            message.success(t("license.admin.saved"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.saveFailed"));
        } finally {
            setSaving(false);
        }
    };

    if (!settings) {
        return (
            <div className="flex items-center gap-2 py-10 text-xs text-stone-500">
                <Loader2 className="size-4 animate-spin" />
                {t("license.admin.loading")}
            </div>
        );
    }

    return (
        <div className="space-y-4">
            <Section title={t("license.admin.settings.mode")} hint={t("license.admin.settings.modeHint")}>
                <div className="space-y-3">
                    <ToggleRow
                        label={t("license.admin.settings.paywall")}
                        hint={t("license.admin.settings.paywallHint")}
                        checked={settings.paywallEnabled}
                        onChange={(checked) => setSettings({ ...settings, paywallEnabled: checked })}
                    />
                    <ToggleRow
                        label={t("license.admin.settings.requireCode")}
                        hint={smtp ? t("license.admin.settings.requireCodeHint") : t("license.admin.settings.requireCodeNoSmtp")}
                        checked={settings.requireEmailCode}
                        onChange={(checked) => setSettings({ ...settings, requireEmailCode: checked })}
                    />
                    <Field label={t("license.admin.settings.trialDays")} hint={t("license.admin.settings.trialDaysHint")}>
                        <Input type="number" min={0} max={365} value={settings.trialDays} onChange={(event) => setSettings({ ...settings, trialDays: Number(event.target.value) })} />
                    </Field>
                    <Field label={t("license.admin.settings.siteUrl")} hint={t("license.admin.settings.siteUrlHint")}>
                        <Input value={settings.siteUrl} onChange={(event) => setSettings({ ...settings, siteUrl: event.target.value })} placeholder="https://canvas.example.com" />
                    </Field>
                    <Field label={t("license.admin.settings.notice")} hint={t("license.admin.settings.noticeHint")}>
                        <Input.TextArea rows={2} value={settings.notice} onChange={(event) => setSettings({ ...settings, notice: event.target.value })} />
                    </Field>
                </div>
            </Section>

            <Section title={t("license.admin.settings.domains")} hint={t("license.admin.settings.domainsHint")}>
                <Input.TextArea rows={4} value={domains} onChange={(event) => setDomains(event.target.value)} placeholder={"qq.com\ngmail.com\n163.com"} />
            </Section>

            <Section title={t("license.admin.settings.epay")} hint={t("license.admin.settings.epayHint")}>
                <div className="grid gap-3 sm:grid-cols-2">
                    <Field label={t("license.admin.settings.gateway")}>
                        <Input value={settings.epay.gateway} onChange={(event) => setSettings({ ...settings, epay: { ...settings.epay, gateway: event.target.value } })} />
                    </Field>
                    <Field label={t("license.admin.settings.pid")}>
                        <Input value={settings.epay.pid} onChange={(event) => setSettings({ ...settings, epay: { ...settings.epay, pid: event.target.value } })} placeholder="1001" />
                    </Field>
                    <Field label={t("license.admin.settings.key")} hint={settings.epay.hasKey ? t("license.admin.settings.keySaved") : undefined}>
                        <Input.Password value={settings.epay.key} onChange={(event) => setSettings({ ...settings, epay: { ...settings.epay, key: event.target.value } })} placeholder={t("license.admin.settings.keyPlaceholder")} />
                    </Field>
                    <Field label={t("license.admin.settings.payType")}>
                        <Select
                            className="w-full"
                            value={settings.epay.type}
                            onChange={(value) => setSettings({ ...settings, epay: { ...settings.epay, type: value } })}
                            options={[
                                { value: "alipay", label: t("license.admin.settings.alipay") },
                                { value: "wxpay", label: t("license.admin.settings.wxpay") },
                            ]}
                        />
                    </Field>
                    <Field label={t("license.admin.settings.sitename")}>
                        <Input value={settings.epay.sitename} onChange={(event) => setSettings({ ...settings, epay: { ...settings.epay, sitename: event.target.value } })} />
                    </Field>
                </div>
            </Section>

            <Section title={t("license.admin.testMail.title")} hint={t("license.admin.testMail.hint")}>
                <div className="flex flex-wrap items-center gap-2">
                    <Input
                        className="w-64"
                        value={testTo}
                        onChange={(event) => setTestTo(event.target.value)}
                        placeholder={t("license.admin.testMail.placeholder")}
                    />
                    <button
                        type="button"
                        disabled={testing || !testTo}
                        onClick={() => void testMail()}
                        className="shrink-0 whitespace-nowrap rounded-md border border-stone-200 px-3 py-1 text-xs text-stone-700 disabled:opacity-60 dark:border-stone-700 dark:text-stone-200"
                    >
                        {testing ? <Loader2 className="mr-1 inline size-3 animate-spin" /> : null}
                        {t("license.admin.testMail.send")}
                    </button>
                    {!smtp ? <span className="text-[11px] text-amber-600 dark:text-amber-400">{t("license.admin.testMail.noSmtp")}</span> : null}
                </div>
            </Section>

            <div className="flex items-center gap-2">
                <button type="button" disabled={saving} onClick={() => void save()} className="inline-flex items-center gap-2 license-solid rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 disabled:opacity-60 dark:bg-stone-100 dark:text-stone-900 dark:hover:bg-white">
                    {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                    {t("license.admin.save")}
                </button>
                <span className="text-[11px] text-stone-400">{t("license.admin.settings.envHint")}</span>
            </div>
        </div>
    );
}

function Section({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
    return (
        <div className="rounded-xl border border-stone-200 bg-white p-4 dark:border-stone-800 dark:bg-stone-900">
            <h3 className="text-sm font-medium text-stone-800 dark:text-stone-100">{title}</h3>
            <p className="mt-1 text-[11px] leading-5 text-stone-500 dark:text-stone-400">{hint}</p>
            <div className="mt-3 space-y-3">{children}</div>
        </div>
    );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
    return (
        <label className="block">
            <span className="mb-1 block text-[11px] font-medium text-stone-600 dark:text-stone-300">{label}</span>
            {children}
            {hint ? <span className="mt-1 block text-[10px] leading-4 text-stone-400">{hint}</span> : null}
        </label>
    );
}

function ToggleRow({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (checked: boolean) => void }) {
    return (
        <div className="flex items-start justify-between gap-3">
            <div>
                <div className="text-xs font-medium text-stone-700 dark:text-stone-200">{label}</div>
                <div className="mt-0.5 text-[10px] leading-4 text-stone-400">{hint}</div>
            </div>
            <Switch checked={checked} onChange={onChange} />
        </div>
    );
}

/* ---------------- 用户 ---------------- */

function UsersTab({ token }: { token: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [keyword, setKeyword] = useState("");
    const [users, setUsers] = useState<AdminUser[]>([]);
    const [total, setTotal] = useState(0);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        async (query = keyword) => {
            setLoading(true);
            try {
                const data = await adminListUsers(token, query);
                setUsers(data.users);
                setTotal(data.total);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("license.admin.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [keyword, message, t, token],
    );

    useEffect(() => {
        void load("");
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [token]);

    const act = async (user: AdminUser, action: "activate" | "disable" | "enable" | "reset-trial", days?: number) => {
        try {
            await adminUserAction(token, user.id, action, days);
            message.success(t("license.admin.userUpdated"));
            void load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.saveFailed"));
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="inline-flex items-center gap-1.5 text-sm font-medium text-stone-700 dark:text-stone-200">
                    <Users className="size-4" />
                    {t("license.admin.tabs.users")}
                    <span className="text-[11px] font-normal text-stone-400">{total}</span>
                </h2>
                <div className="flex items-center gap-2">
                    <Input size="small" className="w-56" value={keyword} onChange={(event) => setKeyword(event.target.value)} onPressEnter={() => void load()} placeholder={t("license.admin.searchUser")} prefix={<Search className="size-3.5 text-stone-400" />} allowClear />
                    <button type="button" className="shrink-0 whitespace-nowrap rounded-md border border-stone-200 px-2.5 py-1 text-xs text-stone-700 dark:border-stone-700 dark:text-stone-200" onClick={() => void load()}>
                        {t("license.admin.search")}
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
                <table className="w-full min-w-[860px] text-left text-xs">
                    <thead className="bg-stone-50 text-[11px] text-stone-500 dark:bg-stone-800/60 dark:text-stone-400">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("license.admin.user.email")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.user.state")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.user.until")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.user.createdAt")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.user.orders")}</th>
                            <th className="px-3 py-2 text-right font-medium">{t("license.admin.actions")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {users.map((user) => (
                            <tr key={user.id} className="border-t border-stone-100 dark:border-stone-800">
                                <td className="px-3 py-2 font-medium text-stone-900 dark:text-stone-100">{user.email}</td>
                                <td className="px-3 py-2">
                                    <StateBadge state={user.license.state} disabled={user.status === "disabled"} />
                                </td>
                                <td className="px-3 py-2 text-stone-500 dark:text-stone-400">{fmt(user.license.until)}</td>
                                <td className="px-3 py-2 text-stone-500 dark:text-stone-400">{fmt(user.createdAt)}</td>
                                <td className="px-3 py-2">{user.paidOrders}</td>
                                <td className="px-3 py-2 text-right">
                                    <button type="button" className="rounded-md px-2 py-1 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10" onClick={() => void act(user, "activate", 31)}>
                                        {t("license.admin.user.activate31")}
                                    </button>
                                    <button type="button" className="rounded-md px-2 py-1 text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-stone-800" onClick={() => void act(user, "reset-trial")}>
                                        {t("license.admin.user.resetTrial")}
                                    </button>
                                    <button
                                        type="button"
                                        className="rounded-md px-2 py-1 text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
                                        onClick={() => void act(user, user.status === "disabled" ? "enable" : "disable")}
                                    >
                                        {user.status === "disabled" ? t("license.admin.user.enable") : t("license.admin.user.disable")}
                                    </button>
                                </td>
                            </tr>
                        ))}
                        {users.length === 0 && !loading ? (
                            <tr>
                                <td colSpan={6} className="px-3 py-6 text-center text-stone-400">
                                    {t("license.admin.empty")}
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
            {loading ? (
                <div className="flex items-center gap-2 text-xs text-stone-400">
                    <Loader2 className="size-3.5 animate-spin" />
                    {t("license.admin.loading")}
                </div>
            ) : null}
        </div>
    );
}

function StateBadge({ state, disabled }: { state: string; disabled?: boolean }) {
    const { t } = useTranslation();
    const map: Record<string, string> = {
        trial: "bg-sky-50 text-sky-700 dark:bg-sky-500/10 dark:text-sky-300",
        active: "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300",
        expired: "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300",
        disabled: "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300",
    };
    const key = disabled ? "disabled" : state;
    return <span className={cn("rounded-full px-2 py-0.5 text-[10px]", map[key] || "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400")}>{t(`license.state.${key}`, { defaultValue: key })}</span>;
}

/* ---------------- 订单 ---------------- */

function OrdersTab({ token }: { token: string }) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [status, setStatus] = useState("");
    const [orders, setOrders] = useState<AdminOrder[]>([]);
    const [loading, setLoading] = useState(false);

    const load = useCallback(
        async (next = status) => {
            setLoading(true);
            try {
                setOrders((await adminListOrders(token, next)).orders);
            } catch (error) {
                message.error(error instanceof Error ? error.message : t("license.admin.loadFailed"));
            } finally {
                setLoading(false);
            }
        },
        [message, status, t, token],
    );

    useEffect(() => {
        void load(status);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [status, token]);

    const markPaid = async (order: AdminOrder) => {
        try {
            await adminMarkPaid(token, order.outTradeNo);
            message.success(t("license.admin.orderMarked"));
            void load();
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("license.admin.saveFailed"));
        }
    };

    return (
        <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-sm font-medium text-stone-700 dark:text-stone-200">{t("license.admin.tabs.orders")}</h2>
                <div className="flex items-center gap-2">
                    <Select
                        size="small"
                        className="w-32"
                        value={status}
                        onChange={(value) => setStatus(value)}
                        options={[
                            { value: "", label: t("license.admin.order.all") },
                            { value: "paid", label: t("license.admin.order.paid") },
                            { value: "pending", label: t("license.admin.order.pending") },
                        ]}
                    />
                    <button type="button" className="rounded-md border border-stone-200 px-2 py-1 text-xs dark:border-stone-700" onClick={() => void load()}>
                        <RefreshCw className={cn("size-3", loading ? "animate-spin" : "")} />
                    </button>
                </div>
            </div>

            <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white dark:border-stone-800 dark:bg-stone-900">
                <table className="w-full min-w-[860px] text-left text-xs">
                    <thead className="bg-stone-50 text-[11px] text-stone-500 dark:bg-stone-800/60 dark:text-stone-400">
                        <tr>
                            <th className="px-3 py-2 font-medium">{t("license.admin.order.no")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.user.email")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.order.plan")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.order.money")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.order.status")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.order.createdAt")}</th>
                            <th className="px-3 py-2 font-medium">{t("license.admin.order.paidAt")}</th>
                            <th className="px-3 py-2 text-right font-medium">{t("license.admin.actions")}</th>
                        </tr>
                    </thead>
                    <tbody>
                        {orders.map((order) => (
                            <tr key={order.outTradeNo} className="border-t border-stone-100 dark:border-stone-800">
                                <td className="px-3 py-2 font-mono text-[11px] text-stone-500 dark:text-stone-400">{order.outTradeNo}</td>
                                <td className="px-3 py-2">{order.email}</td>
                                <td className="px-3 py-2">
                                    {order.planName} <span className="text-stone-400">/ {order.days}d</span>
                                </td>
                                <td className="px-3 py-2">¥{order.money}</td>
                                <td className="px-3 py-2">
                                    <span className={cn("rounded-full px-2 py-0.5 text-[10px]", order.status === "paid" ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-300")}>
                                        {order.status === "paid" ? t("license.admin.order.paid") : t("license.admin.order.pending")}
                                    </span>
                                </td>
                                <td className="px-3 py-2 text-stone-500 dark:text-stone-400">{fmt(order.createdAt)}</td>
                                <td className="px-3 py-2 text-stone-500 dark:text-stone-400">{fmt(order.paidAt)}</td>
                                <td className="px-3 py-2 text-right">
                                    {order.status !== "paid" ? (
                                        <button type="button" className="rounded-md px-2 py-1 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-500/10" onClick={() => void markPaid(order)}>
                                            {t("license.admin.order.markPaid")}
                                        </button>
                                    ) : (
                                        <span className="text-stone-300 dark:text-stone-600">-</span>
                                    )}
                                </td>
                            </tr>
                        ))}
                        {orders.length === 0 && !loading ? (
                            <tr>
                                <td colSpan={8} className="px-3 py-6 text-center text-stone-400">
                                    {t("license.admin.empty")}
                                </td>
                            </tr>
                        ) : null}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
