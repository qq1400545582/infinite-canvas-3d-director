/**
 * 桌面端安装包下载地址解析。
 *
 * 地址一律不写死，按以下优先级自动判定当前运行环境：
 *   1. 构建期环境变量 `VITE_DESKTOP_DOWNLOAD_URL`（自建服务器 / 网盘 / 任意直链，支持站内路径）；
 *   2. 运行时解析最新 GitHub Release 里的安装包直链（版本与文件名变化都无需改代码）；
 *   3. 两者都不可用时，回退到发布页（调用方负责跳转），绝不产生 404 死链。
 *
 * 默认仓库与 desktop/package.json 的 build.publish 保持一致。
 */

/** 构建期显式指定的安装包地址；留空则自动解析。 */
export const DESKTOP_DOWNLOAD_URL = (import.meta.env.VITE_DESKTOP_DOWNLOAD_URL || "").trim();

/** 存放桌面端安装包的仓库（owner/repo），可用环境变量覆盖以指向自己的 fork。 */
export const DESKTOP_RELEASES_REPO = (import.meta.env.VITE_DESKTOP_RELEASES_REPO || "qq1400545582/infinite-canvas-3d-director").trim();

/** 发布页：任何时候都能打开，作为直链不可用时的兜底入口。 */
export const DESKTOP_RELEASES_PAGE_URL = `https://github.com/${DESKTOP_RELEASES_REPO}/releases`;

const RELEASES_API_URL = `https://api.github.com/repos/${DESKTOP_RELEASES_REPO}/releases/latest`;
const INSTALLER_PATTERN = /\.(exe|msi|dmg|pkg|AppImage|deb)$/i;
const RESOLVE_TIMEOUT_MS = 8000;

type ReleaseAsset = { name?: string; browser_download_url?: string };

/** 只接受看起来像安装包的资源，且必须是 http(s) 直链（协议白名单，避免被注入 javascript: 之类）。 */
function pickInstallerUrl(assets: ReleaseAsset[]): string | null {
    for (const asset of assets) {
        const url = (asset.browser_download_url || "").trim();
        if (!INSTALLER_PATTERN.test(asset.name || "") || !/^https?:\/\//i.test(url)) continue;
        return url;
    }
    return null;
}

async function fetchLatestInstallerUrl(): Promise<string | null> {
    if (DESKTOP_DOWNLOAD_URL) return DESKTOP_DOWNLOAD_URL;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
        const res = await fetch(RELEASES_API_URL, {
            headers: { Accept: "application/vnd.github+json" },
            signal: controller.signal,
        });
        // 404 = 还没发布过 Release；403 = 匿名配额用尽。都当作「暂无直链」，由调用方回退发布页。
        if (!res.ok) return null;
        const data = (await res.json()) as { assets?: ReleaseAsset[] };
        return pickInstallerUrl(Array.isArray(data?.assets) ? data.assets : []);
    } catch {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

let pending: Promise<string | null> | null = null;

/**
 * 解析安装包直链：命中返回 URL，否则返回 null（调用方应回退到发布页）。
 * 结果（含「未找到」）在会话内缓存，最多只发一次网络请求。
 */
export function resolveDesktopDownloadUrl(): Promise<string | null> {
    if (!pending) pending = fetchLatestInstallerUrl();
    return pending;
}

/** 页面挂载后预热，用户点击时通常已就绪；失败静默，点击时会再走一次缓存结果。 */
export function prefetchDesktopDownloadUrl(): void {
    void resolveDesktopDownloadUrl();
}

/**
 * 触发浏览器下载。同源链接用 `download` 属性直接落盘；
 * 跨源（GitHub Release / CDN）由服务端 Content-Disposition 决定，浏览器会下载而非跳走。
 */
export function triggerDesktopDownload(url: string): void {
    const anchor = document.createElement("a");
    anchor.href = url;
    try {
        if (new URL(url, window.location.href).origin === window.location.origin) anchor.download = "";
    } catch {
        // 非法 URL 交给浏览器处理，不阻断下载尝试。
    }
    anchor.rel = "noopener";
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
}
