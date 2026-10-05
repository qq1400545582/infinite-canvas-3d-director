/**
 * 书签小工具源码（生成器会把 __TOKEN__ / __BASE__ 替换为本机真实值）。
 *
 * 用法：把书签加到书签栏 → 在任意网页点一下这个书签 → 进入「拾取模式」
 *   · 鼠标移到图片 / 视频上会高亮，点击即发送到画布，可连续发送多个；
 *   · 按 Esc 或再点一次书签退出。
 *
 * 与扩展走同一条通路：本机 Canvas Agent 的 /api/tools（canvas_create_node）。
 * CSP 严格的站点会阻止书签脚本执行，那种站点请用浏览器扩展。
 */
(function () {
    var TOKEN = "__TOKEN__";
    var BASE = "__BASE__";

    if (window.__icxPick) {
        window.__icxPick.stop();
        return;
    }

    var bar = document.createElement("div");
    bar.id = "icx-pick-bar";
    bar.style.cssText =
        "position:fixed;z-index:2147483002;left:50%;top:16px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:8px 14px;border-radius:10px;background:rgba(17,24,39,.94);color:#fff;font:400 13px/1.5 -apple-system,'PingFang SC','Microsoft YaHei',sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.3)";
    bar.innerHTML = "<span>点击要发送的图片 / 视频（Esc 取消）</span>";
    var close = document.createElement("button");
    close.textContent = "退出";
    close.style.cssText = "border:none;border-radius:6px;background:#374151;color:#fff;height:24px;padding:0 10px;font-size:12px;cursor:pointer";
    close.addEventListener("click", function (event) {
        event.stopPropagation();
        window.__icxPick.stop();
    });
    bar.appendChild(close);
    document.body.appendChild(bar);

    var toast = document.createElement("div");
    toast.style.cssText =
        "position:fixed;z-index:2147483003;right:20px;bottom:24px;max-width:380px;padding:10px 14px;border-radius:10px;background:rgba(17,24,39,.94);color:#fff;font:400 13px/1.5 -apple-system,'PingFang SC',sans-serif;opacity:0;transition:opacity .18s ease;pointer-events:none";
    document.body.appendChild(toast);
    var toastTimer = 0;

    function say(message, bad) {
        toast.textContent = message;
        toast.style.background = bad ? "rgba(180,38,38,.94)" : "rgba(17,24,39,.94)";
        toast.style.opacity = "1";
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () {
            toast.style.opacity = "0";
        }, 2600);
    }

    var highlighted = null;
    function clearHighlight() {
        if (highlighted) {
            highlighted.style.outline = "";
            highlighted = null;
        }
    }

    function onMove(event) {
        var target = event.target;
        var el = target && target.closest ? target.closest("img, video") : null;
        clearHighlight();
        if (!el) return;
        highlighted = el;
        el.style.outline = "3px solid #2563eb";
    }

    function onKey(event) {
        if (event.key === "Escape") window.__icxPick.stop();
    }

    function onClick(event) {
        var target = event.target;
        var el = target && target.closest ? target.closest("img, video") : null;
        if (!el) return;
        event.preventDefault();
        event.stopPropagation();

        var isVideo = String(el.tagName || "").toLowerCase() === "video";
        var url = el.currentSrc || el.src || "";
        if (isVideo) {
            // currentSrc 常是 HLS/DASH 的 blob: 地址，发出去无法播放，优先用直链 src。
            var direct = el.getAttribute("src") || "";
            if (direct && direct.indexOf("blob:") !== 0) url = direct;
        }
        try {
            url = new URL(url, location.href).href;
        } catch (e) {
            /* 相对地址解析失败时按原样发送 */
        }
        if (!url) return say("没有拿到媒体地址", true);
        if (url.indexOf("blob:") === 0) return say("这是页面内部的临时地址（blob:），发送后无法播放", true);

        var metadata = { content: url, status: "success", source: location.href };
        if (isVideo) metadata.mimeType = "video/mp4";
        var w = isVideo ? el.videoWidth : el.naturalWidth;
        var h = isVideo ? el.videoHeight : el.naturalHeight;
        if (w > 0 && h > 0) {
            metadata.naturalWidth = w;
            metadata.naturalHeight = h;
        }
        var scale = Math.min(480 / (w || 480), 480 / (h || 360), 1);
        var body = {
            name: "canvas_create_node",
            input: {
                nodeType: isVideo ? "video" : "image",
                title: (el.alt || el.title || url.split("/").pop() || (isVideo ? "网页视频" : "网页图片")).slice(0, 60),
                width: w > 0 ? Math.round(w * scale) : 360,
                height: h > 0 ? Math.round(h * scale) : 270,
                metadata: metadata,
            },
        };

        say("正在发送…");
        /**
         * 抓成 dataURL 内嵌再发：画布是本地页面，外链媒体常被防盗链 / 签名过期拒绝（图片空白、视频黑屏）。
         * 书签脚本跑在页面上下文，fetch 受 CORS 限制，因此失败就按外链直发，不阻断发送。
         * 体积上限：图片 5MB、视频 8MB（dataURL 有 4/3 膨胀，仍远低于 Agent 的 30MB 请求体上限）。
         */
        var LIMIT = isVideo ? 8 * 1024 * 1024 : 5 * 1024 * 1024;
        function sendNow(note) {
            fetch(BASE + "/api/tools?token=" + encodeURIComponent(TOKEN), {
                method: "POST",
                headers: { "content-type": "application/json", "x-canvas-agent-token": TOKEN },
                body: JSON.stringify(body),
            })
                .then(function (response) {
                    return response.json().catch(function () {
                        return {};
                    }).then(function (data) {
                        return { status: response.status, data: data };
                    });
                })
                .then(function (result) {
                    if (result.status === 401) return say("Token 失效，请重新生成书签", true);
                    if (!result.status) return say("连不上本机 Canvas Agent，请确认已启动", true);
                    if (result.data.ok === false) {
                        var text = String(result.data.error || "");
                        if (text.indexOf("已连接") >= 0) return say("请先打开画布页面并保持连接", true);
                        return say(text || "发送失败", true);
                    }
                    say("已发送到画布 ✓" + (note || ""));
                })
                .catch(function () {
                    say("连不上本机 Canvas Agent，请确认已启动", true);
                });
        }

        function toDataUrl(blob, cb) {
            var reader = new FileReader();
            reader.onload = function () {
                cb(String(reader.result || ""));
            };
            reader.onerror = function () {
                cb("");
            };
            reader.readAsDataURL(blob);
        }

        fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" })
            .then(function (response) {
                if (!response.ok) throw new Error("http");
                var length = Number(response.headers.get("content-length") || 0);
                if (length > LIMIT) throw new Error("too-large");
                return response.blob();
            })
            .then(function (blob) {
                if (blob.size > LIMIT) throw new Error("too-large");
                // 类型对不上就别内嵌（很多站把图片挂在 video 标签下或反之），外链更稳。
                if (blob.type && !isVideo && !/^image\//i.test(blob.type)) throw new Error("type");
                if (blob.type && isVideo && !/^video\//i.test(blob.type)) throw new Error("type");
                toDataUrl(blob, function (dataUrl) {
                    if (!dataUrl) return sendNow("");
                    metadata.content = dataUrl;
                    if (blob.type) metadata.mimeType = blob.type;
                    sendNow("（已内嵌）");
                });
            })
            .catch(function () {
                sendNow("（外链直发）");
            });
    }

    window.__icxPick = {
        stop: function () {
            document.removeEventListener("mousemove", onMove, true);
            document.removeEventListener("click", onClick, true);
            document.removeEventListener("keydown", onKey, true);
            clearHighlight();
            if (bar.parentNode) bar.parentNode.removeChild(bar);
            if (toast.parentNode) toast.parentNode.removeChild(toast);
            window.__icxPick = null;
        },
    };

    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey, true);
})();
