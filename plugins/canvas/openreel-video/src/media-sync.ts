// 上游媒体同步：把与被连接（连线）到 OpenReel 节点的「图片 / 视频」节点产出的内容，
// 自动灌进 OpenReel 编辑器的媒体库。
//
// 为什么放在插件侧而不是改编辑器：宿主插件能读到画布连线与上游节点，编辑器只负责收文件。
// 编辑器侧仍走它自己的 `importMedia`（与「导入媒体」按钮同一条链路），功能逻辑零改动。
//
// 同步协议（同名频道见 app/apps/web/src/bridges/canvas-host-bridge.ts）：
//   插件 → iframe  { channel, type: "import-files", requestId, items:[{id,name}], files:[File...] }
//   iframe → 插件  { channel, type: "import-result", requestId, results:[{id, ok, skipped?, error?}] }
//   iframe → 插件  { channel, type: "ready" } / { channel, type: "focus", focused: boolean }
//
// 文件通过 postMessage 的 structured clone 直接传 File 对象（浏览器按引用克隆 Blob，不做 base64 拷贝），
// 因此大视频也不会产生额外的内存/编码开销。

import type { CanvasNodeData } from "@infinite-canvas/plugin-sdk";

export const CANVAS_HOST_BRIDGE_CHANNEL = "openreel-canvas-host";

/** 会被灌进媒体库的上游节点类型（本次需求：图片节点、视频节点） */
const MEDIA_NODE_TYPES = new Set(["image", "video"]);

/** 同一批未确认媒体两次推送之间的最小间隔（毫秒） */
const RETRY_INTERVAL_MS = 8000;

/** 单个媒体最多尝试次数，避免宿主桥缺失时无限重试 */
const MAX_ATTEMPTS = 3;

export type UpstreamMediaItem = {
  /** 稳定去重键：内容指纹（同一份媒体被多个节点引用只导入一次） */
  id: string;
  /** 媒体库里的文件名 */
  name: string;
  mimeType: string;
  /** data: URL / blob: URL / http(s) URL */
  url: string;
};

export type MediaSyncState = {
  acknowledged: Set<string>;
  attempts: Map<string, number>;
  lastPushAt: number;
  busy: boolean;
};

export function createMediaSyncState(): MediaSyncState {
  return { acknowledged: new Set(), attempts: new Map(), lastPushAt: 0, busy: false };
}

/** 重新加载编辑器后清空「已导入」记忆：由编辑器侧持久化去重兜底，不会重复导入 */
export function resetMediaSyncState(state: MediaSyncState): void {
  state.acknowledged.clear();
  state.attempts.clear();
  state.lastPushAt = 0;
  state.busy = false;
}

const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
};

function dataUrlMime(url: string): string {
  const matched = /^data:([^;,]+)[;,]/.exec(url);
  return matched ? matched[1].toLowerCase() : "";
}

function extensionOf(mimeType: string, fallback: string): string {
  return MIME_EXTENSIONS[mimeType] || fallback;
}

