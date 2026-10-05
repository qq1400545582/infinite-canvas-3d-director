/**
 * 媒体→画布节点的纯逻辑（扩展后台、内容脚本、书签小工具共用）。
 *
 * 画布节点不在这边创建：本模块只负责把「网页上的一张图 / 一个视频」翻译成
 * 本机 Canvas Agent 的 `canvas_create_node` 工具调用参数，由 Agent 推给已连接的画布页面执行。
 * 图片 / 视频节点用 `metadata.content` 作为 src：视频放原始直链即可；图片优先放转存好的
 * dataURL（防盗链 / 签名外链在画布页面加载会 403 空白，见 fetchImageAsDataUrl），拿不到再退回外链。
 */

const ICMedia = (() => {
    const MAX_EDGE = 480;
    // 小于该尺寸的图（图标、缩略图）适当放大到能看清；大于 MAX_EDGE 的等比缩小。
    const MIN_EDGE = 240;
    // 单张图片转存 dataURL 的体积上限：dataURL 有 4/3 膨胀，5MB 内嵌后约 6.7MB，远低于 Agent 的 30MB 请求体上限。
    const MAX_INLINE_BYTES = 5 * 1024 * 1024;
    // 本机视频文件内嵌上限：视频节点的 <video src> 同样能吃 dataURL，但体积敏感，给 8MB（内嵌后约 10.7MB）。
    const MAX_VIDEO_INLINE_BYTES = 8 * 1024 * 1024;

    /** 相对地址按当前页面补全；data: / blob: 原样返回。 */
    function absUrl(url, base) {
        const value = String(url || "").trim();
        if (!value) return "";
        if (/^(?:data|blob):/i.test(value)) return value;
        try {
            return new URL(value, base || undefined).href;
        } catch {
            return value;
        }
    }

    /** 等比缩放到画布节点合适的尺寸：长边不超过 480，过小的图放大到长边 240，缺省 4:3。 */
    function fitNodeSize(width, height, maxEdge = MAX_EDGE, minEdge = MIN_EDGE) {
        const w = Number(width) || 0;
        const h = Number(height) || 0;
        if (w <= 0 || h <= 0) return { width: 360, height: 270 };
        const long = Math.max(w, h);
        const scale = long > maxEdge ? maxEdge / long : long < minEdge ? minEdge / long : 1;
        return { width: Math.round(w * scale), height: Math.round(h * scale) };
    }

    /** 从 URL 猜一个文件标题（用于画布节点标题）。 */
    function titleFromUrl(url, fallback) {
        try {
            const pathname = decodeURIComponent(new URL(url).pathname || "");
            const file = pathname.split("/").filter(Boolean).pop() || "";
            if (file && /\.[a-z0-9]{2,5}$/i.test(file)) return file.slice(0, 60);
        } catch {
            /* 相对或非标准地址时直接用兜底标题 */
        }
        return fallback;
    }

    /**
     * 构造 Agent 工具调用参数。
     * media = { kind: "image" | "video", url, dataUrl?, pageUrl?, title?, width?, height?, mimeType? }
     * 图片带 dataUrl 时 content 用内嵌数据（画布页面加载防盗链外链会空白），原始直链写进 remoteUrl 留档。
     */
    function buildCreateNodePayload(media) {
        const kind = media.kind === "video" ? "video" : "image";
        const size = fitNodeSize(media.width, media.height);
        // 视频节点靠 mimeType 走播放器分支，缺省时按直链最常见的 mp4 兜底。
        const mimeType = media.mimeType || (kind === "video" ? "video/mp4" : "");
        // 本机文件没有直链，只能走 dataURL；视频同样支持内嵌（<video src="data:..."> 可播）。
        const content = media.dataUrl ? media.dataUrl : media.url;
        const metadata = { content, status: "success" };
        if (mimeType) metadata.mimeType = mimeType;
        if (Number(media.width) > 0 && Number(media.height) > 0) {
            metadata.naturalWidth = Math.round(Number(media.width));
            metadata.naturalHeight = Math.round(Number(media.height));
        }
        if (kind === "image" && media.dataUrl && /^https?:/i.test(String(media.url || ""))) {
            metadata.remoteUrl = media.url;
        }
        if (media.pageUrl) metadata.source = media.pageUrl;
        return {
            name: "canvas_create_node",
            input: {
                nodeType: kind,
                title: media.title || titleFromUrl(media.url, kind === "video" ? "网页视频" : "网页图片"),
                width: size.width,
                height: size.height,
                metadata,
            },
        };
    }

    /** blob: 地址只在当前页面上下文有效，发给画布后必然失效。 */
    function isUnsendableUrl(url) {
        return /^blob:/i.test(String(url || ""));
    }

    /**
     * 把 http(s) 图片抓下来转成 dataURL（扩展后台调用：host_permissions 覆盖的源免 CORS，
     * 且不带页面 Referer，可绕过大多数「校验 Referer」类防盗链）。任何失败都返回 { ok:false, reason }，
     * 由调用方决定降级策略（保留原始外链），绝不抛异常。
     */
    async function fetchImageAsDataUrl(url, maxBytes) {
        const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_INLINE_BYTES;
        const target = String(url || "");
        if (!/^https?:/i.test(target)) return { ok: false, reason: "unsupported-scheme" };
        let response;
        try {
            response = await fetch(target, { credentials: "include", referrerPolicy: "no-referrer" });
        } catch {
            return { ok: false, reason: "fetch-failed" };
        }
        if (!response.ok) return { ok: false, reason: `http-${response.status}` };
        // 先看响应头省流量，再用 blob 实际大小兜底（chunked / 压缩响应头可能缺失或不准）。
        if (Number(response.headers.get("content-length") || 0) > limit) return { ok: false, reason: "too-large" };
        const blob = await response.blob().catch(() => null);
        if (!blob) return { ok: false, reason: "fetch-failed" };
        if (blob.size > limit) return { ok: false, reason: "too-large" };
        if (blob.type && !/^image\//i.test(blob.type)) return { ok: false, reason: "not-image" };
        const dataUrl = await new Promise((resolve) => {
            if (typeof FileReader !== "function") return resolve("");
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve("");
            reader.readAsDataURL(blob);
        });
        if (!dataUrl) return { ok: false, reason: "read-failed" };
        let width = 0;
        let height = 0;
        if (typeof createImageBitmap === "function") {
            try {
                const bitmap = await createImageBitmap(blob);
                width = bitmap.width;
                height = bitmap.height;
                if (typeof bitmap.close === "function") bitmap.close();
            } catch {
                /* 个别格式解不出来就保持 0，不影响内嵌 */
            }
        }
        return { ok: true, dataUrl, width, height, mimeType: blob.type || "" };
    }

    /**
     * 从 DOM 元素提取可发送的媒体（img / video / 含媒体地址的 a）。
     * 仅在内容脚本与书签里调用（需要 document）。
     */
    function describeElement(el, pageUrl) {
        if (!el || typeof el !== "object") return null;
        const tag = String(el.tagName || "").toLowerCase();
        if (tag === "img") {
            const url = absUrl(el.currentSrc || el.src || "", pageUrl);
            if (!url) return null;
            return {
                kind: "image",
                url,
                pageUrl,
                title: String(el.alt || "").trim().slice(0, 60) || undefined,
                width: el.naturalWidth || el.width || 0,
                height: el.naturalHeight || el.height || 0,
            };
        }
        if (tag === "video") {
            // currentSrc 常是 HLS/DASH 的 blob: 地址，blob: 发到画布后无法播放，故优先用直链 src。
            const direct = absUrl(el.src || "", pageUrl);
            const current = absUrl(el.currentSrc || "", pageUrl);
            const url = direct && !isUnsendableUrl(direct) ? direct : current;
            if (!url) return null;
            return {
                kind: "video",
                url,
                pageUrl,
                title: String(el.title || "").trim().slice(0, 60) || undefined,
                width: el.videoWidth || 0,
                height: el.videoHeight || 0,
                mimeType: "video/mp4",
                unsupported: isUnsendableUrl(url),
            };
        }
        if (tag === "a") {
            const href = absUrl(el.href || "", pageUrl);
            if (!href || !/\.(?:png|jpe?g|gif|webp|avif|bmp|mp4|webm|mov|m4v)(?:\?|#|$)/i.test(href)) return null;
            return { kind: /\.(?:mp4|webm|mov|m4v)(?:\?|#|$)/i.test(href) ? "video" : "image", url: href, pageUrl };
        }
        return null;
    }

    /**
     * 判断本机文件是否可发送，并给出媒体描述（不含 dataURL）。
     * 只收图片与视频：其它文件（txt/zip/…）画布没有对应节点类型。
     */
    function describeFile(file, pageUrl) {
        if (!file || typeof file !== "object") return null;
        const type = String(file.type || "");
        const name = String(file.name || "").slice(0, 60);
        let kind = /^(?:image|video)\//i.test(type) ? (/^image\//i.test(type) ? "image" : "video") : "";
        if (!kind) {
            // 某些系统/工具导出的文件 type 为空，按扩展名兜底判定。
            if (/\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name)) kind = "image";
            else if (/\.(?:mp4|webm|mov|m4v)$/i.test(name)) kind = "video";
        }
        if (!kind) return null;
        return { kind, title: name || (kind === "video" ? "本机视频" : "本机图片"), pageUrl, mimeType: type || undefined, size: Number(file.size) || 0 };
    }

    /**
     * 本机文件 → dataURL（图片/视频通用）。
     * 与 fetchImageAsDataUrl 同样的失败约定：返回 { ok:false, reason }，绝不抛异常，由调用方决定跳过还是提示。
     * reason 多了 file-too-large / unsupported-file 两个取值，便于人话提示。
     */
    async function fileToDataUrl(file, maxBytes) {
        const media = describeFile(file);
        if (!media) return { ok: false, reason: "unsupported-file" };
        const limit = Number(maxBytes) > 0 ? Number(maxBytes) : media.kind === "video" ? MAX_VIDEO_INLINE_BYTES : MAX_INLINE_BYTES;
        const size = Number(file.size) || 0;
        if (size > limit) return { ok: false, reason: "file-too-large" };
        const dataUrl = await new Promise((resolve) => {
            if (typeof FileReader !== "function") return resolve("");
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve("");
            reader.readAsDataURL(file);
        });
        if (!dataUrl || !/^data:/i.test(dataUrl)) return { ok: false, reason: "read-failed" };
        let width = 0;
        let height = 0;
        // 图片取真实宽高让节点比例正确；视频不取（createImageBitmap 解不出）。
        if (media.kind === "image" && typeof createImageBitmap === "function") {
            try {
                const bitmap = await createImageBitmap(file);
                width = bitmap.width;
                height = bitmap.height;
                if (typeof bitmap.close === "function") bitmap.close();
            } catch {
                /* 个别格式解不出来就保持 0，节点用默认尺寸 */
            }
        }
        return { ok: true, dataUrl, width, height, mimeType: String(file.type || ""), size };
    }

    /**
     * FileList / File[] → 媒体数组（逐个内嵌 dataURL）。
     * 单个文件失败不影响其余：失败的项带 skipReason，调用方可提示「已发送 N 个，M 个跳过」。
     */
    async function filesToMedia(fileList, pageUrl) {
        const files = [...(fileList || [])];
        const out = [];
        for (const file of files) {
            const media = describeFile(file, pageUrl);
            if (!media) continue;
            const result = await fileToDataUrl(file);
            if (!result.ok) {
                out.push({ ...media, skipReason: result.reason });
                continue;
            }
            out.push({ ...media, dataUrl: result.dataUrl, width: result.width, height: result.height, mimeType: result.mimeType || media.mimeType });
        }
        return out;
    }

    /**
     * 把 http(s) 视频抓下来转成 dataURL（与 fetchImageAsDataUrl 同构，独立体积上限 8MB）。
     *
     * 为什么视频也要内嵌：画布视频节点是 `<video src={metadata.content}>`，dataURL 一样能播；
     * 而外链视频在画布页面（本地来源）加载常被防盗链 / 签名过期 / 需要 Referer 拒绝 → 节点建成但一片黑。
     * 失败约定与图片版一致：返回 { ok:false, reason }，绝不抛异常。
     * 视频不解码宽高（createImageBitmap 对视频无效），尺寸由调用方从 DOM 取 videoWidth/videoHeight。
     */
    async function fetchVideoAsDataUrl(url, maxBytes) {
        const limit = Number(maxBytes) > 0 ? Number(maxBytes) : MAX_VIDEO_INLINE_BYTES;
        const target = String(url || "");
        if (!/^https?:/i.test(target)) return { ok: false, reason: "unsupported-scheme" };
        let response;
        try {
            response = await fetch(target, { credentials: "include", referrerPolicy: "no-referrer" });
        } catch {
            return { ok: false, reason: "fetch-failed" };
        }
        if (!response.ok) return { ok: false, reason: `http-${response.status}` };
        if (Number(response.headers.get("content-length") || 0) > limit) return { ok: false, reason: "too-large" };
        const blob = await response.blob().catch(() => null);
        if (!blob) return { ok: false, reason: "fetch-failed" };
        if (blob.size > limit) return { ok: false, reason: "too-large" };
        if (blob.type && !/^video\//i.test(blob.type)) return { ok: false, reason: "not-video" };
        const dataUrl = await new Promise((resolve) => {
            if (typeof FileReader !== "function") return resolve("");
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result || ""));
            reader.onerror = () => resolve("");
            reader.readAsDataURL(blob);
        });
        if (!dataUrl) return { ok: false, reason: "read-failed" };
        return { ok: true, dataUrl, width: 0, height: 0, mimeType: blob.type || "video/mp4" };
    }

    /** 按 kind 选对应抓取器（图片 / 视频），供后台统一调用。 */
    function fetchMediaAsDataUrl(kind, url, maxBytes) {
        return kind === "video" ? fetchVideoAsDataUrl(url, maxBytes) : fetchImageAsDataUrl(url, maxBytes);
    }

    return {
        absUrl,
        fitNodeSize,
        titleFromUrl,
        buildCreateNodePayload,
        isUnsendableUrl,
        fetchImageAsDataUrl,
        fetchVideoAsDataUrl,
        fetchMediaAsDataUrl,
        describeElement,
        describeFile,
        fileToDataUrl,
        filesToMedia,
        MAX_EDGE,
        MIN_EDGE,
        MAX_INLINE_BYTES,
        MAX_VIDEO_INLINE_BYTES,
    };
})();

// 浏览器（content script / service worker）挂到全局；Node 下走 module.exports 以便跑单测。
if (typeof self !== "undefined") self.ICMedia = ICMedia;
if (typeof globalThis !== "undefined") globalThis.ICMedia = ICMedia;
if (typeof module === "object" && module.exports) module.exports = ICMedia;
