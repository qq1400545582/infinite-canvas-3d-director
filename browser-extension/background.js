/**
 * 扩展后台（MV3 service worker）：右键菜单 + 本机文件批量发送 + 转发到本机 Canvas Agent。
 *
 * 发送链路：浏览器 → 本机 Agent `POST /api/tools { name: "canvas_create_node" }` →
 * Agent 把建节点操作推给当前已连接的画布页面执行 → 画布出现图片/视频节点。
 * 图片发送前会先抓下来转成 dataURL 内嵌（防外链防盗链在画布页面加载失败），失败降级外链；
 * 本机文件由 popup / 内容脚本转成 dataURL 后送来这里（MV3 service worker 没有 FileReader）。
 * 本机 Agent 的 CORS 逻辑会把「带正确 token 的新来源」自动加入白名单，故无需额外服务端改造。
 */

importScripts("./media.js");

const DEFAULTS = { baseUrl: "http://127.0.0.1:17371", token: "", hoverButton: true };

function getConfig() {
    return chrome.storage.sync.get(DEFAULTS);
}

function normalizeBase(value) {
    return String(value || DEFAULTS.baseUrl).trim().replace(/\/+$/, "") || DEFAULTS.baseUrl;
}

/** 把 Agent / 网络层的失败翻译成一句人话。 */
function humanError(status, message) {
    const text = String(message || "");
    if (status === 401) return "Token 无效，请在扩展选项里重新填写 Canvas Agent 连接 Token";
    if (!status) return "连不上本机 Canvas Agent，请确认画布页面的智能体已连接（或点「一键启动 Canvas Agent」）";
    if (text.includes("已连接画布") || text.includes("已连接网页")) return "请先打开一个画布页面并保持连接，再发送";
    return text || `发送失败（HTTP ${status}）`;
}

/** 把 fetchImageAsDataUrl 的失败原因翻译成人话（用于降级提示）。 */
function inlineFailReason(reason) {
    const map = {
        "fetch-failed": "网络抓取失败",
        "too-large": "图片超过 5MB",
        "not-image": "返回内容不是图片",
        "read-failed": "图片解码失败",
        "unsupported-scheme": "地址类型不支持",
    };
    if (map[reason]) return map[reason];
    if (/^http-\d+$/.test(String(reason))) return `图源拒绝访问（HTTP ${String(reason).slice(5)}）`;
    return String(reason || "未知原因");
}

/** 成功发送后的附加说明：媒体是否已内嵌；降级时说明原因，让「画布空白 / 视频黑屏」可自诊断。 */
function successNote(media, inline) {
    const version = `v${chrome.runtime.getManifest().version}`;
    const label = media.kind === "video" ? "视频" : "原图";
    if (inline.inlined) return `（${label}已内嵌 ${version}）`;
    if (inline.skipped) return `（${version} ${media.kind === "video" ? "视频" : "图片"}外链直发）`;
    return `（${version} 未能内嵌${label}：${inlineFailReason(inline.reason)}，已按外链发送，画布可能${media.kind === "video" ? "黑屏" : "空白"}）`;
}

/**
 * 媒体转存：把外链图片 / 视频抓下来内嵌成 dataURL（metadata.content）。
 * 根因：外链在画布页面（本地来源）加载可能被防盗链/广告拦截/网络策略拒绝，节点建成但内容空白（视频则是黑屏）；
 * 扩展后台有 <all_urls> host_permissions，fetch 不受 CORS 且不带页面 Referer，能拿到媒体本身。
 * 转存失败（超限 / 403 / 网络错误等）就保持原样发外链，并把原因带回给页面提示。
 * 体积上限：图片 5MB、视频 8MB（dataURL 有 4/3 膨胀，内嵌后约 6.7MB / 10.7MB，远低于 Agent 的 30MB 请求体上限）。
 */
async function inlineImageIfPossible(media) {
    if (media.kind !== "image" && media.kind !== "video") return { inlined: false, skipped: true };
    if (media.dataUrl) return { inlined: true };
    if (!/^https?:/i.test(String(media.url || ""))) return { inlined: false, skipped: true };
    const result = await ICMedia.fetchMediaAsDataUrl(media.kind, media.url);
    if (!result.ok) return { inlined: false, reason: result.reason };
    media.dataUrl = result.dataUrl;
    // 页面给的宽高缺失时，用解码出的真实尺寸补齐，节点比例更准（视频不解码，沿用 DOM 的 videoWidth/Height）。
    if ((!Number(media.width) || !Number(media.height)) && result.width && result.height) {
        media.width = result.width;
        media.height = result.height;
    }
    if (result.mimeType && !media.mimeType) media.mimeType = result.mimeType;
    return { inlined: true };
}

