/**
 * 内容脚本：鼠标悬停图片 / 视频时浮出「发送到画布」按钮，点击即发到本机 Canvas Agent。
 * 另提供两条本机文件通路（浏览器扩展装得上的场景）：
 *   · Alt + 把本机文件拖进页面 → 发送（只有按住 Alt 且确实拖的是文件时才拦截，网页原生拖拽上传不受影响）
 *   · Alt + V 粘贴截图 / 复制的图片文件 → 发送（网页自己的 Ctrl+V 粘贴保持原样）
 * 两条通路都可在扩展选项里关闭（右键菜单与悬停按钮仍然可用）。
 *
 * 只监听鼠标轨迹与带修饰键的拖放/粘贴，不改动页面结构；按钮与提示条挂在 document.body 上并加 `icx-` 前缀，
 * 避免与页面样式冲突。
 */

(() => {
    if (window.__icxLoaded) return;
    window.__icxLoaded = true;

    const BUTTON_ID = "icx-send-button";
    const TOAST_ID = "icx-toast";
    let buttonEl = null;
    let currentMedia = null;
    let hoverEnabled = true;
    let localSendEnabled = true;
    let dragDepth = 0;
    let dragHinted = false;

    chrome.storage.sync.get({ hoverButton: true, localFileSend: true }, (config) => {
        hoverEnabled = config.hoverButton !== false;
        localSendEnabled = config.localFileSend !== false;
    });
    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "sync") return;
        if (changes.hoverButton) hoverEnabled = changes.hoverButton.newValue !== false;
        if (changes.localFileSend) localSendEnabled = changes.localFileSend.newValue !== false;
    });

    function ensureButton() {
        if (buttonEl) return buttonEl;
        buttonEl = document.createElement("button");
        buttonEl.id = BUTTON_ID;
        buttonEl.type = "button";
        buttonEl.className = "icx-send-button";
        buttonEl.textContent = "发送到画布";
        buttonEl.addEventListener("mousedown", (event) => {
            // 先于页面自己的点击处理，避免触发原图链接跳转
            event.preventDefault();
            event.stopPropagation();
        });
        buttonEl.addEventListener("click", (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (currentMedia) send(currentMedia);
        });
        document.body.appendChild(buttonEl);
        return buttonEl;
    }

    function hideButton() {
        if (buttonEl) buttonEl.classList.remove("icx-visible");
    }

    function placeButton(rect) {
        const el = ensureButton();
        const top = Math.max(8, window.scrollY + rect.top + 8);
        const left = Math.min(window.scrollX + rect.right - el.offsetWidth - 8, window.scrollX + rect.left + rect.width - el.offsetWidth - 8);
        el.style.top = `${top}px`;
        el.style.left = `${Math.max(8, left)}px`;
        el.classList.add("icx-visible");
    }

    function toast(message, ok) {
        let el = document.getElementById(TOAST_ID);
        if (!el) {
            el = document.createElement("div");
            el.id = TOAST_ID;
            el.className = "icx-toast";
            document.body.appendChild(el);
        }
        el.textContent = message;
        el.classList.toggle("icx-error", ok === false);
        el.classList.add("icx-visible");
        clearTimeout(el.__icxTimer);
        el.__icxTimer = setTimeout(() => el.classList.remove("icx-visible"), 2600);
    }

    /** 页面内的 blob: 图片只有当前页面能读到：就地转成 dataURL 交给后台直接内嵌；读不到就维持原样。 */
    async function inlineBlobImage(media) {
        if (media.kind !== "image" || media.dataUrl || !/^blob:/i.test(media.url)) return;
        try {
            const response = await fetch(media.url);
            const blob = await response.blob();
            if (blob.size > 5 * 1024 * 1024) return;
            if (blob.type && !/^image\//i.test(blob.type)) return;
            const dataUrl = await new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onload = () => resolve(String(reader.result || ""));
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
            if (dataUrl) media.dataUrl = dataUrl;
        } catch {
            /* 转换失败时按原逻辑由后台报「页面内部临时地址」 */
        }
    }

    async function send(media) {
        toast("正在发送到画布…");
        await inlineBlobImage(media);
        chrome.runtime.sendMessage({ type: "ic-send-media", media }, (response) => {
            if (chrome.runtime.lastError) {
                toast("发送失败：请刷新页面后重试", false);
                return;
            }
            if (response?.ok) toast(`已发送到画布 ✓${response.note || ""}`);
            else toast(response?.reason || "发送失败", false);
        });
    }

    /** 本机文件批量发送：先把 File 转成 dataURL（MV3 后台没有 FileReader），再交给后台。 */
    function sendFiles(files) {
        if (!localSendEnabled) {
            toast("本机文件发送已在扩展选项里关闭", false);
            return;
        }
        const list = [...(files || [])].filter(Boolean);
        if (!list.length) return;
        toast(`正在发送 ${list.length} 个本机文件到画布…`);
        ICMedia.filesToMedia(list, location.href).then((media) => {
            if (!media.length) {
                toast("没有可发送的图片 / 视频文件", false);
                return;
            }
            chrome.runtime.sendMessage({ type: "ic-send-files", media }, (response) => {
                if (chrome.runtime.lastError) {
                    toast("发送失败：请刷新页面后重试", false);
                    return;
                }
                if (!response?.ok) {
                    toast(response?.reason || "发送失败", false);
                    return;
                }
                const skippedNote = response.skipped?.length ? `，${response.skipped.length} 个跳过` : "";
                toast(`已发送 ${response.sent} 个本机文件到画布 ✓${response.note || ""}${skippedNote}`);
            });
        });
    }

    /** 拖拽事件里是否带着本机文件（页面元素拖拽不带 Files）。 */
    function hasFiles(event) {
        const types = event.dataTransfer?.types;
        return Boolean(types && [...types].includes("Files"));
    }

    document.addEventListener("dragenter", (event) => {
        if (!localSendEnabled || !hasFiles(event)) return;
        dragDepth += 1;
        if (!dragHinted) {
            dragHinted = true;
            toast(event.altKey ? "松开鼠标发送到画布" : "按住 Alt 拖到页面即可发送到画布");
        }
    }, true);

    document.addEventListener("dragover", (event) => {
        if (!localSendEnabled || !hasFiles(event)) return;
        // 只有带 Alt 时才阻止默认行为：不带 Alt 就把拖拽原样交回网页（原生上传照常可用）。
        if (event.altKey) event.preventDefault();
    }, true);

    document.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (dragDepth === 0) dragHinted = false;
    }, true);

    document.addEventListener("drop", (event) => {
        if (!localSendEnabled || !event.altKey || !hasFiles(event)) return;
        event.preventDefault();
        event.stopPropagation();
        dragDepth = 0;
        dragHinted = false;
        sendFiles(event.dataTransfer?.files);
    }, true);

    document.addEventListener("paste", (event) => {
        if (!localSendEnabled || !event.altKey) return;
        const files = event.clipboardData?.files;
        if (!files || !files.length) return;
        event.preventDefault();
        event.stopPropagation();
        sendFiles(files);
    }, true);

    document.addEventListener(
        "mouseover",
        (event) => {
            if (!hoverEnabled) return;
            const target = event.target;
            if (!(target instanceof Element)) return;
            const mediaEl = target.closest("img, video");
            if (!mediaEl) {
                hideButton();
                currentMedia = null;
                return;
            }
            const media = ICMedia.describeElement(mediaEl, location.href);
            if (!media || !media.url) {
                hideButton();
                currentMedia = null;
                return;
            }
            currentMedia = media;
            placeButton(mediaEl.getBoundingClientRect());
        },
        true,
    );

    document.addEventListener("scroll", hideButton, { passive: true });

    chrome.runtime.onMessage.addListener((message) => {
        if (message?.type !== "ic-send-result") return;
        if (message.ok) toast(`已发送到画布 ✓${message.note || ""}`);
        else toast(message.reason || "发送失败", false);
    });
})();
