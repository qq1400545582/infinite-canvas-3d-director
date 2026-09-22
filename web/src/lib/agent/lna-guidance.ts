/**
 * Local Network Access（LNA）引导检测（P1b）
 *
 * 网页版（部署在公网，例如 *.pages.dev）连接本机 canvas-agent（http://127.0.0.1:17371）
 * 时，Chrome / Edge 142+ 会弹「私有网络访问」授权框。若用户未授权或用的不是 Chromium 内核浏览器，
 * fetch 会以网络错误（TypeError: Failed to fetch）静默失败，用户只看到"连接失败"却不知道原因。
 *
 * 本模块提供一个纯函数判断「当前连接失败是否是 LNA 拦截导致的」，供连接面板在错误区下方追加引导文案。
 */

function isLoopback(hostname: string): boolean {
    return hostname === "127.0.0.1" || hostname === "::1" || hostname === "localhost" || hostname === "[::1]";
}

/**
 * 当目标地址是本机回环地址、而当前页面本身不在本机（公网 / 局域网部署）时，
 * 浏览器会强制走 LNA 授权流程；未授权即连接失败，基本可确定是 LNA 拦截。
 */
export function isLikelyLocalNetworkAccessBlocked(targetUrl: string): boolean {
    try {
        const target = new URL(targetUrl);
        if (!isLoopback(target.hostname)) return false;
        const pageHost = window.location.hostname;
        // 页面也在本机：不需要 LNA，失败另有原因。
        if (isLoopback(pageHost)) return false;
        return true;
    } catch {
        return false;
    }
}

/** 当前浏览器是否可能是 Chromium 内核（Chrome / Edge / 大部分国产双核）。 */
export function isLikelyChromium(): boolean {
    const ua = navigator.userAgent;
    return /Chrome|Edg|Chromium/i.test(ua) || (!/Firefox|FxiOS/i.test(ua) && /Mozilla/i.test(ua));
}
