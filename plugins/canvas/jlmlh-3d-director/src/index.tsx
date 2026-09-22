import { definePlugin, useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";
import { exportCaptures, captureLiveView, exportVideoFromFrame, exportVideoNode, isImageUrl, publishCapture, readCaptures, upstreamBackground, type Capture } from "./media-bridge";

// Official React 18/R3F application remains unchanged; host React 19 is never bundled.
const APP_ENTRY = "/jlmlh-3d-director/index.html";
function getHostTheme(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

function DirectorDeskContent({ ctx }: CanvasNodeContentProps) {
  const nodeId = ctx.node.id;
  const latest = useRef(ctx);
  latest.current = ctx;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadError, setLoadError] = useState(false);
  const [status, setStatus] = useState("");
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [hovered, setHovered] = useState(false);
  const [src] = useState(() => `${APP_ENTRY}?instanceId=${encodeURIComponent(nodeId)}&theme=${getHostTheme()}`);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    const origin = window.location.origin;
    const key = `storyai-3d-director-desk-demo:${nodeId}`;
    let ready = false;
    let backgroundKey = "";
    let dismissedKey = "";
    let snapshot: string | null = null;
    let currentCaptures: Capture[] = [];
    let currentOutput: Capture | undefined;
    const post = (data: unknown) => frame.contentWindow?.postMessage(data, origin);
    const sync = () => {
      if (!ready) return;
      const context = latest.current;
      const background = upstreamBackground(context);
      const signature = background ? JSON.stringify(background) : "";
      if (!background) { backgroundKey = ""; dismissedKey = ""; }
      else if (signature !== backgroundKey && signature !== dismissedKey) {
        post({ type: "storyai:director-desk-panorama", payload: background });
        backgroundKey = signature;
      }
      // Read only this iframe instance's official persisted captures. No vendor store mutation.
      try {
        const raw = window.localStorage.getItem(key);
        if (raw !== snapshot) {
          snapshot = raw;
          const next = readCaptures(raw);
          const added = next.filter((cap) => !currentCaptures.some((old) => old.id === cap.id && old.dataUrl === cap.dataUrl));
          if (added.length) currentOutput = added[added.length - 1];
          currentCaptures = next;
          setCaptures(next);
        }
      } catch { /* Storage disabled/full: explicit official send-to-canvas still works. */ }
      if (currentOutput) publishCapture(context, currentOutput);
      else {
        const content = context.getNode(nodeId)?.metadata?.content;
        if (isImageUrl(content)) publishCapture(context, { dataUrl: content });
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frame.contentWindow) return;
      const data = event.data;
      if (data?.type === "storyai:director-desk-ready") {
        if (ready) return; // Never reset a live scene by sending the session repeatedly.
        ready = true;
        post({ type: "storyai:director-desk-session", payload: { instanceId: nodeId, theme: getHostTheme() } });
        sync();
      } else if (data?.type === "storyai:director-desk-captures-sent") {
        const batch = Array.isArray(data.payload?.captures)
          ? data.payload.captures.filter((cap: Capture) => cap && isImageUrl(cap.dataUrl)) : [];
        if (batch.length) {
          currentOutput = batch[batch.length - 1];
          exportCaptures(latest.current, batch);
          setStatus(`已导出 ${batch.length} 张到画布`);
        }
      } else if (data?.type === "storyai:director-desk-panorama-removed") {
        // Respect manual removal inside the editor, instead of importing it again each tick.
        const background = upstreamBackground(latest.current);
        if (background?.edgeId === data.payload?.edgeId) dismissedKey = JSON.stringify(background);
      }
    };
    const onLoad = () => { ready = false; backgroundKey = ""; dismissedKey = ""; };
    // ready normally occurs before iframe load: do not clear ready in the load event.
    // Reload requests below create a fresh component via iframe navigation and its ready message.
    const onStorage = (event: StorageEvent) => { if (event.key === key) sync(); };
    window.addEventListener("message", onMessage);
    window.addEventListener("storage", onStorage);
    const timer = window.setInterval(sync, 1000);
    const reset = () => { onLoad(); frame.src = frame.src; };
    reloadRegistry.set(nodeId, reset);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("message", onMessage);
      window.removeEventListener("storage", onStorage);
      reloadRegistry.delete(nodeId);
    };
  }, [nodeId]);

  const [exporting, setExporting] = useState(false);

  const [exportKind, setExportKind] = useState("image");
  const exportController = useRef<AbortController | null>(null);
  useEffect(() => () => exportController.current?.abort(), []);

  const exportAll = async () => {
    if (exportController.current) return;
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setStatus("正在导出…");
    let imageCount = 0;
    try {
      if (exportKind !== "video") {
        let batch = captures;
        try { batch = readCaptures(window.localStorage.getItem(`storyai-3d-director-desk-demo:${nodeId}`)); } catch { /* fallback */ }
        if (!batch.length) {
          const live = captureLiveView(iframeRef.current);
          batch = live ? [live] : [];
        }
        if (!batch.length) throw new Error("未找到画面，请在导演台中先加载场景");
        if (!exportCaptures(latest.current, batch)) throw new Error("没有可导出的图片");
        imageCount = batch.length;
        setStatus(`已导出 ${imageCount} 张图片到画布`);
      }
      if (exportKind !== "image") {
        setStatus(`${imageCount ? `已导出 ${imageCount} 张图片；` : ""}正在生成时间轴视频…`);
        const video = await exportVideoFromFrame(iframeRef.current, controller.signal);
        if (controller.signal.aborted) return;
        exportVideoNode(latest.current, video, imageCount);
        setStatus(`已导出${imageCount ? ` ${imageCount} 张图片和` : ""} 1 个视频到画布`);
      }
    } catch (error) {
      if (!controller.signal.aborted) setStatus(`${imageCount ? `已导出 ${imageCount} 张图片；` : ""}${error instanceof Error ? error.message : "导出失败，请重试"}`);
    } finally {
      exportController.current = null;
      if (!controller.signal.aborted) setExporting(false);
    }
  };

  return (
    <div data-canvas-no-zoom onPointerEnter={() => setHovered(true)} onPointerLeave={() => setHovered(false)}
      style={{ position: "relative", width: "100%", height: "100%", borderRadius: 16, overflow: "hidden",
        outline: "2px solid #2f80ff", outlineOffset: -2,
        boxShadow: hovered || ctx.isSelected ? "0 0 0 4px rgba(47,128,255,.25), 0 0 22px rgba(47,128,255,.35)" : "0 0 12px rgba(47,128,255,.18)" }}>
      <div style={{ height: 34, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 10px",
        background: ctx.theme.node.panel, color: ctx.theme.node.text, fontSize: 12 }}>
        <span role="status">{status || "上游图片自动同步 · 截图供下游引用"}</span>
        <select aria-label="导出内容" value={exportKind} disabled={exporting} onChange={(event) => setExportKind(event.target.value)}
          style={{ marginLeft: "auto", marginRight: 8, background: ctx.theme.node.panel, color: "inherit", border: "1px solid #2f80ff", borderRadius: 4 }}>
          <option value="image">图片</option><option value="video">视频（上帝视角）</option><option value="both">图片和视频</option>
        </select>
        <button type="button" onClick={() => void exportAll()} disabled={exporting} style={{ cursor: exporting ? "wait" : "pointer", padding: "3px 9px", borderRadius: 6,
          border: "1px solid #2f80ff", background: "transparent", color: "inherit", opacity: exporting ? 0.6 : 1 }}>一键导出到画布</button>
      </div>
      {loadError ? <div role="alert" style={{ padding: 20 }}>3D 导演台加载失败，请重新加载插件。</div> :
        <iframe ref={iframeRef} src={src} title="3D 导演台" onError={() => setLoadError(true)} allow="autoplay; fullscreen"
          style={{ width: "100%", height: "calc(100% - 34px)", border: "none", display: "block" }} />}
    </div>
  );
}
const reloadRegistry = new Map<string, () => void>();
export default definePlugin({
  id: "jlmlh-3d-director", name: "3D 导演台节点", version: "1.0.0",
  description: "三维导演台：上游背景同步、机位与时间线、截图自动输出及一键导出画布",
  nodes: [{
    type: "jlmlh-3d-director:scene", title: "3D 导演台", icon: "3D",
    description: "三维导演工作台（对象 / 机位 / 时间线 / 截图）",
    defaultSize: { width: 760, height: 520 }, defaultMetadata: {}, minimapColor: "#7c3aed",
    hasSourceHandle: true,
    interactionToggle: false, // Always interactive, including after content is populated. Drag by the host title bar.
    resource: (node) => isImageUrl(node.metadata?.content) ? { kind: "image", url: node.metadata.content } : null,
    Content: DirectorDeskContent,
    toolbar: (ctx) => [{ id: "reload", title: "重新加载 3D 导演台", label: "重载", icon: "↻",
      onClick: () => reloadRegistry.get(ctx.node.id)?.() }],
  }],
});
