import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";

// DirectorDesk（白模预演台）是纯前端 Three.js SPA —— 无 React、无后端、无宿主桥接协议。
// 以同源 iframe 内嵌，本插件只做「iframe 容器 + 重载按钮 + 导出到画布桥」，不打包任何应用逻辑，
// 也不引入第二个 React 实例（宿主 React 单例，见 @infinite-canvas/plugin-sdk）。
//
// 同源静态资源放在 web/public/director-desk/（由官方 Portable 构建产物直接 vendored 放入，
// 或执行 build-app.mjs 从源码构建，随仓库提交）。
// 注意：DirectorDesk 原版通过 window.directorDesktop 与 Electron 外壳通信（项目存盘等），
// 在画布 iframe 里没有 Electron 外壳，这部分能力不可用（已用 ?. 优雅降级；WebView2 下
// 项目存盘还能走浏览器 showDirectoryPicker 兜底），但模型导入与实时预览纯前端可用。
const APP_ENTRY = "/director-desk/index.html";

// 「导出到画布」注入按钮的标记属性（不带 data-act，避免命中预演台的全局 [data-act] 委托分发）。
const EXPORT_MARK = "data-canvas-export-to-canvas";

// 宿主媒体仓库（web/src/services/file-storage.ts）底层是 localforage 实例：
//   localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" })
// localforage 的 IndexedDB 驱动用 idb.open(dbInfo.name) + createObjectStore(dbInfo.storeName)，
// 即：库名 = name，对象库名 = storeName。插件与宿主同源同页，可直接写入同一仓库，
// 从而拿到宿主认可的 storageKey（形如 video:<id>），视频节点才能在刷新后仍可播放。
const MEDIA_DB_NAME = "infinite-canvas";
const MEDIA_STORE_NAME = "media_files";
const BLOB_SUPPORT_STORE = "local-forage-detect-blob-support";

function getHostTheme(): "dark" | "light" {
    return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function nextFrame() {
    return new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
}

function errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 宿主媒体仓库写入（与宿主 file-storage.ts 同一 IndexedDB）
// ---------------------------------------------------------------------------

function newVideoStorageKey() {
    const raw = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().replace(/-/g, "") : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    return `video:${raw}`;
}

function openHostMediaDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        // 不指定版本：库已存在时按当前版本打开（不触发升级）；不存在时以版本 1 创建并触发升级，
        // 此时按 localforage 的建库方式补齐对象库，保证宿主后续仍能正常读写。
        const request = indexedDB.open(MEDIA_DB_NAME);
        request.onupgradeneeded = () => {
            const db = request.result;
            if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) db.createObjectStore(MEDIA_STORE_NAME);
            if (!db.objectStoreNames.contains(BLOB_SUPPORT_STORE)) db.createObjectStore(BLOB_SUPPORT_STORE);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error("无法打开画布媒体仓库"));
    });
}

/** 把 Blob 写进宿主媒体仓库，并回读校验。返回是否确认写入成功。 */
async function persistMediaBlob(storageKey: string, blob: Blob): Promise<boolean> {
    const db = await openHostMediaDb();
    try {
        if (!db.objectStoreNames.contains(MEDIA_STORE_NAME)) return false;
        await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(MEDIA_STORE_NAME, "readwrite");
            tx.objectStore(MEDIA_STORE_NAME).put(blob, storageKey);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error ?? new Error("写入媒体仓库失败"));
            tx.onabort = () => reject(tx.error ?? new Error("写入媒体仓库被中止"));
        });
        const readBack = await new Promise<unknown>((resolve, reject) => {
            const tx = db.transaction(MEDIA_STORE_NAME, "readonly");
            const request = tx.objectStore(MEDIA_STORE_NAME).get(storageKey);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("回读媒体仓库失败"));
        });
        return readBack instanceof Blob && readBack.size === blob.size;
    } finally {
        db.close();
    }
}

