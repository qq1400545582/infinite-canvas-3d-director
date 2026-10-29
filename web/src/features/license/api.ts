/**
 * 授权服务 API 客户端。
 * 所有请求都带超时与统一错误解析：服务端返回 {ok:false,error:{code,message}}。
 */
import { licenseApiBase } from "./config";

export type LicenseState = {
    state: "trial" | "active" | "expired" | "disabled" | "unknown";
    until?: string | null;
    free?: boolean;
};

export type LicenseUser = {
    id: string;
    email: string;
    createdAt: string;
    trialEndsAt: string | null;
    paidUntil: string | null;
    status: "normal" | "disabled";
    license: LicenseState;
};

export type PublicSettings = {
    paywallEnabled: boolean;
    trialDays: number;
    emailDomains: string[];
    requireEmailCode: boolean;
    notice: string;
    siteUrl: string;
    supportEmail: string;
};

export type LicensePlan = {
    id: string;
    name: string;
    days: number;
    price: string;
    originalPrice: string;
    desc: string;
    badge: string;
};

export type AdminPlan = LicensePlan & { active: boolean; sort: number };

export type AdminSettings = PublicSettings & {
    epay: { gateway: string; pid: string; key: string; type: string; sitename: string; hasKey?: boolean };
};

export type AdminOrder = {
    outTradeNo: string;
    email: string;
    planName: string;
    days: number;
    money: string;
    status: "pending" | "paid" | "closed";
    createdAt: string;
    paidAt: string | null;
    tradeNo: string;
};

export type AdminUser = LicenseUser & {
    lastLoginAt: string;
    note: string;
    paidOrders: number;
};

export class LicenseApiError extends Error {
    code: string;
    status: number;
    details?: Record<string, unknown>;

    constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
        super(message);
        this.status = status;
        this.code = code;
        this.details = details;
    }
}

type RequestOptions = {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
    token?: string;
    timeoutMs?: number;
};

async function request<T>(path: string, { method = "GET", body, token, timeoutMs = 15000 }: RequestOptions = {}): Promise<T> {
    const base = licenseApiBase();
    if (!base) throw new LicenseApiError(0, "no_api_base", "尚未配置授权服务地址");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${base}${path}`, {
            method,
            headers: {
                ...(body ? { "content-type": "application/json" } : {}),
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
            signal: controller.signal,
        });
        const text = await response.text();
        let payload: { ok?: boolean; data?: T; error?: { code?: string; message?: string } & Record<string, unknown> } | null = null;
        try {
            payload = text ? JSON.parse(text) : null;
        } catch {
            throw new LicenseApiError(response.status, "bad_response", `服务端返回了非 JSON 内容（HTTP ${response.status}）`);
        }
        if (!response.ok || !payload?.ok) {
            const error = payload?.error || {};
            throw new LicenseApiError(response.status, String(error.code || "request_failed"), String(error.message || `请求失败（HTTP ${response.status}）`), error);
        }
        return payload.data as T;
    } catch (error) {
        if (error instanceof LicenseApiError) throw error;
        if ((error as Error).name === "AbortError") throw new LicenseApiError(0, "timeout", "请求超时，请检查网络或服务地址");
        throw new LicenseApiError(0, "network_error", "无法连接授权服务，请检查网络或服务地址");
    } finally {
        clearTimeout(timer);
    }
}

/* ---------------- 用户端 ---------------- */

export function fetchPublicSettings() {
    return request<{ settings: PublicSettings; plans: LicensePlan[] }>("/api/settings");
}

export function sendRegisterCode(email: string) {
    return request<{ sent: boolean; devCode?: string }>("/api/auth/send-code", { method: "POST", body: { email } });
}

export function registerAccount(email: string, password: string, code: string) {
    return request<{ token: string; user: LicenseUser }>("/api/auth/register", { method: "POST", body: { email, password, code } });
}

export function loginAccount(email: string, password: string) {
    return request<{ token: string; user: LicenseUser }>("/api/auth/login", { method: "POST", body: { email, password } });
}

export function fetchMe(token: string) {
    return request<{ user: LicenseUser; settings: PublicSettings }>("/api/auth/me", { token });
}

export function createOrder(token: string, planId: string) {
    return request<{ outTradeNo: string; payUrl: string; money: string; planName: string }>("/api/pay/create", {
        method: "POST",
        body: { planId },
        token,
        timeoutMs: 20000,
    });
}

export function fetchOrder(token: string, outTradeNo: string) {
    return request<{ order: { outTradeNo: string; planName: string; days: number; money: string; status: string; paidAt: string | null }; user: LicenseUser }>(
        `/api/pay/order/${encodeURIComponent(outTradeNo)}`,
        { token },
    );
}

/* ---------------- 后台 ---------------- */

export function adminLogin(password: string) {
    return request<{ token: string; defaultPassword: boolean }>("/api/admin/login", { method: "POST", body: { password } });
}

export function adminOverview(token: string) {
    return request<{
        users: number;
        trialing: number;
        active: number;
        expired: number;
        disabled: number;
        orders: number;
        paidOrders: number;
        revenue: string;
        todaySignups: number;
        smtpConfigured: boolean;
        devEchoCode: boolean;
    }>("/api/admin/overview", { token });
}

export function adminGetSettings(token: string) {
    return request<{ settings: AdminSettings; smtpConfigured: boolean; devEchoCode: boolean; dbFile: string }>("/api/admin/settings", { token });
}

export function adminPutSettings(token: string, settings: Partial<AdminSettings>) {
    return request<{ settings: AdminSettings }>("/api/admin/settings", { method: "PUT", body: { settings }, token });
}

export function adminListPlans(token: string) {
    return request<{ plans: AdminPlan[] }>("/api/admin/plans", { token });
}

export function adminSavePlan(token: string, plan: Partial<AdminPlan>, id?: string) {
    return request<{ plan: AdminPlan; plans: AdminPlan[] }>(id ? `/api/admin/plans/${id}` : "/api/admin/plans", { method: id ? "PUT" : "POST", body: { plan }, token });
}

export function adminDeletePlan(token: string, id: string) {
    return request<{ deleted?: boolean; archived?: boolean; plans: AdminPlan[] }>(`/api/admin/plans/${id}`, { method: "DELETE", token });
}

export function adminListUsers(token: string, keyword = "") {
    return request<{ users: AdminUser[]; total: number }>(`/api/admin/users${keyword ? `?q=${encodeURIComponent(keyword)}` : ""}`, { token });
}

export function adminUserAction(token: string, id: string, action: "activate" | "disable" | "enable" | "reset-trial", days?: number) {
    return request<{ user: AdminUser }>(`/api/admin/users/${id}/action`, { method: "POST", body: { action, days }, token });
}

export function adminListOrders(token: string, status = "") {
    return request<{ orders: AdminOrder[] }>(`/api/admin/orders${status ? `?status=${status}` : ""}`, { token });
}

export function adminMarkPaid(token: string, outTradeNo: string) {
    return request<{ order: AdminOrder }>(`/api/admin/orders/${outTradeNo}/paid`, { method: "POST", token });
}
