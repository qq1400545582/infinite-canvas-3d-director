import type { CanvasNodeContext, CanvasAgentOp } from "@infinite-canvas/plugin-sdk";

export type Capture = { dataUrl: string; fileName?: string; id?: string };
export function isImageUrl(value: unknown): value is string {
  return typeof value === "string" && /^(data:image\/(png|jpeg|webp);base64,|blob:|https?:\/\/|\/)/i.test(value);
}
export function readCaptures(raw: string | null): Capture[] {
  if (!raw) return [];
  try {
    const state = JSON.parse(raw);
    const cameras = state?.project?.cameras;
    if (!Array.isArray(cameras)) return [];
    return cameras.flatMap((camera) => Array.isArray(camera?.captures) ? camera.captures : [])
      .filter((cap) => cap && isImageUrl(cap.dataUrl))
      .map((cap) => ({ dataUrl: cap.dataUrl, fileName: `${cap.name || "导演台截图"}.png`, id: cap.id }));
  } catch { return []; }
}

// The official bridge supports one background at a time, not text-to-scene generation.
export function upstreamBackground(ctx: CanvasNodeContext) {
  for (const up of ctx.getUpstream()) {
    if (up.id === ctx.node.id || (up.type !== "image" && up.type !== "panorama:viewer")) continue;
    const content = up.metadata?.content;
    if (!isImageUrl(content)) continue;
    const edge = ctx.getConnections().find((c) => c.fromNodeId === up.id && c.toNodeId === ctx.node.id);
    if (edge) return { edgeId: edge.id, sourceNodeId: up.id, imageUrl: content, fileName: up.title || "画布背景.png" };
  }
  return null;
}

export function publishCapture(ctx: CanvasNodeContext, capture: Capture) {
  if (!isImageUrl(capture.dataUrl)) return;
  const own = ctx.getNode(ctx.node.id) || ctx.node;
  if (own.metadata?.content !== capture.dataUrl) ctx.updateMetadata({ content: capture.dataUrl });
  // All downstream generators already consume the resource via their upstream graph.
  // Only fill empty image receivers or our previously managed outputs; never overwrite user work.
  const ops: CanvasAgentOp[] = [];
  for (const down of ctx.getDownstream()) {
    if (down.id === ctx.node.id || down.type !== "image") continue;
    const meta = down.metadata || {};
    const marker = meta.directorInput as { source?: string; content?: string } | undefined;
    const managed = marker?.source === ctx.node.id && meta.content === marker.content;
    if (meta.content === capture.dataUrl) continue;
    if (!managed && (meta.content || meta.prompt || (Array.isArray(meta.images) && meta.images.length) || meta.directorInput)) continue;
    ops.push({ type: "update_node", id: down.id, metadata: {
      content: capture.dataUrl,
      directorInput: { source: ctx.node.id, content: capture.dataUrl },
    } });
  }
  if (ops.length) ctx.applyOps(ops);
}

export function exportCaptures(ctx: CanvasNodeContext, captures: Capture[]) {
  const valid = captures.filter((cap) => isImageUrl(cap.dataUrl));
  if (!valid.length) return false;
  const own = ctx.getNode(ctx.node.id) || ctx.node;
  const ops: CanvasAgentOp[] = valid.map((cap, i) => ({
    type: "add_node", nodeType: "image", title: cap.fileName || `导演台截图 ${i + 1}`,
    position: { x: own.position.x + own.width + 48, y: own.position.y + i * 384 },
    width: 360, height: 360, metadata: { content: cap.dataUrl, freeResize: true },
  }));
  ctx.applyOps(ops);
  publishCapture(ctx, valid[valid.length - 1]);
  return true;
}