function readVideoMeta(url: string) {
    return new Promise<{ width: number; height: number; durationMs?: number }>((resolve) => {
        const video = document.createElement("video");
        const done = () => resolve({ width: video.videoWidth || 1920, height: video.videoHeight || 1080, durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : undefined });
        video.onloadedmetadata = done;
        video.onerror = done;
        video.preload = "metadata";
        video.src = url;
    });
}

// ---------------------------------------------------------------------------
// 预演台导出管线拦截：拿到内存中的 MP4 Blob，而不是落一个文件
// ---------------------------------------------------------------------------

type BlobCapture = { onCapture: (handler: (blob: Blob, filename: string) => void) => void; restore: () => void };

/**
 * 在预演台所在 window 里临时拦截「下载视频」这一步：
 * 预演台导出完成后会执行 URL.createObjectURL(blob) → <a download>.click()，
 * 这里记住 blob 并在锚点点击时改为把 blob 交给我们、同时抑制真实下载。
 * 其它用途的 createObjectURL / click 一律原样放行（仅命中 video/* + .mp4/.webm 才拦截）。
 */
function installBlobCapture(win: Window): BlobCapture {
    const urlCtor = win.URL;
    const anchorProto = win.HTMLAnchorElement.prototype;
    const originalCreate = urlCtor.createObjectURL;
    const anchorProtoOwnClick = Object.prototype.hasOwnProperty.call(anchorProto, "click");
    const originalClick = anchorProto.click;
    const blobs = new Map<string, Blob>();
    let handler: ((blob: Blob, filename: string) => void) | null = null;

    urlCtor.createObjectURL = function (this: unknown, object: Blob | MediaSource) {
        const url = originalCreate.call(urlCtor, object);
        if (object instanceof win.Blob) blobs.set(url, object);
        return url;
    } as typeof urlCtor.createObjectURL;

    anchorProto.click = function (this: HTMLAnchorElement) {
        const href = this.getAttribute("href") || (this as HTMLAnchorElement).href || "";
        const filename = this.download || "";
        const blob = blobs.get(href);
        if (blob && blob.type.startsWith("video/") && /\.(mp4|webm)$/i.test(filename)) {
            blobs.delete(href);
            handler?.(blob, filename);
            return; // 抑制真实下载：本次产物只进画布
        }
        return originalClick.apply(this, arguments as unknown as []);
    } as typeof anchorProto.click;

    return {
        onCapture(next) {
            handler = next;
        },
        restore() {
            urlCtor.createObjectURL = originalCreate;
            if (anchorProtoOwnClick) anchorProto.click = originalClick;
            else Reflect.deleteProperty(anchorProto, "click");
            blobs.clear();
        },
    };
}

/**
 * 触发预演台自带的「导出参考视频」流程，把保存方式切到「下载视频」（内存 Blob），
 * 并拦截产物。返回是否成功启动导出（未启动时调用方应降级处理）。
 */
