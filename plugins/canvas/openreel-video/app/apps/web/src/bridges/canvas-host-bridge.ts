/**
 * Canvas Host Bridge — infinite-canvas 节点插件集成（新增模块，纯增量）
 *
 * 背景：OpenReel 编辑器被 infinite-canvas 以「同源 iframe」方式嵌进画布节点。
 * 画布上与被连接（连线）的图片节点 / 视频节点生成的内容，需要能直接进到本编辑器的
 * 媒体库，再由编辑器正常剪辑。这一件事由本桥完成：
 *
 *   宿主插件 --postMessage(import-files, File[])--> 本桥 --> useProjectStore.importMedia(file)
 *
 * 设计约束（务必保持）：
 * 1. 纯增量：本文件是新增模块，未修改任何既有模块的行为。主入口只是多调用一次
 *    `installCanvasHostBridge()`。
 * 2. 复用原始导入链路：导入走的是编辑器「导入媒体」按钮同一个 store action
 *    (`useProjectStore.importMedia`)，因此缩略图、filmstrip、波形、元数据提取、
 *    工程持久化（saveMediaBlob）全部与手工导入逐字节一致，不存在第二套导入逻辑。
 * 3. 去重：记住「已导入 id -> 媒体库 item id」映射。宿主页面刷新后插件会重推，
 *    但只要媒体库里那个 item 还在就跳过；用户手工删掉了就会重新导入，不会出现漏媒体。
 * 4. 服务对象只认父窗口：只接受 `event.source === window.parent` 的消息，独立打开
 *    本应用时桥处于待机状态，不影响任何现有功能。
 */
import { useProjectStore } from "../stores/project-store";

/** 与宿主插件（plugins/canvas/openreel-video/src/media-sync.ts）约定的消息频道 */
export const CANVAS_HOST_BRIDGE_CHANNEL = "openreel-canvas-host";

const STORAGE_PREFIX = "openreel-canvas-host:imported:";
const MAX_REMEMBERED = 300;

type BridgeItemMeta = { id: string; name?: string };

type BridgeImportResult = {
  id: string;
  ok: boolean;
  /** 已导入过、本次跳过 */
  skipped?: boolean;
  mediaId?: string;
  error?: string;
};

/** importId -> 媒体库 item id（用于判断是否仍需导入） */
type RememberedMap = Record<string, string>;

let installed = false;
let remembered: RememberedMap = {};

function readProjectId(): string | null {
  try {
    const state = useProjectStore.getState() as unknown as {
      project?: { id?: unknown };
    };
    const id = state.project?.id;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function storageKey(): string | null {
  const projectId = readProjectId();
  return projectId ? `${STORAGE_PREFIX}${projectId}` : null;
}

function loadRemembered(): void {
  remembered = {};
  const key = storageKey();
  if (!key) return;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return;
    for (const [importId, mediaId] of Object.entries(parsed as RememberedMap)) {
      if (typeof importId === "string" && typeof mediaId === "string") {
        remembered[importId] = mediaId;
      }
    }
  } catch {
    remembered = {};
  }
}

function persistRemembered(): void {
  const key = storageKey();
  if (!key) return;
  try {
    const entries = Object.entries(remembered);
    const trimmed: RememberedMap = {};
    for (const [importId, mediaId] of entries.slice(-MAX_REMEMBERED)) {
      trimmed[importId] = mediaId;
    }
    remembered = trimmed;
    window.localStorage.setItem(key, JSON.stringify(trimmed));
  } catch {
    /* 存储不可用时仅退化为内存去重，不影响导入本身 */
  }
}

/** 媒体库里是否还存在该 item：被用户删掉时应允许重新导入 */
function mediaItemExists(mediaId: string): boolean {
  try {
    const state = useProjectStore.getState() as unknown as {
      project?: { mediaLibrary?: { items?: { id?: unknown }[] } };
    };
    const items = state.project?.mediaLibrary?.items;
    if (!Array.isArray(items)) return false;
    return items.some((item) => item?.id === mediaId);
  } catch {
    return false;
  }
}

function shouldSkip(importId: string): boolean {
  const mediaId = remembered[importId];
  if (!mediaId) return false;
  return mediaItemExists(mediaId);
}

function postToHost(payload: Record<string, unknown>): void {
  try {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage(
      { channel: CANVAS_HOST_BRIDGE_CHANNEL, ...payload },
      "*",
    );
  } catch {
    /* 宿主不可达时忽略 */
  }
}

function toFile(candidate: unknown, fallbackName: string): File | null {
  if (candidate instanceof File) return candidate;
  if (candidate instanceof Blob) {
    return new File([candidate], fallbackName, {
      type: candidate.type || "application/octet-stream",
    });
  }
  return null;
}

async function handleImportRequest(data: {
  requestId?: unknown;
  items?: unknown;
  files?: unknown;
}): Promise<void> {
  const requestId = typeof data.requestId === "string" ? data.requestId : "";
  const metas: unknown[] = Array.isArray(data.items) ? data.items : [];
  const files: unknown[] = Array.isArray(data.files) ? data.files : [];
  const results: BridgeImportResult[] = [];

  for (let index = 0; index < metas.length; index += 1) {
    const meta = metas[index] as BridgeItemMeta | null | undefined;
    const importId = typeof meta?.id === "string" ? meta.id : "";
    const name = typeof meta?.name === "string" && meta.name ? meta.name : `media-${index}`;
    const file = toFile(files[index], name);

    if (!importId || !file) {
      results.push({ id: importId, ok: false, error: "invalid media payload" });
      continue;
    }

    if (shouldSkip(importId)) {
      results.push({ id: importId, ok: true, skipped: true, mediaId: remembered[importId] });
      continue;
    }

    try {
      const action = await useProjectStore.getState().importMedia(file);
      if (action.success) {
        const mediaId = typeof action.actionId === "string" ? action.actionId : "";
        if (mediaId) {
          remembered[importId] = mediaId;
          persistRemembered();
        }
        results.push({ id: importId, ok: true, mediaId });
      } else {
        results.push({
          id: importId,
          ok: false,
          error: action.error?.message || "media import failed",
        });
      }
    } catch (error) {
      results.push({
        id: importId,
        ok: false,
        error: error instanceof Error ? error.message : "media import threw",
      });
    }
  }

  postToHost({ type: "import-result", requestId, results });
}

async function handleMessage(event: MessageEvent): Promise<void> {
  // 只认父窗口（画布宿主）；独立打开时不接受任何来源的消息。
  if (!window.parent || event.source !== window.parent) return;

  const data = event.data as
    | { channel?: unknown; type?: unknown; requestId?: unknown; items?: unknown; files?: unknown }
    | null
    | undefined;
  if (!data || typeof data !== "object") return;
  if (data.channel !== CANVAS_HOST_BRIDGE_CHANNEL) return;

  if (data.type === "import-files") {
    await handleImportRequest(data);
  }
}

/**
 * 安装宿主桥。幂等；独立打开（非 iframe）时也安全安装，只是没有被调用的机会。
 */
export function installCanvasHostBridge(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  loadRemembered();

  window.addEventListener("message", (event) => {
    void handleMessage(event);
  });

  // 焦点状态回传：宿主据此判断该节点「正在被使用」（用于整节点高亮 / 收起遮挡层）
  window.addEventListener("focus", () => postToHost({ type: "focus", focused: true }));
  window.addEventListener("blur", () => postToHost({ type: "focus", focused: false }));

  postToHost({ type: "ready" });
}
