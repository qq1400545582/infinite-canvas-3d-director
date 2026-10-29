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

export type PayType = { code: string; name: string };

export type PublicSettings = {
    paywallEnabled: boolean;
    trialDays: number;
    emailDomains: string[];
    requireEmailCode: boolean;
    registerEnabled: boolean;
    entitlements: string[];
    notice: string;
    siteUrl: string;
    supportEmail: string;
    /** 后台勾选开放的支付方式（可能同时有支付宝、微信、云闪付等）。 */
    payTypes: PayType[];
    defaultPayType: string;
    /** 商户号 / 密钥是否已配置；未配置时下单会返回 503。 */
    payConfigured: boolean;
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

export type PayOrderResult = {
    outTradeNo: string;
    /**
     * qr       = 已在服务端拿到二维码内容，页面内直接展示
     * scheme   = 只能唤起小程序（打开链接支付）
     * redirect = 支付平台没给二维码，退回收银台跳转
     */
    mode: "qr" | "scheme" | "redirect";
    qrContent: string;
    /** 服务端生成的 SVG data URI，可直接塞进 <img src>。 */
    qrSvg: string;
    payUrl: string;
    urlScheme: string;
    notice: string;
    money: string;
    planName: string;
    payType: string;
    payTypeName: string;
};

export function createOrder(token: string, planId: string, type?: string) {
    return request<PayOrderResult>("/api/pay/create", {
        method: "POST",
        body: { planId, type },
        token,
        timeoutMs: 30000,
    });
}

export function fetchOrder(token: string, outTradeNo: string) {
    return request<{ order: { outTradeNo: string; planName: string; days: number; money: string; status: string; paidAt: string | null }; user: LicenseUser }>(
        `/api/pay/order/${encodeURIComponent(outTradeNo)}`,
        { token },
    );
}

/*
 * 运营后台（发信 / 支付 / 会员权限 / 套餐 / 用户 / 订单）由授权服务自己托管，
 * 入口是 <授权服务域名>/admin；本应用不再内置后台页面，也不再发任何后台请求。
 */