async function startVideoExport(frame: HTMLIFrameElement, onCapture: (blob: Blob, filename: string) => void): Promise<{ started: boolean; message?: string }> {
    const win = frame.contentWindow;
    const doc = frame.contentDocument ?? win?.document;
    if (!win || !doc) return { started: false, message: "无法访问预演台内容" };

    const footerOf = () => doc.querySelector<HTMLElement>(".modal.export-modal .modal-footer") ?? doc.querySelector<HTMLElement>(".export-modal .modal-footer");
    const hasSaveSelect = () => Boolean(doc.querySelector("#export-save"));

    // 1) 未打开导出弹窗时，先点预演台自己的「导出」入口打开它
    if (!hasSaveSelect()) {
        const openEntry = doc.querySelector<HTMLButtonElement>('[data-act="export"]');
        if (!openEntry) return { started: false, message: "未找到预演台导出入口" };
        openEntry.click();
        await nextFrame();
        if (!hasSaveSelect()) return { started: false, message: "预演台当前无法打开导出弹窗（可能正在编辑或导出中）" };
    }
    if (!footerOf()) return { started: false, message: "未找到预演台导出弹窗" };

    // 2) 保存方式切到「下载视频」——只有这条路径会把成品留在内存里（可拦截），其余都是写文件
    const saveSelect = doc.querySelector<HTMLSelectElement>("#export-save");
    if (!saveSelect) return { started: false, message: "未找到保存方式选项" };
    if (Array.from(saveSelect.options).some((option) => option.value === "download")) {
        saveSelect.value = "download";
        saveSelect.dispatchEvent(new win.Event("change", { bubbles: true }));
    } else {
        return { started: false, message: "当前导出弹窗不支持「下载视频」保存方式" };
    }

    // 3) 安装拦截后再点「导出视频」
    const capture = installBlobCapture(win);
    capture.onCapture(onCapture);
    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        capture.restore();
    };
    // 兜底：导出异常/长时间无产物时也要把原型还原，绝不留后患。
    const guard = win.setTimeout(restore, 15 * 60 * 1000);

    const startButton = doc.querySelector<HTMLButtonElement>('[data-act="export-start"]');
    if (!startButton || startButton.disabled) {
        win.clearTimeout(guard);
        restore();
        return { started: false, message: "预演台导出按钮当前不可用" };
    }

    const onCaptured = (blob: Blob, filename: string) => {
        win.clearTimeout(guard);
        restore();
        onCapture(blob, filename);
    };
    capture.onCapture(onCaptured);
    startButton.click();
    return { started: true };
}

// ---------------------------------------------------------------------------
// 在导出弹窗底部注入「导出到画布」入口（纯 DOM 注入，不改预演台源码）
// ---------------------------------------------------------------------------

function injectExportToCanvasButton(doc: Document, onExport: () => void) {
    const footer = doc.querySelector<HTMLElement>(".modal.export-modal .modal-footer") ?? doc.querySelector<HTMLElement>(".export-modal .modal-footer");
    if (!footer) return;
    // 正在导出（footer 已被换成「取消导出」）时不注入，避免与导出中的 UI 冲突
    if (footer.querySelector('[data-act="cancel-export"]')) return;
    if (footer.querySelector(`[${EXPORT_MARK}]`)) return;

    const startButton = footer.querySelector<HTMLButtonElement>('[data-act="export-start"]');
    const button = doc.createElement("button");
    button.type = "button";
    button.setAttribute(EXPORT_MARK, "1");
    button.className = startButton?.className || "subtle";
    button.textContent = "导出到画布";
    button.title = "按当前导出设置生成视频，直接作为画布视频节点（不下载文件）";
    button.addEventListener("click", (event) => {
        // 阻断冒泡，避免命中预演台的全局 [data-act] 点击分发
        event.preventDefault();
        event.stopPropagation();
        onExport();
    });
    footer.insertBefore(button, startButton ?? null);
}

// ---------------------------------------------------------------------------