async function sendToCanvas(media) {
    const config = await getConfig();
    if (!config.token) throw new Error("尚未配置 Token：点击扩展图标 → 选项，填写 Canvas Agent 连接 Token");
    if (!media?.url && !media?.dataUrl) throw new Error("没有拿到媒体地址");
    if (ICMedia.isUnsendableUrl(media.url) && !media.dataUrl) {
        throw new Error(
            media.kind === "video"
                ? "该视频是页面内部的临时地址（blob:），发送后无法播放；请改用视频的原始直链"
                : "该图片是页面内部的临时地址（blob:），当前页面无法读取；请在原图页右键另存后从画布导入",
        );
    }

    const inline = await inlineImageIfPossible(media);
    const payload = ICMedia.buildCreateNodePayload(media);
    const base = normalizeBase(config.baseUrl);
    let response;
    try {
        response = await fetch(`${base}/api/tools?token=${encodeURIComponent(config.token)}`, {
            method: "POST",
            headers: { "content-type": "application/json", "x-canvas-agent-token": config.token },
            body: JSON.stringify(payload),
        });
    } catch {
        throw new Error(humanError(0, ""));
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(humanError(response.status, data.error));
    return { result: data.result, note: successNote(media, inline) };
}

/** 把结果回传给发起页面（悬浮按钮 / popup），失败时带上可读原因。 */
async function notify(tabId, result) {
    if (!tabId) return;
    try {
        await chrome.tabs.sendMessage(tabId, { type: "ic-send-result", ...result });
    } catch {
        /* 页面未注入内容脚本（chrome:// 等）时忽略，结果由后台通知兜底 */
    }
}

/** 单次批量发送的文件数上限：dataURL 内嵌后请求体很容易顶到 Agent 的 30MB 上限。 */
const MAX_BATCH_FILES = 20;

/** 本机文件跳过原因 → 人话提示。 */
function fileSkipReason(reason) {
    const map = {
        "file-too-large": "超过体积上限（图片 5MB / 视频 8MB）",
        "unsupported-file": "不是图片或视频，画布没有对应节点",
        "read-failed": "文件读取失败",
    };
    return map[reason] || String(reason || "未知原因");
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type !== "ic-send-media" && message?.type !== "ic-send-files") return;
    (async () => {
        try {
            if (message.type === "ic-send-media") {
                const { note } = await sendToCanvas(message.media);
                await notify(sender.tab?.id, { ok: true, note });
                sendResponse({ ok: true, note });
                return;
            }
            // 批量（本机文件 / 弹窗多选）：逐个发送，单个失败不阻断其余。
            const list = Array.isArray(message.media) ? message.media : [];
            const skipped = list.filter((item) => item?.skipReason);
            const sendable = list.filter((item) => item && !item.skipReason);
            if (sendable.length > MAX_BATCH_FILES) {
                sendResponse({ ok: false, reason: `一次最多发送 ${MAX_BATCH_FILES} 个文件，当前 ${sendable.length} 个，请分批选择` });
                return;
            }
            let sent = 0;
            let lastNote = "";
            let firstError = "";
            for (const media of sendable) {
                try {
                    const result = await sendToCanvas(media);
                    sent += 1;
                    if (result.note) lastNote = result.note;
                } catch (error) {
                    if (!firstError) firstError = error instanceof Error ? error.message : String(error);
                }
            }
            const summary = { ok: sent > 0 || list.length === 0, sent, total: list.length, skipped: skipped.map((item) => ({ title: item.title || "", reason: fileSkipReason(item.skipReason) })), note: lastNote, reason: firstError };
            if (sent > 0) await notify(sender.tab?.id, { ok: true, ...summary });
            else await notify(sender.tab?.id, { ok: false, reason: firstError || "没有可发送的文件" });
            sendResponse(summary);
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            await notify(sender.tab?.id, { ok: false, reason });
            sendResponse({ ok: false, reason });
        }
    })();
    return true; // 保持消息通道，等待异步响应
});

chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({ id: "ic-send-image", title: "发送这张图片到无限画布", contexts: ["image"] });
        chrome.contextMenus.create({ id: "ic-send-video", title: "发送这个视频到无限画布", contexts: ["video"] });
        chrome.contextMenus.create({
            id: "ic-send-link",
            title: "发送这个链接的图片/视频到无限画布",
            contexts: ["link"],
            targetUrlPatterns: ["*://*/*.png*", "*://*/*.jpg*", "*://*/*.jpeg*", "*://*/*.webp*", "*://*/*.gif*", "*://*/*.mp4*", "*://*/*.webm*"],
        });
    });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const url = info.srcUrl || info.linkUrl || "";
    if (!url) return;
    const isVideo = info.menuItemId === "ic-send-video" || /\.(?:mp4|webm|mov|m4v)(?:\?|#|$)/i.test(url);
    try {
        const { note } = await sendToCanvas({ kind: isVideo ? "video" : "image", url, pageUrl: info.pageUrl || tab?.url || "", mimeType: isVideo ? "video/mp4" : undefined });
        await notify(tab?.id, { ok: true, note });
    } catch (error) {
        await notify(tab?.id, { ok: false, reason: error instanceof Error ? error.message : String(error) });
    }
});
