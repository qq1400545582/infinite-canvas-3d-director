/**
 * 扩展弹窗：列出当前页面的图片 / 视频，勾选后批量发送到画布。
 *
 * 页面内的媒体列表通过 chrome.scripting 在目标标签里执行一次只读收集（不写页面数据），
 * 发送仍走后台的 /api/tools 通路。
 */

function collectMedia() {
    const seen = new Set();
    const items = [];
    document.querySelectorAll("img, video").forEach((el) => {
        const media = self.ICMedia ? ICMedia.describeElement(el, location.href) : null;
        if (!media || !media.url || seen.has(media.url)) return;
        seen.add(media.url);
        items.push({
            url: media.url,
            kind: media.kind,
            title: media.title || media.url.split("/").pop() || media.kind,
            width: media.width || 0,
            height: media.height || 0,
            unsupported: Boolean(media.unsupported),
        });
    });
    return items.slice(0, 40);
}

const listEl = document.getElementById("list");
const leadEl = document.getElementById("lead");
const statusEl = document.getElementById("status");
const sendBtn = document.getElementById("send");
const allBtn = document.getElementById("all");
const optionsBtn = document.getElementById("options");
const dropEl = document.getElementById("drop");
const pickBtn = document.getElementById("pick");
const fileEl = document.getElementById("file");
let items = [];

optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

// —— 本机文件：选择或拖入 → 逐个转 dataURL → 交给后台批量发送 ——
pickBtn.addEventListener("click", () => fileEl.click());

fileEl.addEventListener("change", () => {
    if (fileEl.files?.length) void sendLocalFiles(fileEl.files);
    fileEl.value = "";
});

["dragenter", "dragover"].forEach((type) =>
    dropEl.addEventListener(type, (event) => {
        event.preventDefault();
        dropEl.classList.add("over");
    }),
);
["dragleave", "drop"].forEach((type) =>
    dropEl.addEventListener(type, (event) => {
        event.preventDefault();
        dropEl.classList.remove("over");
    }),
);
dropEl.addEventListener("drop", (event) => {
    const files = event.dataTransfer?.files;
    if (files?.length) void sendLocalFiles(files);
});

async function sendLocalFiles(fileList) {
    statusEl.textContent = `正在发送 ${fileList.length} 个本机文件…`;
    const media = await ICMedia.filesToMedia(fileList, "");
    if (!media.length) {
        statusEl.textContent = "没有可发送的图片 / 视频文件";
        return;
    }
    const response = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "ic-send-files", media }, resolve));
    if (!response?.ok) {
        statusEl.textContent = response?.reason || "发送失败";
        return;
    }
    const skipped = response.skipped?.length ? `，跳过 ${response.skipped.length} 个（${response.skipped[0].reason}${response.skipped.length > 1 ? " 等" : ""}）` : "";
    statusEl.textContent = `已发送 ${response.sent}/${response.total} 个本机文件 ✓${response.note || ""}${skipped}`;
}

allBtn.addEventListener("click", () => {
    listEl.querySelectorAll("input:not([disabled])").forEach((box) => {
        box.checked = true;
    });
});

sendBtn.addEventListener("click", async () => {
    const checked = [...listEl.querySelectorAll("input:checked")];
    if (!checked.length) return;
    sendBtn.disabled = true;
    let ok = 0;
    for (const box of checked) {
        const media = items[Number(box.dataset.index)];
        const response = await new Promise((resolve) => chrome.runtime.sendMessage({ type: "ic-send-media", media }, resolve));
        if (response?.ok) ok += 1;
        else {
            statusEl.textContent = response?.reason || "发送失败";
            break;
        }
        statusEl.textContent = `已发送 ${ok}/${checked.length}…`;
    }
    if (ok === checked.length) statusEl.textContent = `已发送 ${ok} 个到画布 ✓`;
    sendBtn.disabled = false;
});

function render() {
    listEl.innerHTML = "";
    items.forEach((item, index) => {
        const row = document.createElement("label");
        row.className = `item${item.unsupported ? " disabled" : ""}`;
        const box = document.createElement("input");
        box.type = "checkbox";
        box.dataset.index = String(index);
        box.disabled = item.unsupported;
        if (!item.unsupported && item.kind === "image" && items.length <= 12) box.checked = true;
        const thumb = document.createElement(item.kind === "video" ? "span" : "img");
        if (item.kind === "video") {
            thumb.className = "thumb";
            thumb.textContent = "▶";
            thumb.style.cssText = "display:flex;align-items:center;justify-content:center;color:#6b7280";
        } else {
            thumb.className = "thumb";
            thumb.src = item.url;
            thumb.referrerPolicy = "no-referrer";
        }
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = item.title || item.url;
        name.title = item.url;
        const tag = document.createElement("span");
        tag.className = "tag";
        tag.textContent = item.unsupported ? "不支持" : item.kind === "video" ? "视频" : "图片";
        row.append(box, thumb, name, tag);
        listEl.appendChild(row);
    });
}

(async () => {
    const { token, baseUrl } = await chrome.storage.sync.get({ token: "", baseUrl: "http://127.0.0.1:17371" });
    if (!token) {
        leadEl.innerHTML = '尚未配置 Token，请先在 <a href="#" id="go">设置页</a> 填写 Canvas Agent 连接 Token。';
        document.getElementById("go")?.addEventListener("click", (event) => {
            event.preventDefault();
            chrome.runtime.openOptionsPage();
        });
        sendBtn.disabled = true;
        return;
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !/^https?:/i.test(tab.url || "")) {
        leadEl.textContent = "当前页面不支持（需为 http/https 网页）。";
        sendBtn.disabled = true;
        return;
    }
    try {
        const results = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: collectMedia });
        items = results?.[0]?.result || [];
    } catch {
        leadEl.textContent = "读取页面媒体失败（页面可能限制了脚本注入）。";
        sendBtn.disabled = true;
        return;
    }
    if (!items.length) {
        leadEl.textContent = "当前页面没有检测到图片或视频。";
        sendBtn.disabled = true;
        return;
    }
    leadEl.textContent = `检测到 ${items.length} 个媒体（最多 40），目标 ${baseUrl}`;
    render();
})();