function DirectorDeskContent({ ctx }: CanvasNodeContentProps) {
    const nodeId = ctx.node.id;
    const iframeRef = useRef<HTMLIFrameElement>(null);
    // 预演台是独立的 5 MB+ SPA：加载期间 iframe 只是一张纯黑空文档，
    // 且 iframe 的 onError 对 HTTP 错误/被拦截基本不会触发。故用阶段机给出明确反馈。
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [failure, setFailure] = useState("");
    const [retryKey, setRetryKey] = useState(0);
    const [hovered, setHovered] = useState(false);
    const [status, setStatus] = useState("");
    const [src] = useState(
        () => `${APP_ENTRY}?instanceId=${encodeURIComponent(nodeId)}&theme=${getHostTheme()}`,
    );

    // 最新 ctx / 最新导出函数：每次渲染刷新，避免注册表里持有过期闭包。
    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const exportFnRef = useRef<() => void>(() => {});
    const exportIndexRef = useRef(0);

    // 预演台当前 WebGL 预览帧 → PNG → 图片节点（导出到画布的降级路径）。
    const exportScreenshot = (message?: string) => {
        const frame = iframeRef.current;
        const current = ctxRef.current;
        if (!frame) {
            setStatus("预演台尚未就绪");
            return;
        }
        const doc = frame.contentDocument ?? frame.contentWindow?.document;
        if (!doc) {
            setStatus("无法访问预演台内容");
            return;
        }
        const canvases = Array.from(doc.querySelectorAll("canvas")) as HTMLCanvasElement[];
        // 取面积最大的画布（即 3D 视口），避免选中 UI 叠加层的小画布。
        const canvas = canvases.sort((a, b) => b.width * b.height - a.width * a.height)[0] ?? null;
        if (!canvas) {
            setStatus("未找到预演台画布，请先导入模型并让场景渲染");
            return;
        }
        let dataUrl: string;
        try {
            dataUrl = canvas.toDataURL("image/png");
        } catch (err) {
            setStatus(`导出失败：画布内容不可读取（${errorMessage(err)}）`);
            return;
        }
        if (!dataUrl || dataUrl === "data:image/png;base64,") {
            setStatus("导出失败：当前预览帧为空，请确认场景已渲染");
            return;
        }
        const bufferW = canvas.width || 800;
        const bufferH = canvas.height || 600;
        const scale = Math.min(1, 720 / Math.max(bufferW, bufferH));
        current.applyOps([
            {
                type: "add_node",
                nodeType: "image",
                title: "白模预演截图",
                position: { x: current.node.position.x + current.node.width + 48, y: current.node.position.y },
                width: Math.max(80, Math.round(bufferW * scale)),
                height: Math.max(60, Math.round(bufferH * scale)),
                metadata: {
                    content: dataUrl,
                    mimeType: "image/png",
                    naturalWidth: bufferW,
                    naturalHeight: bufferH,
                    prompt: "白模预演台当前预览帧",
                },
            },
        ]);
        setStatus(message ?? "已导出当前预览帧（图片节点）");
    };

    // 捕获到的视频 Blob → 宿主媒体仓库（拿 storageKey）→ 画布视频节点
    const commitCapturedVideo = async (blob: Blob, filename: string) => {
        const current = ctxRef.current;
        const title = filename.replace(/\.(mp4|webm)$/i, "") || "白模预演视频";
        setStatus("正在写入画布…");
        const objectUrl = URL.createObjectURL(blob);
        const meta = await readVideoMeta(objectUrl);
        const storageKey = newVideoStorageKey();
        let persisted = false;
        try {
            persisted = await persistMediaBlob(storageKey, blob);
        } catch {
            persisted = false;
        }
        const scale = Math.min(1, 720 / Math.max(meta.width, meta.height));
        const index = exportIndexRef.current++;
        current.applyOps([
            {
                type: "add_node",
                nodeType: "video",
                title,
                position: { x: current.node.position.x + current.node.width + 48 + index * 32, y: current.node.position.y + index * 32 },
                width: Math.max(120, Math.round(meta.width * scale)),
                height: Math.max(80, Math.round(meta.height * scale)),
                metadata: {
                    content: objectUrl,
                    // 仅在确认写入媒体仓库时给 storageKey：刷新后 hydrate 靠它重新解析可播放地址。
                    ...(persisted ? { storageKey } : {}),
                    mimeType: blob.type || "video/mp4",
                    naturalWidth: meta.width,
                    naturalHeight: meta.height,
                    durationMs: meta.durationMs,
                    bytes: blob.size,
                    prompt: "由白模预演台导出",
                },
            },
        ]);
        setStatus(persisted ? `已导出到画布：${title}` : `已导出到画布（未持久化，刷新后可能失效）：${title}`);
    };

    // 导出到画布：优先走预演台自己的「参考视频」管线 → 视频节点；不可用时降级为当前预览帧截图。
    const handleExport = async () => {
        const frame = iframeRef.current;
        if (!frame) {
            setStatus("预演台尚未就绪");
            return;
        }
        setStatus("正在导出预演视频…");
        try {
            const result = await startVideoExport(frame, (blob, filename) => {
                void commitCapturedVideo(blob, filename);
            });
            if (!result.started) exportScreenshot(result.message ? `${result.message}；已改为导出当前预览帧` : undefined);
        } catch (err) {
            exportScreenshot(`预演视频导出失败（${errorMessage(err)}）；已改为导出当前预览帧`);
        }
    };
    exportFnRef.current = () => {
        void handleExport();
    };

    // 打开预演台导出弹窗（保存方式预置为「下载视频」），其中底部会注入「导出到画布」入口。
    const openExportDialog = () => {
        const frame = iframeRef.current;
        const doc = frame?.contentDocument ?? frame?.contentWindow?.document;
        if (!frame || !doc) {
            setStatus("预演台尚未就绪");
            return;
        }
        const entry = doc.querySelector<HTMLButtonElement>('[data-act="export"]');
        if (!entry) {
            setStatus("未找到预演台导出入口");
            return;
        }
        entry.click();
        void nextFrame().then(() => {
            const select = doc.querySelector<HTMLSelectElement>("#export-save");
            if (select && Array.from(select.options).some((option) => option.value === "download")) {
                select.value = "download";
                select.dispatchEvent(new Event("change", { bubbles: true }));
            }
            setStatus("已在导出弹窗中加入「导出到画布」");
        });
    };

    useEffect(() => {
        const frame = iframeRef.current;
        if (!frame) return;
        // 重载：复位状态并让 iframe 重新加载（不触发任何 ready 竞态，DirectorDesk 无桥接协议）。
        const reset = () => {
            if (!iframeRef.current) return;
            setPhase("loading");
            setFailure("");
            setRetryKey((key) => key + 1);
        };
        reloadRegistry.set(nodeId, reset);
        dialogRegistry.set(nodeId, openExportDialog);
        // 导出到画布：工具条按钮经此注册表调用，避免直接持有 ctx 闭包导致过期。
        exportRegistry.set(nodeId, () => exportFnRef.current());
        return () => {
            reloadRegistry.delete(nodeId);
            dialogRegistry.delete(nodeId);
            exportRegistry.delete(nodeId);
        };
    }, [nodeId]);

    // 就绪看门狗：轮询预演台文档，直到它真的渲染出界面为止。
    //   - 未就绪时显示加载遮罩（首次要下载约 5 MB 资源），不再是一片黑；
    //   - 超过 AUTO_RETRY_AT 仍未就绪 → 自动重载一次，覆盖网络抖动 / 半途失败；
    //   - 超过 READY_TIMEOUT → 显示可操作的失败面板（含原因、重载、新标签页打开）；
    //   - 轮询不因失败而停止：一旦文档就绪会自动收起遮罩，绝不永久遮住可用界面。
    useEffect(() => {
        const AUTO_RETRY_AT = 10000;
        const READY_TIMEOUT = 35000;
        const startedAt = Date.now();
        let autoRetried = false;
        // 具体的失败原因只写一次：先到的更精确（例如文档不可访问），不被后面的超时文案覆盖。
        let reason = "";

        // 就绪判据取宽：画布 / #app 有子节点 / body 已有可见文本，任一满足即视为已渲染。
        const probe = (): "ready" | "loading" | "blocked" => {
            const frame = iframeRef.current;
            if (!frame) return "loading";
            let doc: Document | null = null;
            try {
                doc = frame.contentDocument;
            } catch {
                return "blocked";
            }
            if (!doc) return "loading";
            if (doc.querySelector("canvas")) return "ready";
            const app = doc.getElementById("app");
            if (app && app.childElementCount > 0) return "ready";
            if (doc.body && (doc.body.innerText || "").trim().length > 0) return "ready";
            return "loading";
        };

        setPhase("loading");
        setFailure("");

        const timer = window.setInterval(() => {
            const frame = iframeRef.current;
            const state = probe();
            if (state === "ready") {
                window.clearInterval(timer);
                setPhase("ready");
                setFailure("");
                return;
            }
            if (state === "blocked") {
                if (!reason) {
                    reason = "预演台文档不可访问：可能资源被拦截 / 加载失败，或浏览器出于跨域、沙箱策略阻止了读取。";
                }
                setPhase("error");
                setFailure(reason);
                return;
            }
            const elapsed = Date.now() - startedAt;
            if (!autoRetried && elapsed >= AUTO_RETRY_AT && frame) {
                autoRetried = true;
                try {
                    frame.src = frame.src;
                } catch {
                    /* 忽略：重载失败时保持等待，由超时分支给出结论 */
                }
                return;
            }
            if (elapsed >= READY_TIMEOUT) {
                if (!reason) {
                    // 最常见的一种失败是可复现、可解释的：用「局域网 IP / 机器名」打开画布时，
                    // 页面不是安全上下文，浏览器会隐藏 crypto.randomUUID 等 API，预演台启动即崩。
                    // （web/public/director-desk/index.html 已补垫片；这里仍给出准确指引。）
                    reason = window.isSecureContext
                        ? "预演台 35 秒内没有渲染出界面：资源可能被拦截，或浏览器禁用了 WebGL / 硬件加速。"
                        : "预演台 35 秒内没有渲染出界面。当前地址不是浏览器的安全上下文（你在用 IP / 机器名访问），部分 Web API 会被禁用；请改用 http://localhost:3000（或桌面端）打开画布。";
                }
                setPhase("error");
                setFailure(reason);
            }
        }, 600);

        return () => window.clearInterval(timer);
    }, [retryKey]);

    // 监听预演台文档，出现「导出参考视频」弹窗时注入出口按钮（弹窗是纯 DOM，随开随建）。
    useEffect(() => {
        const frame = iframeRef.current;
        if (!frame) return;
        let observer: MutationObserver | null = null;
        let scheduled = false;

        const inject = () => {
            const doc = frame.contentDocument;
            if (!doc?.body) return;
            injectExportToCanvasButton(doc, () => exportFnRef.current());
        };
        const schedule = () => {
            if (scheduled) return;
            scheduled = true;
            requestAnimationFrame(() => {
                scheduled = false;
                inject();
            });
        };
        const attach = () => {
            const doc = frame.contentDocument;
            if (!doc?.body) return;
            inject();
            observer?.disconnect();
            observer = new MutationObserver(schedule);
            // 弹窗都挂在 #modal-root 下；退化为 body 时用 rAF 合并，避免 3D 面板频繁重绘空转。
            observer.observe(doc.getElementById("modal-root") ?? doc.body, { childList: true, subtree: true });
        };

        attach();
        frame.addEventListener("load", attach);
        return () => {
            frame.removeEventListener("load", attach);
            observer?.disconnect();
        };
    }, []);

    return (
        <div
            data-canvas-no-zoom
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            style={{
                position: "relative",
                width: "100%",
                height: "100%",
                borderRadius: 16,
                overflow: "hidden",
                outline: "2px solid #0ea5e9",
                outlineOffset: -2,
                boxShadow:
                    hovered || ctx.isSelected
                        ? "0 0 0 4px rgba(14,165,233,.25), 0 0 22px rgba(14,165,233,.35)"
                        : "0 0 12px rgba(14,165,233,.18)",
            }}
        >
            <div
                style={{
                    height: 34,
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "0 10px",
                    background: ctx.theme.node.panel,
                    color: ctx.theme.node.text,
                    fontSize: 12,
                }}
            >
                <span style={{ flex: "0 0 auto" }}>白模预演台 · 拖拽标题栏移动节点</span>
                {status ? (
                    <span style={{ flex: "1 1 auto", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "#0ea5e9" }} title={status}>
                        {status}
                    </span>
                ) : (
                    <span style={{ flex: "1 1 auto" }} />
                )}
                <button
                    type="button"
                    onClick={() => reloadRegistry.get(nodeId)?.()}
                    style={{
                        flex: "0 0 auto",
                        cursor: "pointer",
                        padding: "3px 9px",
                        borderRadius: 6,
                        border: "1px solid #0ea5e9",
                        background: "transparent",
                        color: "inherit",
                    }}
                >
                    重载
                </button>
            </div>
            <div style={{ position: "relative", height: "calc(100% - 34px)" }}>
                <iframe
                    ref={iframeRef}
                    src={src}
                    title="白模预演台"
                    allow="autoplay; fullscreen; pointer-lock; clipboard-read; clipboard-write"
                    style={{ width: "100%", height: "100%", border: "none", display: "block" }}
                />
                {phase !== "ready" ? (
                    <div
                        role={phase === "error" ? "alert" : "status"}
                        style={{
                            position: "absolute",
                            inset: 0,
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent: "center",
                            gap: 8,
                            padding: 20,
                            textAlign: "center",
                            background: ctx.theme.node.panel,
                            color: ctx.theme.node.text,
                            fontSize: 12,
                            lineHeight: 1.7,
                        }}
                    >
                        {phase === "loading" ? (
                            <>
                                <span style={{ fontWeight: 600 }}>正在加载白模预演台…</span>
                                <span style={{ opacity: 0.7, maxWidth: 420 }}>
                                    首次加载需下载约 5 MB 资源；若长时间无响应会自动重载一次。
                                </span>
                            </>
                        ) : (
                            <>
                                <span style={{ fontWeight: 600 }}>白模预演台加载失败</span>
                                <span style={{ opacity: 0.8, maxWidth: 440 }}>{failure}</span>
                                <span style={{ display: "flex", gap: 8, marginTop: 4 }}>
                                    <button
                                        type="button"
                                        onClick={() => reloadRegistry.get(nodeId)?.()}
                                        style={{
                                            cursor: "pointer",
                                            padding: "4px 12px",
                                            borderRadius: 6,
                                            border: "1px solid #0ea5e9",
                                            background: "transparent",
                                            color: "inherit",
                                        }}
                                    >
                                        重载
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => window.open(src, "_blank", "noopener")}
                                        style={{
                                            cursor: "pointer",
                                            padding: "4px 12px",
                                            borderRadius: 6,
                                            border: "1px solid rgba(127,127,127,.5)",
                                            background: "transparent",
                                            color: "inherit",
                                        }}
                                    >
                                        在新标签页打开
                                    </button>
                                </span>
                            </>
                        )}
                    </div>
                ) : null}
            </div>
        </div>
    );
}

