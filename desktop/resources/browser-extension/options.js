/** 扩展设置：保存 Token / Agent 地址，并做一次连通性自检。 */

const DEFAULTS = { baseUrl: "http://127.0.0.1:17371", token: "", hoverButton: true, localFileSend: true };
const statusEl = document.getElementById("status");

function load() {
    chrome.storage.sync.get(DEFAULTS, (config) => {
        document.getElementById("token").value = config.token || "";
        document.getElementById("baseUrl").value = config.baseUrl || DEFAULTS.baseUrl;
        document.getElementById("hoverButton").checked = config.hoverButton !== false;
        document.getElementById("localFileSend").checked = config.localFileSend !== false;
    });
}

document.getElementById("save").addEventListener("click", () => {
    const token = document.getElementById("token").value.trim();
    const baseUrl = document.getElementById("baseUrl").value.trim().replace(/\/+$/, "") || DEFAULTS.baseUrl;
    const hoverButton = document.getElementById("hoverButton").checked;
    const localFileSend = document.getElementById("localFileSend").checked;
    chrome.storage.sync.set({ token, baseUrl, hoverButton, localFileSend }, () => {
        statusEl.textContent = "已保存 ✓";
        statusEl.style.color = "#059669";
    });
});

document.getElementById("test").addEventListener("click", async () => {
    const token = document.getElementById("token").value.trim();
    const baseUrl = document.getElementById("baseUrl").value.trim().replace(/\/+$/, "") || DEFAULTS.baseUrl;
    statusEl.style.color = "#374151";
    statusEl.textContent = "测试中…";
    if (!token) {
        statusEl.style.color = "#b91c1c";
        statusEl.textContent = "请先填写 Token 再测试。";
        return;
    }
    try {
        const response = await fetch(`${baseUrl}/config`, { headers: { "x-canvas-agent-token": token } });
        if (!response.ok) {
            statusEl.style.color = "#b91c1c";
            statusEl.textContent = `Agent 返回 HTTP ${response.status}，请检查地址与端口。`;
            return;
        }
        statusEl.style.color = "#059669";
        statusEl.textContent = "已连通本机 Canvas Agent ✓（真正发送时还需要打开画布页面）";
    } catch {
        statusEl.style.color = "#b91c1c";
        statusEl.textContent = "连不上本机 Canvas Agent，请确认已启动（画布里有「一键启动 Canvas Agent」）。";
    }
});

load();