// Capture only the requested official video download in this iframe. Fetch starts before
// the vendor immediately revokes the object URL. Other downloads remain untouched.
export function exportVideoFromFrame(frame: HTMLIFrameElement | null, signal: AbortSignal): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const win = frame?.contentWindow as (Window & typeof globalThis) | null;
    const doc = frame?.contentDocument;
    const button = Array.from(doc?.querySelectorAll<HTMLButtonElement>("button") || [])
      .find((item) => item.textContent?.trim() === "导出视频·上帝视角");
    if (!win || !doc || !button || button.disabled) {
      reject(new Error("视频导出尚未就绪或正在导出，请等待导演台加载完成")); return;
    }
    if (signal.aborted) { reject(new Error("导出已取消")); return; }
    const proto = win.HTMLAnchorElement.prototype;
    const original = proto.click;
    let received = false;
    let busy = false;
    let ticks = 0;
    let settled = false;
    const cleanup = () => {
      if (proto.click === intercept) proto.click = original;
      window.clearInterval(timer);
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      frame?.removeEventListener("load", abort);
    };
    const fail = (error: Error) => { if (!settled) { settled = true; cleanup(); reject(error); } };
    const abort = () => fail(new Error("导演台已关闭或重载，视频导出已取消"));
    function intercept(this: HTMLAnchorElement) {
      if (received || this.ownerDocument !== doc || !/^director-desk-.*\.(mp4|webm)$/i.test(this.download) || !this.href.startsWith("blob:")) {
        return original.call(this);
      }
      received = true;
      const fileName = this.download;
      const response = win!.fetch(this.href, { signal });
      if (proto.click === intercept) proto.click = original;
      void response.then((res) => res.blob()).then((blob) => {
        if (!blob.size) throw new Error("导演台生成了空视频，请重试");
        return new Promise<string>((done, error) => {
          const reader = new FileReader();
          reader.onload = () => done(String(reader.result));
          reader.onerror = () => error(new Error("读取视频失败"));
          reader.readAsDataURL(blob);
        });
      }).then((dataUrl) => {
        if (!settled) { settled = true; cleanup(); resolve({ dataUrl, fileName }); }
      }).catch((error) => fail(error instanceof Error ? error : new Error("视频导出失败")));
    }
    const timer = window.setInterval(() => {
      if (received) return;
      ticks++;
      busy ||= button.disabled;
      if ((busy && !button.disabled) || (!busy && ticks > 20)) fail(new Error("视频生成未完成，请查看导演台内的错误提示后重试"));
    }, 250);
    const timeout = window.setTimeout(() => fail(new Error("视频导出超时，请缩短时间轴后重试")), 600000);
    signal.addEventListener("abort", abort, { once: true });
    frame?.addEventListener("load", abort, { once: true });
    proto.click = intercept;
    try { button.click(); } catch (error) { fail(error instanceof Error ? error : new Error("无法启动视频导出")); }
  });
}

export function exportVideoNode(ctx: CanvasNodeContext, video: Capture, imageCount = 0) {
  if (!/^data:video\/(mp4|webm)(?:;[^,]*)?,/i.test(video.dataUrl)) throw new Error("导演台返回的视频格式无效");
  const own = ctx.getNode(ctx.node.id) || ctx.node;
  ctx.applyOps([{ type: "add_node", nodeType: "video", title: video.fileName || "导演台视频",
    position: { x: own.position.x + own.width + 48, y: own.position.y + imageCount * 384 },
    width: 360, height: 240, metadata: { content: video.dataUrl, freeResize: true } }]);
}

// Same-origin iframe: the official canvas enables preserveDrawingBuffer, so the live
// viewport can always be grabbed even when no screenshot was taken inside the editor.
export function captureLiveView(frame: HTMLIFrameElement | null, label = "导演台画面"): Capture | null {
  try {
    const canvas = frame?.contentDocument?.querySelector<HTMLCanvasElement>(".director-canvas canvas");
    if (!canvas) return null;
    const out = document.createElement("canvas");
    out.width = canvas.width || 1280;
    out.height = canvas.height || 720;
    const context = out.getContext("2d");
    if (!context) return null;
    context.drawImage(canvas, 0, 0, out.width, out.height);
    const dataUrl = out.toDataURL("image/png");
    return isImageUrl(dataUrl) ? { dataUrl, fileName: `${label}.png` } : null;
  } catch {
    return null;
  }
}