const reloadRegistry = new Map<string, () => void>();
const exportRegistry = new Map<string, () => void>();
const dialogRegistry = new Map<string, () => void>();

export default definePlugin({
    id: "director-desk",
    name: "白模预演台",
    version: "1.1.0",
    description: "白模预演台：导入 glTF/GLB 模型、布置机位与灯光、实时预览，并可将预演视频导出为画布节点",
    nodes: [
        {
            type: "director-desk:scene",
            title: "白模预演台",
            icon: "🏗️",
            description: "白模预演工作台（模型导入 / 机位 / 灯光 / 实时预览 / 导出到画布）",
            defaultSize: { width: 800, height: 560 },
            defaultMetadata: {},
            minimapColor: "#0ea5e9",
            hasSourceHandle: true,
            // 始终可交互（操作 3D 视口）；拖拽靠宿主标题栏。与 jlmlh-3d-director 同策略。
            interactionToggle: false,
            Content: DirectorDeskContent,
            toolbar: (ctx) => [
                {
                    id: "reload",
                    title: "重新加载白模预演台",
                    label: "重载",
                    icon: "↻",
                    onClick: () => reloadRegistry.get(ctx.node.id)?.(),
                },
                {
                    id: "export-dialog",
                    title: "打开预演台「导出参考视频」弹窗（弹窗底部有「导出到画布」入口）",
                    label: "导出设置",
                    icon: "⚙",
                    onClick: () => dialogRegistry.get(ctx.node.id)?.(),
                },
                {
                    id: "export-to-canvas",
                    title: "按当前导出设置生成视频，直接作为画布视频节点（不下载文件）",
                    label: "导出到画布",
                    icon: "📤",
                    onClick: () => exportRegistry.get(ctx.node.id)?.(),
                },
            ],
        },
    ],
});