function sanitizeName(raw: string, fallback: string): string {
  const cleaned = raw.replace(/[\\/:*?"<>|\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return (cleaned || fallback).slice(0, 60);
}

/**
 * 内容指纹：只取长度与三处采样，避免对超长 data URL 做整串哈希（每次轮询都会调用）。
 * 换图 / 换视频会得到新指纹，从而触发新的导入。
 */
function fingerprint(url: string): string {
  const length = url.length;
  if (length <= 256) return `${length}:${url}`;
  const mid = Math.floor(length / 2);
  return [
    length,
    url.slice(96, 128),
    url.slice(mid, mid + 32),
    url.slice(length - 48),
  ].join(":");
}

function collectFromNode(node: CanvasNodeData): UpstreamMediaItem[] {
  const type = node.type;
  if (!MEDIA_NODE_TYPES.has(type)) return [];

  const contents: string[] = [];
  const metadata = node.metadata ?? {};
  const primary = metadata.content;
  if (typeof primary === "string" && primary) contents.push(primary);

  // 图片节点可能是「批量图」根节点，包含多张图（metadata.images[].content）
  const batch = metadata.images;
  if (Array.isArray(batch)) {
    for (const entry of batch) {
      const content =
        entry && typeof entry === "object"
          ? (entry as { content?: unknown }).content
          : undefined;
      if (typeof content === "string" && content) contents.push(content);
    }
  }

  const isVideo = type === "video";
  const fallbackMime = isVideo ? "video/mp4" : "image/png";
  const fallbackExt = isVideo ? "mp4" : "png";
  const baseTitle = sanitizeName(node.title || "", isVideo ? "video" : "image");

  return contents.map((url, index) => {
    const mimeType = dataUrlMime(url) || fallbackMime;
    const extension = extensionOf(mimeType, fallbackExt);
    const suffix = contents.length > 1 ? `-${index + 1}` : "";
    return {
      id: fingerprint(url),
      name: `${baseTitle}${suffix}.${extension}`,
      mimeType,
      url,
    };
  });
}

/** 汇总所有上游连线节点产出的图片 / 视频媒体（按指纹去重） */
export function collectUpstreamMedia(upstream: CanvasNodeData[]): UpstreamMediaItem[] {
  const byId = new Map<string, UpstreamMediaItem>();
  for (const node of upstream) {
    for (const item of collectFromNode(node)) {
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
  }
  return Array.from(byId.values());
}

async function fetchAsFile(item: UpstreamMediaItem): Promise<File | null> {
  try {
    // 同源托管下 data: / blob: 均可直接读取；远端 URL 受其 CORS 策略约束。
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!blob.size) throw new Error("空媒体数据");
    return new File([blob], item.name, {
      type: item.mimeType || blob.type || "application/octet-stream",
    });
  } catch (error) {
    console.warn("[openreel-video] 读取上游媒体失败：", item.name, error);
    return null;
  }
}

/**
 * 把尚未确认的上游媒体推进编辑器媒体库。
 * @param force true 时忽略重试间隔（用于编辑器刚就绪 / 刚重载）
 */
export async function pushUpstreamMedia(
  frame: HTMLIFrameElement | null,
  state: MediaSyncState,
  items: UpstreamMediaItem[],
  force: boolean,
): Promise<void> {
  const target = frame?.contentWindow;
  if (!target || state.busy) return;

  const pending = items.filter(
    (item) =>
      !state.acknowledged.has(item.id) &&
      (state.attempts.get(item.id) ?? 0) < MAX_ATTEMPTS,
  );
  if (!pending.length) return;
  if (!force && Date.now() - state.lastPushAt < RETRY_INTERVAL_MS) return;

  state.busy = true;
  state.lastPushAt = Date.now();
  try {
    const metas: { id: string; name: string }[] = [];
    const files: File[] = [];
    for (const item of pending) {
      state.attempts.set(item.id, (state.attempts.get(item.id) ?? 0) + 1);
      const file = await fetchAsFile(item);
      if (!file) continue;
      metas.push({ id: item.id, name: item.name });
      files.push(file);
    }
    if (!metas.length) return;
    target.postMessage(
      {
        channel: CANVAS_HOST_BRIDGE_CHANNEL,
        type: "import-files",
        requestId: `${Date.now()}`,
        items: metas,
        files,
      },
      window.location.origin,
    );
  } catch (error) {
    console.warn("[openreel-video] 推送上游媒体失败：", error);
  } finally {
    state.busy = false;
  }
}

/** 处理编辑器回传的导入结果 */
export function applyImportResults(
  state: MediaSyncState,
  results: { id: string; ok: boolean; error?: string }[],
): void {
  for (const result of results) {
    if (!result || typeof result.id !== "string") continue;
    if (result.ok) {
      state.acknowledged.add(result.id);
      state.attempts.delete(result.id);
    } else if (result.error) {
      console.warn("[openreel-video] 媒体导入失败：", result.error);
    }
  }
}
