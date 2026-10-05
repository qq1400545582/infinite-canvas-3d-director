import { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, CheckCircle2, Copy, FileImage, Link2, Loader2, PlugZap, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { buildBookmarkletHref, detectBookmarkletEnvironment, fetchBookmarkletSource } from "@/lib/bookmarklet";

/**
 * 网页版「发送到画布」发送台（/send）。
 *
 * 解决的问题：很多「工具内置浏览器」（各类桌面工具、IDE、聊天客户端的 webview）装不了浏览器扩展，
 * 而本机 Agent 的 Token 不应该让用户手工粘贴。这个页面跑在画布自己的源上：
 *   · Token 自动发现 —— 同源 GET /__canvas-agent/status（桌面宿主 / dev 服务提供，loopback 限定），
 *     拿不到时回退到 Agent 面板里已保存的 localStorage 值；
 *   · 画布连接状态 —— GET /health（公开）能看出当前有没有画布页面连着 Agent；
 *   · 发送 —— POST {agent}/api/tools { name: "canvas_create_node" }，与浏览器扩展同一条通路。
 *
 * 节点 payload 的形状与 browser-extension/media.js 的 buildCreateNodePayload 保持一致
 * （那边是经典脚本、无法被 ESM 引用；改一处请同步另一处，扩展与本页有相同形状的单测断言）。
 */

type SendItem = { id: string; name: string; status: "pending" | "sending" | "done" | "failed"; note?: string };

const DEFAULT_AGENT_URL = "http://127.0.0.1:17371";
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 8 * 1024 * 1024;
const MAX_BATCH = 20;

type SendFile = { file: File; kind: "image" | "video" };

/** 与扩展 media.js 相同的判定：只收图片 / 视频，type 为空时按扩展名兜底。 */
function classify(file: File): SendFile | null {
    const type = String(file.type || "");
    if (/^image\//i.test(type)) return { file, kind: "image" };
    if (/^video\//i.test(type)) return { file, kind: "video" };
    const name = file.name || "";
    if (/\.(?:png|jpe?g|gif|webp|avif|bmp|svg)$/i.test(name)) return { file, kind: "image" };
    if (/\.(?:mp4|webm|mov|m4v)$/i.test(name)) return { file, kind: "video" };
    return null;
}

/** 等比缩放到画布节点合适的尺寸（与扩展 fitNodeSize 同参同逻辑）。 */
function fitNodeSize(width: number, height: number) {
    const MAX_EDGE = 480;
    const MIN_EDGE = 240;
    const w = Number(width) || 0;
    const h = Number(height) || 0;
    if (w <= 0 || h <= 0) return { width: 360, height: 270 };
    const long = Math.max(w, h);
    const scale = long > MAX_EDGE ? MAX_EDGE / long : long < MIN_EDGE ? MIN_EDGE / long : 1;
    return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

function readAsDataUrl(file: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("read-failed"));
        reader.readAsDataURL(file);
    });
}

/** 列表 key：crypto.randomUUID 在非安全上下文（例如用局域网 IP 打开本机页面）不可用，故留退路。 */
let idSeed = 0;
function nextId() {
    const cryptoRef = typeof crypto !== "undefined" ? crypto : undefined;
    if (cryptoRef && typeof cryptoRef.randomUUID === "function") return cryptoRef.randomUUID();
    idSeed += 1;
    return `send-${Date.now().toString(36)}-${idSeed}`;
}

async function imageSize(dataUrl: string) {
    return await new Promise<{ width: number; height: number }>((resolve) => {
        const image = new Image();
        image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
        image.onerror = () => resolve({ width: 0, height: 0 });
        image.src = dataUrl;
    });
}

/** 构造 canvas_create_node 参数（形状与扩展 buildCreateNodePayload 一致）。 */
async function buildPayload(input: { kind: "image" | "video"; title: string; dataUrl?: string; url?: string; width?: number; height?: number; mimeType?: string }) {
    const kind = input.kind;
    const size = fitNodeSize(input.width || 0, input.height || 0);
    const mimeType = input.mimeType || (kind === "video" ? "video/mp4" : "");
    const metadata: Record<string, unknown> = { content: input.dataUrl || input.url || "", status: "success" };
    if (mimeType) metadata.mimeType = mimeType;
    if (Number(input.width) > 0 && Number(input.height) > 0) {
        metadata.naturalWidth = Math.round(Number(input.width));
        metadata.naturalHeight = Math.round(Number(input.height));
    }
    if (kind === "image" && input.dataUrl && /^https?:/i.test(String(input.url || ""))) metadata.remoteUrl = input.url;
    return { name: "canvas_create_node", input: { nodeType: kind, title: input.title, width: size.width, height: size.height, metadata } };
}

export default function SendPage() {
    const { t } = useTranslation();
    const [agentUrl, setAgentUrl] = useState(DEFAULT_AGENT_URL);
    const [token, setToken] = useState("");
    const [agentReady, setAgentReady] = useState(false);
    // 「/__canvas-agent/status 有响应」= 当前页面跑在桌面宿主 / dev 服务上，因而可以一键启动 Agent。
    const [canStartAgent, setCanStartAgent] = useState(false);
    const [startingAgent, setStartingAgent] = useState(false);
    const [canvasReady, setCanvasReady] = useState<boolean | null>(null);
    const [items, setItems] = useState<SendItem[]>([]);
    const [busy, setBusy] = useState(false);
    const [dragOver, setDragOver] = useState(false);
    const [urlText, setUrlText] = useState("");
    const [error, setError] = useState("");
    const [bookmarkletHref, setBookmarkletHref] = useState("");
    const [bookmarkletError, setBookmarkletError] = useState("");
    const [bookmarkletEnv, setBookmarkletEnv] = useState<{ installable: boolean; reason: "in-frame" | "embedded" | null }>({ installable: true, reason: null });
    const [copyState, setCopyState] = useState<"idle" | "copied" | "manual">("idle");
    const fileInputRef = useRef<HTMLInputElement>(null);
    const bookmarkletRef = useRef<HTMLAnchorElement>(null);

    // 书签只能装在「真正的浏览器窗口」里：iframe / Electron 内置浏览器没有书签栏可拖。
    useEffect(() => {
        setBookmarkletEnv(detectBookmarkletEnvironment({ inFrame: typeof window !== "undefined" && window.self !== window.top, userAgent: navigator.userAgent }));
    }, []);

    /** Token 就绪后生成书签 href。href 由 ref 回调在挂载时写入——不能在 effect 里写，那时锚点还不存在。 */
    useEffect(() => {
        if (!token) return;
        let canceled = false;
        setBookmarkletHref("");
        setBookmarkletError("");
        setCopyState("idle");
        (async () => {
            try {
                const source = await fetchBookmarkletSource();
                if (canceled) return;
                setBookmarkletHref(buildBookmarkletHref(source, { base: agentUrl, token }));
            } catch (e) {
                if (!canceled) setBookmarkletError(e instanceof Error ? e.message : String(e));
            }
        })();
        return () => {
            canceled = true;
        };
    }, [agentUrl, token]);

    /** 护栏：href 没真正落到 DOM 上时给出可见提示，而不是让用户面对一个拖不动的按钮却毫无线索。 */
    useEffect(() => {
        if (!bookmarkletHref) return;
        const applied = Boolean(bookmarkletRef.current?.getAttribute("href"));
        if (!applied) setBookmarkletError(t("sendPage.bookmarkletHrefMissing"));
    }, [bookmarkletHref, t]);

    /** 带 #bookmarklet 打开时（面板入口就是这种链接）滚到卡片并高亮一下，避免用户以为没跳转。 */
    useEffect(() => {
        if (location.hash !== "#bookmarklet") return;
        const scroll = () => document.getElementById("bookmarklet")?.scrollIntoView({ block: "center" });
        scroll();
        const timer = window.setTimeout(scroll, 400);
        return () => window.clearTimeout(timer);
    }, [bookmarkletHref]);

    /** 「在本页立即试一下」：直接执行书签脚本（等价于在当前页点一下那个书签）。 */    const runBookmarkletNow = useCallback(() => {
        if (!bookmarkletHref) return;
        const code = decodeURIComponent(bookmarkletHref.replace(/^javascript:/, ""));
        try {
            // eslint-disable-next-line no-new-func
            new Function(code)();
        } catch {
            setError(t("sendPage.bookmarkletRunFailed"));
        }
    }, [bookmarkletHref, t]);

    /** 复制书签代码：成功给反馈；失败则把代码摊成可选中的文本框，让用户 Ctrl+C（内置浏览器常见）。 */
    const copyBookmarklet = useCallback(async () => {
        if (!bookmarkletHref) return;
        try {
            if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
            await navigator.clipboard.writeText(bookmarkletHref);
            setCopyState("copied");
            return;
        } catch {
            /* 落到下面的手动兜底 */
        }
        try {
            const area = document.createElement("textarea");
            area.value = bookmarkletHref;
            area.setAttribute("readonly", "");
            area.style.position = "fixed";
            area.style.opacity = "0";
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand("copy");
            area.remove();
            setCopyState(ok ? "copied" : "manual");
        } catch {
            setCopyState("manual");
        }
    }, [bookmarkletHref]);

    // —— 令牌自动发现：同源 /__canvas-agent/status 优先，其次 Agent 面板保存过的值 ——
    useEffect(() => {
        let canceled = false;
        (async () => {
            const savedUrl = localStorage.getItem("canvas-agent-url") || "";
            const savedToken = localStorage.getItem("canvas-agent-token") || "";
            try {
                const response = await fetch("/__canvas-agent/status", { headers: { accept: "application/json" } });
                if (response.ok) {
                    const data = (await response.json()) as { running?: boolean; url?: string; token?: string | null };
                    if (canceled) return;
                    setCanStartAgent(true);
                    if (data.token) {
                        setAgentUrl(data.url || savedUrl || DEFAULT_AGENT_URL);
                        setToken(data.token);
                        setAgentReady(true);
                        return;
                    }
                }
            } catch {
                /* 桌面宿主 / dev 服务未启用时走下面的回退 */
            }
            if (canceled) return;
            if (savedToken) {
                setAgentUrl(savedUrl.replace(/\/$/, "") || DEFAULT_AGENT_URL);
                setToken(savedToken);
                setAgentReady(true);
            } else {
                setAgentUrl(savedUrl.replace(/\/$/, "") || DEFAULT_AGENT_URL);
            }
        })();
        return () => {
            canceled = true;
        };
    }, []);

    /** 一键启动本机 Agent（仅桌面宿主 / dev 服务提供该接口），启动后轮询直到拿到 Token。 */
    const startAgent = useCallback(async () => {
        setStartingAgent(true);
        setError("");
        try {
            await fetch("/__canvas-agent/start", { method: "POST" });
            for (let attempt = 0; attempt < 20; attempt += 1) {
                await new Promise((resolve) => window.setTimeout(resolve, 1500));
                const response = await fetch("/__canvas-agent/status", { headers: { accept: "application/json" } });
                if (!response.ok) continue;
                const data = (await response.json()) as { running?: boolean; url?: string; token?: string | null };
                if (data.token) {
                    setAgentUrl(data.url || DEFAULT_AGENT_URL);
                    setToken(data.token);
                    setAgentReady(true);
                    setStartingAgent(false);
                    return;
                }
            }
            setError(t("sendPage.startTimeout"));
        } catch {
            setError(t("sendPage.startFailed"));
        } finally {
            setStartingAgent(false);
        }
    }, [t]);

    // —— 画布是否已连接（/health 公开可读）——
    useEffect(() => {
        if (!agentReady) return;
        let canceled = false;
        const probe = async () => {
            try {
                const response = await fetch(`${agentUrl.replace(/\/$/, "")}/health`);
                if (!response.ok) return;
                const data = (await response.json()) as { clients?: number };
                if (!canceled) setCanvasReady((data.clients || 0) > 0);
            } catch {
                if (!canceled) setCanvasReady(false);
            }
        };
        void probe();
        const timer = window.setInterval(probe, 5000);
        return () => {
            canceled = true;
            window.clearInterval(timer);
        };
    }, [agentReady, agentUrl]);

    const send = useCallback(
        async (endpoint: string, accessToken: string, payload: unknown) => {
            const response = await fetch(`${endpoint.replace(/\/$/, "")}/api/tools?token=${encodeURIComponent(accessToken)}`, {
                method: "POST",
                headers: { "content-type": "application/json", "x-canvas-agent-token": accessToken },
                body: JSON.stringify(payload),
            });
            const data = (await response.json().catch(() => ({}))) as { ok?: boolean; error?: string };
            if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
        },
        [],
    );

    const sendFiles = useCallback(
        async (fileList: FileList | File[]) => {
            const endpoint = agentUrl.replace(/\/$/, "");
            if (!agentReady || !token) {
                setError(t("sendPage.needAgent"));
                return;
            }
            const files = [...fileList].map(classify).filter((item): item is SendFile => Boolean(item));
            if (!files.length) {
                setError(t("sendPage.noMedia"));
                return;
            }
            if (files.length > MAX_BATCH) {
                setError(t("sendPage.tooMany", { count: files.length, max: MAX_BATCH }));
                return;
            }
            setError("");
            setBusy(true);
            const list: SendItem[] = files.map((item) => ({ id: nextId(), name: item.file.name, status: "sending" }));
            setItems((prev) => [...list, ...prev].slice(0, MAX_BATCH));
            for (let index = 0; index < files.length; index += 1) {
                const { file, kind } = files[index];
                const id = list[index].id;
                const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
                try {
                    if (file.size > limit) throw new Error(t("sendPage.tooLarge", { limit: Math.round(limit / 1024 / 1024) }));
                    const dataUrl = await readAsDataUrl(file);
                    const size = kind === "image" ? await imageSize(dataUrl) : { width: 0, height: 0 };
                    const payload = await buildPayload({ kind, title: file.name || t(kind === "video" ? "sendPage.localVideo" : "sendPage.localImage"), dataUrl, mimeType: file.type });
                    await send(endpoint, token, payload);
                    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "done", note: t("sendPage.inlined") } : item)));
                } catch (e) {
                    setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "failed", note: e instanceof Error ? e.message : String(e) } : item)));
                }
            }
            setBusy(false);
        },
        [agentReady, agentUrl, send, t, token],
    );

    const sendUrl = useCallback(async () => {
        const endpoint = agentUrl.replace(/\/$/, "");
        const url = urlText.trim();
        if (!url) return;
        if (!agentReady || !token) {
            setError(t("sendPage.needAgent"));
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            setError(t("sendPage.badUrl"));
            return;
        }
        setError("");
        setBusy(true);
        const isVideo = /\.(?:mp4|webm|mov|m4v)(?:\?|#|$)/i.test(url);
        const id = nextId();
        const name = decodeURIComponent(url.split("/").filter(Boolean).pop() || url);
        setItems((prev) => [{ id, name, status: "sending" as const }, ...prev].slice(0, MAX_BATCH));
        try {
            // 网页上下文没有扩展的 host_permissions，跨域媒体多半抓不动：先试一次，成功就内嵌，失败就按外链发。
            // 视频同样内嵌（画布 <video src> 吃 dataURL），能避免「节点建好但一片黑屏」。
            const limit = isVideo ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
            let dataUrl = "";
            const typeOk = (type: string) => (isVideo ? /^video\//i.test(type) : /^image\//i.test(type));
            try {
                const response = await fetch(url, { credentials: "omit", referrerPolicy: "no-referrer" });
                const length = Number(response.headers.get("content-length") || 0);
                if (response.ok && !(length > limit)) {
                    const blob = await response.blob();
                    if (blob.size <= limit && (!blob.type || typeOk(blob.type))) dataUrl = await readAsDataUrl(blob);
                }
            } catch {
                dataUrl = "";
            }
            const size = dataUrl && !isVideo ? await imageSize(dataUrl) : { width: 0, height: 0 };
            const payload = await buildPayload({
                kind: isVideo ? "video" : "image",
                title: name.slice(0, 60),
                dataUrl: dataUrl || undefined,
                url,
                width: size.width,
                height: size.height,
                mimeType: isVideo ? "video/mp4" : undefined,
            });
            await send(endpoint, token, payload);
            setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "done", note: dataUrl ? t("sendPage.inlined") : t("sendPage.linkOnly") } : item)));
        } catch (e) {
            setItems((prev) => prev.map((item) => (item.id === id ? { ...item, status: "failed", note: e instanceof Error ? e.message : String(e) } : item)));
        }
        setBusy(false);
        setUrlText("");
    }, [agentReady, agentUrl, send, t, token, urlText]);

    // 整页粘贴：截图 / 复制的图片文件
    useEffect(() => {
        const onPaste = (event: ClipboardEvent) => {
            const files = event.clipboardData?.files;
            if (!files?.length) return;
            event.preventDefault();
            void sendFiles(files);
        };
        window.addEventListener("paste", onPaste);
        return () => window.removeEventListener("paste", onPaste);
    }, [sendFiles]);

    const doneCount = items.filter((item) => item.status === "done").length;
    const failedCount = items.filter((item) => item.status === "failed").length;

    return (
        <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
            <main className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto bg-background px-5 py-8 text-stone-900 dark:text-stone-100">
                <div className="w-full max-w-2xl">
                    <header className="mb-6">
                        <h1 className="text-2xl font-semibold tracking-normal">{t("sendPage.title")}</h1>
                        <p className="mt-2 text-sm leading-6 text-stone-500 dark:text-stone-400">{t("sendPage.description")}</p>
                    </header>

                    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
                        <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 ${
                                agentReady ? "border-emerald-500/40 text-emerald-600 dark:text-emerald-400" : "border-amber-500/40 text-amber-600 dark:text-amber-400"
                            }`}
                        >
                            {agentReady ? <CheckCircle2 className="size-3.5" /> : <PlugZap className="size-3.5" />}
                            {agentReady ? t("sendPage.agentReady") : t("sendPage.agentMissing")}
                        </span>
                        {canvasReady === false ? (
                            <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 px-2.5 py-1 text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="size-3.5" />
                                {t("sendPage.canvasMissing")}
                            </span>
                        ) : null}
                        {!agentReady && canStartAgent ? (
                            <button
                                type="button"
                                onClick={() => void startAgent()}
                                disabled={startingAgent}
                                className="inline-flex items-center gap-1.5 rounded-full border border-stone-300 px-2.5 py-1 transition hover:border-stone-900 disabled:opacity-50 dark:border-stone-700 dark:hover:border-stone-100"
                            >
                                {startingAgent ? <Loader2 className="size-3.5 animate-spin" /> : <PlugZap className="size-3.5" />}
                                {startingAgent ? t("sendPage.starting") : t("sendPage.startAgent")}
                            </button>
                        ) : null}
                    </div>

                    <div
                        onDragEnter={(event) => {
                            event.preventDefault();
                            setDragOver(true);
                        }}
                        onDragOver={(event) => event.preventDefault()}
                        onDragLeave={() => setDragOver(false)}
                        onDrop={(event) => {
                            event.preventDefault();
                            setDragOver(false);
                            if (event.dataTransfer?.files?.length) void sendFiles(event.dataTransfer.files);
                        }}
                        className={`rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
                            dragOver ? "border-stone-900 bg-stone-50 dark:border-stone-100 dark:bg-stone-900" : "border-stone-300 dark:border-stone-700"
                        }`}
                    >
                        <Upload className="mx-auto size-7 text-stone-400" />
                        <div className="mt-3 text-sm font-medium">{t("sendPage.dropTitle")}</div>
                        <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">{t("sendPage.dropHint")}</div>
                        <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                            <button
                                type="button"
                                onClick={() => fileInputRef.current?.click()}
                                className="inline-flex h-9 items-center gap-2 rounded-lg bg-stone-950 px-4 text-sm font-medium text-white transition hover:bg-stone-800 dark:bg-stone-100 dark:text-stone-950"
                            >
                                <FileImage className="size-4" />
                                {t("sendPage.pick")}
                            </button>
                            <input
                                ref={fileInputRef}
                                type="file"
                                accept="image/*,video/*"
                                multiple
                                hidden
                                onChange={(event) => {
                                    if (event.target.files?.length) void sendFiles(event.target.files);
                                    event.target.value = "";
                                }}
                            />
                        </div>
                        <div className="mt-3 text-[11px] text-stone-400">{t("sendPage.pasteHint")}</div>
                    </div>

                    <div className="mt-3 flex items-center gap-2">
                        <input
                            value={urlText}
                            onChange={(event) => setUrlText(event.target.value)}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") void sendUrl();
                            }}
                            placeholder={t("sendPage.urlPlaceholder")}
                            className="h-9 min-w-0 flex-1 rounded-lg border border-stone-300 bg-transparent px-3 text-sm outline-none transition focus:border-stone-900 dark:border-stone-700 dark:focus:border-stone-100"
                        />
                        <button
                            type="button"
                            onClick={() => void sendUrl()}
                            disabled={busy || !urlText.trim()}
                            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg border border-stone-300 px-3 text-sm transition hover:border-stone-900 disabled:opacity-50 dark:border-stone-700 dark:hover:border-stone-100"
                        >
                            <Link2 className="size-4" />
                            {t("sendPage.sendUrl")}
                        </button>
                    </div>
                    <div className="mt-1.5 text-[11px] leading-4 text-stone-400">{t("sendPage.urlHint")}</div>

                    {error ? (
                        <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">{error}</div>
                    ) : null}

                    {/* —— 书签小工具：装不了扩展的浏览器（IE 内核 360、老版 Firefox 等）走这条 —— */}
                    <section id="bookmarklet" className="mt-6 scroll-mt-6 rounded-xl border border-stone-200 p-4 dark:border-stone-800">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                                <h2 className="text-sm font-semibold">{t("sendPage.bookmarkletTitle")}</h2>
                                <p className="mt-1 text-xs leading-5 text-stone-500 dark:text-stone-400">{t("sendPage.bookmarkletDesc")}</p>
                            </div>
                            {token ? <span className="shrink-0 text-[11px] text-stone-400">{t("sendPage.bookmarkletReady")}</span> : null}
                        </div>

                        {!token ? (
                            <div className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
                                {t("sendPage.bookmarkletNeedAgent")}
                            </div>
                        ) : bookmarkletHref ? (
                            <div className="mt-3 grid gap-2.5">
                                {!bookmarkletEnv.installable ? (
                                    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs leading-5 text-amber-700 dark:text-amber-400">
                                        {t(bookmarkletEnv.reason === "in-frame" ? "sendPage.bookmarkletInFrame" : "sendPage.bookmarkletEmbedded")}
                                    </div>
                                ) : (
                                    <ol className="grid gap-1 text-xs leading-5 text-stone-600 dark:text-stone-300">
                                        <li>{t("sendPage.bookmarkletStep1")}</li>
                                        <li>{t("sendPage.bookmarkletStep2")}</li>
                                        <li>{t("sendPage.bookmarkletStep3")}</li>
                                    </ol>
                                )}
                                <div className="flex flex-wrap items-center gap-2">
                                    {/* href 由 ref 回调在挂载时直写：React 会拦截渲染期的 javascript: URL，
                                        而书签栏拖拽需要的正是这个属性本身（不经过 React 的点击代理）。 */}
                                    <a
                                        ref={(element) => {
                                            bookmarkletRef.current = element;
                                            if (element) element.setAttribute("href", bookmarkletHref);
                                        }}
                                        onClick={(event) => event.preventDefault()}
                                        draggable
                                        title={t("sendPage.bookmarkletDragTitle")}
                                        className="inline-flex h-9 cursor-grab select-none items-center gap-2 rounded-lg bg-stone-950 px-4 text-sm font-medium text-white active:cursor-grabbing dark:bg-stone-100 dark:text-stone-950"
                                    >
                                        <Link2 className="size-4" />
                                        {t("sendPage.bookmarkletButton")}
                                    </a>
                                    <button
                                        type="button"
                                        onClick={() => void runBookmarkletNow()}
                                        title={t("sendPage.bookmarkletRunTitle")}
                                        className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 px-3 text-sm transition hover:border-stone-900 dark:border-stone-700 dark:hover:border-stone-100"
                                    >
                                        {t("sendPage.bookmarkletRunHere")}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => void copyBookmarklet()}
                                        className="inline-flex h-9 items-center gap-2 rounded-lg border border-stone-300 px-3 text-sm transition hover:border-stone-900 dark:border-stone-700 dark:hover:border-stone-100"
                                    >
                                        {copyState === "copied" ? <CheckCircle2 className="size-4 text-emerald-600 dark:text-emerald-400" /> : <Copy className="size-4" />}
                                        {copyState === "copied" ? t("sendPage.bookmarkletCopied") : t("sendPage.bookmarkletCopy")}
                                    </button>
                                </div>
                                {copyState === "manual" ? (
                                    <div className="grid gap-1.5">
                                        <div className="text-[11px] leading-4 text-amber-700 dark:text-amber-400">{t("sendPage.bookmarkletCopyManual")}</div>
                                        {/* 自动复制被浏览器拒绝时的兜底：把代码摊成可选中文本框，用户按 Ctrl+C */}
                                        <textarea
                                            readOnly
                                            value={bookmarkletHref}
                                            onFocus={(event) => event.currentTarget.select()}
                                            rows={3}
                                            className="w-full resize-y rounded-lg border border-stone-300 bg-transparent p-2 font-mono text-[11px] leading-4 outline-none dark:border-stone-700"
                                        />
                                    </div>
                                ) : null}
                                <div className="text-[11px] leading-4 text-stone-400">{t("sendPage.bookmarkletDragHint")}</div>
                                <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] leading-4 text-amber-700 dark:text-amber-400">
                                    {t("sendPage.bookmarkletSecurity")}
                                </div>
                            </div>
                        ) : (
                            <div className="mt-3 text-xs text-stone-400">{bookmarkletError || t("sendPage.bookmarkletLoading")}</div>
                        )}
                    </section>

                    {items.length ? (
                        <div className="mt-5">
                            <div className="mb-2 flex items-center justify-between text-xs text-stone-500 dark:text-stone-400">
                                <span>{t("sendPage.summary", { done: doneCount, failed: failedCount, total: items.length })}</span>
                                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                            </div>
                            <ul className="grid gap-1.5">
                                {items.map((item) => (
                                    <li key={item.id} className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 text-xs dark:border-stone-800">
                                        {item.status === "done" ? (
                                            <CheckCircle2 className="size-3.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                                        ) : item.status === "failed" ? (
                                            <AlertTriangle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />
                                        ) : (
                                            <Loader2 className="size-3.5 shrink-0 animate-spin text-stone-400" />
                                        )}
                                        <span className="min-w-0 flex-1 truncate">{item.name}</span>
                                        <span className="shrink-0 text-stone-400">{item.note || ""}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}
                </div>
            </main>
        </div>
    );
}
