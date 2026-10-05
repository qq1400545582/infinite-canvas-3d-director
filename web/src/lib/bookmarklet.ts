/**
 * 书签小工具（bookmarklet）的浏览器端生成器。
 *
 * 与 `browser-extension/make-bookmarklet.cjs` 生成的是同一种东西，压缩规则逐行一致，
 * 区别只在宿主：那边是 Node 脚本读本机配置产出 bookmarklet.html，这边在网页里
 * 用「自动发现到的 Token」实时生成，用户不用开终端、不用手工粘 Token。
 *
 * 脚本源码只有一份：`web/public/bookmarklet-src.js`（与 browser-extension 下那份字节一致，
 * 由 `.workbuddy/tmp/test-bookmarklet.mjs` 的一致性断言守护），网页通过 fetch 读取后压缩。
 */

/** 与 make-bookmarklet.cjs 相同的压缩规则：去块注释、去整行注释、逐行 trim 合并。 */
export function minifyBookmarkletSource(source: string) {
    return source
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\r/g, "")
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .join(" ")
        .replace(/\s{2,}/g, " ");
}

/** 把源码与本机地址/令牌合成可放进 href 的 `javascript:` URL。 */
export function buildBookmarkletHref(source: string, options: { base: string; token: string }) {
    const minified = minifyBookmarkletSource(source).replace(/__TOKEN__/g, options.token).replace(/__BASE__/g, options.base.replace(/\/+$/, ""));
    return `javascript:${encodeURIComponent(`(function(){${minified}})();`)}`;
}

/** 拉取脚本源码（public 目录随构建产物一起发布，路径与 base 无关）。 */
export async function fetchBookmarkletSource(url = "/bookmarklet-src.js") {
    const response = await fetch(url, { cache: "no-cache" });
    if (!response.ok) throw new Error(`读取书签脚本失败（HTTP ${response.status}）`);
    const text = await response.text();
    if (!text.includes("__TOKEN__") || !text.includes("__BASE__")) throw new Error("书签脚本内容异常");
    return text;
}

/**
 * 判断当前页面能不能安装书签。
 *
 * 关键事实：安装书签的**唯一**动作是「把链接拖到浏览器书签栏」，这是浏览器原生 UI。
 * 因此以下环境装了也白装：
 *   · 页面在 iframe / webview 里（各类桌面工具、IDE、聊天客户端的内置浏览器）——**没有书签栏可拖**；
 *   · Electron / WebView 内核——同一层原因。
 * 这类环境应该引导用户「在真正的浏览器里打开本页」，或改用发送台 / 扩展，而不是让用户反复拖一个注定失败的东西。
 */
export function detectBookmarkletEnvironment(input: { inFrame: boolean; userAgent: string }) {
    const ua = input.userAgent || "";
    const embedded = /electron|webview|cef|chrome\/\d+.*edg\/\d+.*(webview|desktop)/i.test(ua) || /\bElectron\b/i.test(ua);
    if (input.inFrame) return { installable: false as const, reason: "in-frame" as const };
    if (embedded) return { installable: false as const, reason: "embedded" as const };
    return { installable: true as const, reason: null };
}

