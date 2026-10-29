/**
 * 授权服务地址解析。
 *
 * 优先级：URL 参数 ?license_api= > 本地存储 > 构建期环境变量。
 * 之所以留 URL 参数与本地存储两条口子：自建服务的用户不必重新打包前端就能切换地址；
 * 也方便自检（打开 xxx/?license_api=http://127.0.0.1:8787 直接连本地服务）。
 */
export const LICENSE_API_STORAGE_KEY = "infinite-canvas:license_api";

const ENV_BASE = (import.meta.env.VITE_LICENSE_API as string | undefined)?.trim() || "";
/** 构建期强制要求登录（即使没配服务地址，也显示配置引导而不是直接放行）。 */
export const LICENSE_REQUIRED = String(import.meta.env.VITE_LICENSE_REQUIRED || "") === "1";

function readStorage(): string {
    try {
        return localStorage.getItem(LICENSE_API_STORAGE_KEY) || "";
    } catch {
        return "";
    }
}

function readQuery(): string {
    try {
        const value = new URLSearchParams(window.location.search).get("license_api") || "";
        if (value) {
            localStorage.setItem(LICENSE_API_STORAGE_KEY, value.replace(/\/+$/, ""));
            return value.replace(/\/+$/, "");
        }
    } catch {
        /* 忽略：某些沙箱环境禁用 URL 解析 */
    }
    return "";
}

export function licenseApiBase(): string {
    return (readQuery() || readStorage() || ENV_BASE).replace(/\/+$/, "");
}

export function setLicenseApiBase(value: string) {
    try {
        const next = value.trim().replace(/\/+$/, "");
        if (next) localStorage.setItem(LICENSE_API_STORAGE_KEY, next);
        else localStorage.removeItem(LICENSE_API_STORAGE_KEY);
    } catch {
        /* 忽略 */
    }
}

/** 是否启用授权体系：配置了服务地址，或构建期要求强制登录。 */
export function licenseEnabled(): boolean {
    return Boolean(licenseApiBase()) || LICENSE_REQUIRED;
}

/** 允许的邮箱域名展示分组（仅用于登录页提示，真实白名单由服务端下发）。 */
export function domainHint(domains: string[]): string {
    const known = ["qq.com", "foxmail.com", "gmail.com", "163.com", "126.com", "sina.com", "sohu.com", "outlook.com", "icloud.com"];
    const hit = known.filter((item) => domains.includes(item));
    return (hit.length ? hit : domains).slice(0, 6).join(" / ");
}
