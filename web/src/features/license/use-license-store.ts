import { create } from "zustand";
import { persist } from "zustand/middleware";

import { fetchMe, fetchPublicSettings, LicenseApiError, type LicensePlan, type LicenseUser, type PublicSettings } from "./api";
import { licenseApiBase, licenseEnabled, setLicenseApiBase } from "./config";

/**
 * 登录态与授权状态。
 *
 * 只持久化 token 与上次成功同步的 user / 时间：
 * - 刷新页面先用缓存里的 user 立即渲染，避免白屏等待接口；
 * - 接口成功后覆盖；接口失败（离线）时按 lastSyncAt 判断是否还在宽限期内。
 *
 * 判断“能不能用”永远以服务端返回的 license 为准，前端计算只做展示（防篡改靠服务端）。
 */

export type LicensePhase = "idle" | "checking" | "ready" | "error";

type LicenseStore = {
    token: string;
    user: LicenseUser | null;
    settings: PublicSettings | null;
    plans: LicensePlan[];
    lastSyncAt: number;
    phase: LicensePhase;
    error: string;
    /** 离线宽限：接口失败但最近一次同步仍在有效期内时，标记为离线可用 */
    offline: boolean;
    apiBase: string;

    setApiBase: (value: string) => void;
    setSession: (token: string, user: LicenseUser) => void;
    patchUser: (user: LicenseUser) => void;
    signOut: () => void;
    loadPublic: () => Promise<void>;
    refresh: () => Promise<void>;
    check: () => Promise<void>;
};

/** 离线宽限窗口：服务端连续不可达时，最多允许使用 24 小时，之后必须联网校验。 */
const OFFLINE_GRACE_MS = 24 * 60 * 60 * 1000;

export const useLicenseStore = create<LicenseStore>()(
    persist(
        (set, get) => ({
            token: "",
            user: null,
            settings: null,
            plans: [],
            lastSyncAt: 0,
            phase: "idle",
            error: "",
            offline: false,
            apiBase: licenseApiBase(),

            setApiBase: (value) => {
                setLicenseApiBase(value);
                set({ apiBase: licenseApiBase(), phase: "idle", error: "" });
            },

            setSession: (token, user) => set({ token, user, lastSyncAt: Date.now(), phase: "ready", error: "", offline: false }),

            patchUser: (user) => set({ user, lastSyncAt: Date.now() }),

            signOut: () => set({ token: "", user: null, phase: "idle", error: "", offline: false, lastSyncAt: 0 }),

            loadPublic: async () => {
                if (!licenseEnabled()) return;
                try {
                    const data = await fetchPublicSettings();
                    set({ settings: data.settings, plans: data.plans });
                } catch {
                    /* 公开配置失败不阻断，页面会提示服务地址不可用 */
                }
            },

            refresh: async () => {
                const token = get().token;
                if (!token) return;
                const data = await fetchMe(token);
                set({ user: data.user, settings: data.settings, lastSyncAt: Date.now(), phase: "ready", error: "", offline: false });
            },

            check: async () => {
                if (!licenseEnabled()) {
                    set({ phase: "ready" });
                    return;
                }
                const { token } = get();
                if (!token) {
                    set({ phase: "ready", user: null });
                    void get().loadPublic();
                    return;
                }
                set({ phase: get().user ? get().phase : "checking" });
                try {
                    const data = await fetchMe(token);
                    set({ user: data.user, settings: data.settings, lastSyncAt: Date.now(), phase: "ready", error: "", offline: false });
                } catch (error) {
                    if (error instanceof LicenseApiError) {
                        // 401/403 是明确的“无权”，必须退出；网络类错误才走离线宽限
                        if (error.status === 401) {
                            set({ token: "", user: null, phase: "ready", error: error.message, offline: false });
                            return;
                        }
                        if (error.status === 403) {
                            set({ phase: "error", error: error.message, offline: false });
                            return;
                        }
                        const { lastSyncAt, user } = get();
                        if (user && Date.now() - lastSyncAt < OFFLINE_GRACE_MS) {
                            set({ phase: "ready", offline: true, error: error.message });
                            return;
                        }
                        set({ phase: "error", error: error.message, offline: false });
                        return;
                    }
                    set({ phase: "error", error: "授权服务不可用", offline: false });
                }
            },
        }),
        {
            name: "infinite-canvas:license",
            partialize: (state) => ({ token: state.token, user: state.user, lastSyncAt: state.lastSyncAt }),
        },
    ),
);

/** 距离授权到期还有多久（天，向上取整到 1 位小数）。 */
export function daysLeft(user: LicenseUser | null): number | null {
    const until = user?.license?.until;
    if (!until) return null;
    const diff = new Date(until).getTime() - Date.now();
    if (!Number.isFinite(diff) || diff <= 0) return 0;
    return Math.max(0, Math.round((diff / 86400000) * 10) / 10);
}

/** 当前是否可直接使用（试用中 / 已付费 / 免费模式）。 */
export function licenseUsable(user: LicenseUser | null): boolean {
    if (!user) return false;
    return user.license.state === "trial" || user.license.state === "active";
}
