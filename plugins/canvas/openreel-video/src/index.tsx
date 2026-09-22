import {
  definePlugin,
  useEffect,
  useRef,
  useState,
} from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";
import { installOpenReelZh } from "./i18n-zh";
import {
  CANVAS_HOST_BRIDGE_CHANNEL,
  applyImportResults,
  collectUpstreamMedia,
  createMediaSyncState,
  pushUpstreamMedia,
  resetMediaSyncState,
} from "./media-sync";

// ─────────────────────────────────────────────────────────────────────────────
// OpenReel 视频编辑器节点插件（薄桥接层）
//
// OpenReel（https://github.com/Augani/openreel-video）是一个浏览器端专业视频编辑器
// （时间线剪辑、转场、滤镜、字幕、ffmpeg 导出等），本身是独立 SPA，并未设计宿主桥接协议。
// 因此这里采用与 3D 导演台一致的 iframe 嵌入策略：
//   · OpenReel 完整源码 vendor 在 app/ 下，剪辑/渲染/导出等功能逻辑保持不变
//     （只有三处「集成必需」补丁：vite base 相对路径、Service Worker 子路径作用域、
//      新增 canvas-host-bridge 用于接收上游媒体 —— 均为新增或托管所需，不改任何既有逻辑）；
//   · 本插件把编辑器以同源 iframe 嵌入节点内容区，并负责三件事：
//       1) 运行时中文本地化（i18n-zh，只替换渲染出的文本）；
//       2) 「使用中」(悬停/选中/编辑器获得焦点) 时整节点高亮，并收起遮挡的宿主悬浮工具条；
//       3) 把连线上游「图片 / 视频」节点产出的内容自动灌进编辑器媒体库（media-sync）。
// 「在节点插件里随意安装/关闭/卸载」由宿主插件管理器负责。
// ─────────────────────────────────────────────────────────────────────────────

// 注意：必须显式带 index.html（原因同 3D 导演台：Vite dev 对「目录 + 斜杠」请求不解析 index.html，
// 会被宿主 SPA 兜底接管；显式文件名在 dev 与生产静态托管下行为一致）。
const APP_BASE = "/openreel-video/";
const APP_ENTRY = `${APP_BASE}index.html`;

// 节点「使用中」（指针位于该节点内）时挂在 <html> 上的标记类（模块级集合，多实例互不干扰）。
const IN_USE_CLASS = "ic-openreel-inuse";

// 整节点高亮色：与宿主画布选中态一致的蓝（canvas-node 内的 selectionBlue）。
const HIGHLIGHT = "#2f80ff";

// 插件样式（宿主会在插件启用时注入、停用时移除）。
//
// 唯一用途：在使用该节点（指针位于节点内）时隐藏宿主对各节点统一渲染的悬浮工具条
// （信息 / 删除 / 重载）。只做视觉覆盖，不改任何宿主模块代码。
// 指针离开节点后规则即失效，工具条按宿主原有逻辑恢复显示（仍可从这里删除节点，
// 也可用节点右键菜单删除）。
//
// 选择器锁定宿主「节点悬浮工具条」：class 里同时含 `z-[70]` 与 `h-12` 的只有
// canvas-node-hover-toolbar 与 canvas-selection-toolbar，不会命中 Agent 面板（z-[70] h-full）
// 或节点下方面板（z-[70] w-[600px]）。
// 这里刻意用 `[class~="..."]` 属性选择器而不是 `.z-\[70\]`：属性值写在引号里，无需 CSS 转义，
// 避免打包器对反斜杠的处理差异导致选择器失效。若宿主将来调整这两个工具类，
// 规则会静默失效（工具条恢复显示），不会破坏任何功能。
const PLUGIN_CSS = `
html.${IN_USE_CLASS} [class~="z-[70]"][class~="h-12"] {
  display: none !important;
}
`;

// 读取宿主明暗主题：宿主在 <html> 上挂 "dark" class。
function getHostTheme(): "dark" | "light" {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  return "light";
}

// 模块级注册表：toolbar 的「重载」按钮按 node id 找到对应 iframe 重新加载。
const frameRegistry = new Map<string, HTMLIFrameElement>();

// 「使用中」节点集合：任一节点在使用，就为 <html> 挂上标记类。
const inUseNodes = new Set<string>();
function syncInUseClass() {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(IN_USE_CLASS, inUseNodes.size > 0);
}

function buildFrameSrc(nodeId: string): string {
  return `${APP_ENTRY}?instanceId=${encodeURIComponent(nodeId)}&theme=${getHostTheme()}`;
}

type BridgeResult = { id: string; ok: boolean; error?: string };

function readBridgeResults(raw: unknown): BridgeResult[] {
  if (!Array.isArray(raw)) return [];
  const out: BridgeResult[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as { id?: unknown; ok?: unknown; error?: unknown };
    if (typeof record.id !== "string" || typeof record.ok !== "boolean") continue;
    out.push({
      id: record.id,
      ok: record.ok,
      error: typeof record.error === "string" ? record.error : undefined,
    });
  }
  return out;
}

function OpenReelContent({ ctx }: CanvasNodeContentProps) {
  const nodeId = ctx.node.id;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadError, setLoadError] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  // ctx 每次渲染都是新对象，用 ref 让定时器/消息回调始终读到最新的取数函数。
  const ctxRef = useRef(ctx);
  useEffect(() => {
    ctxRef.current = ctx;
  });

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    frameRegistry.set(nodeId, frame);
    return () => {
      if (frameRegistry.get(nodeId) === frame) frameRegistry.delete(nodeId);
    };
  }, [nodeId]);

  // 上游媒体同步状态（按节点实例隔离）
  const syncStateRef = useRef(createMediaSyncState());

  // 「使用中」：悬停 / 选中 / 编辑器拿到焦点 → 整节点高亮
  const inUse = hovered || focused || ctx.isSelected;

  // 收起宿主悬浮工具条的条件更严格：只有「指针在本节点内」时才收起。
  // 这样既精确对应「正在使用本节点」，又不会因为本节点被选中/编辑器持有焦点
  // 而顺带把其它节点的悬浮工具条也隐藏掉（那是会引出新问题的副作用）。
  useEffect(() => {
    if (hovered) inUseNodes.add(nodeId);
    else inUseNodes.delete(nodeId);
    syncInUseClass();
  }, [hovered, nodeId]);

  useEffect(
    () => () => {
      inUseNodes.delete(nodeId);
      syncInUseClass();
    },
    [nodeId],
  );

  // 中文本地化：编辑器是同源 iframe，加载完成后在其文档内安装运行时翻译层。
  // 零改动 OpenReel 源码 —— 只替换「渲染出的文本」，不触碰任何逻辑值。
  const zhCleanupRef = useRef<(() => void) | null>(null);

  const handleFrameLoad = () => {
    const frame = iframeRef.current;
    if (!frame) return;
    setFocused(false);
    // 编辑器（重新）加载后允许重推上游媒体：编辑器侧按「媒体库 item 是否还在」持久化去重，
    // 因此重推不会产生重复媒体，也不会漏掉被删掉的那些。
    resetMediaSyncState(syncStateRef.current);
    try {
      const doc = frame.contentDocument;
      const win = frame.contentWindow as Window | null;
      if (!doc || !win) return;
      zhCleanupRef.current?.();
      zhCleanupRef.current = installOpenReelZh(doc, win);
    } catch {
      /* 跨源时不可访问；本插件为同源托管，正常不会走到这里 */
    }
    void pushUpstreamMedia(
      frame,
      syncStateRef.current,
      collectUpstreamMedia(ctxRef.current.getUpstream()),
      true,
    );
  };
  useEffect(
    () => () => {
      zhCleanupRef.current?.();
      zhCleanupRef.current = null;
    },
    [],
  );

  // 编辑器的回传：导入结果 / 焦点 / 就绪
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as
        | { channel?: unknown; type?: unknown; results?: unknown; focused?: unknown }
        | null
        | undefined;
      if (!data || typeof data !== "object") return;
      if (data.channel !== CANVAS_HOST_BRIDGE_CHANNEL) return;

      if (data.type === "import-result") {
        const results = readBridgeResults(data.results);
        applyImportResults(syncStateRef.current, results);
        const failure = results.find((item) => !item.ok && item.error);
        if (failure?.error) {
          setNotice(`媒体导入失败：${failure.error}`.slice(0, 120));
        }
      } else if (data.type === "focus") {
        setFocused(data.focused === true);
      } else if (data.type === "ready") {
        void pushUpstreamMedia(
          frame,
          syncStateRef.current,
          collectUpstreamMedia(ctxRef.current.getUpstream()),
          true,
        );
      }
    };
    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  // 轮询上游连线：连线/重生成发生变化时把新产出推进媒体库。
  // 用轮询而非依赖宿主重渲染 —— 新增连线不一定改变本节点数据，宿主不保证重渲染本内容组件。
  useEffect(() => {
    const timer = window.setInterval(() => {
      const frame = iframeRef.current;
      if (!frame) return;
      void pushUpstreamMedia(
        frame,
        syncStateRef.current,
        collectUpstreamMedia(ctxRef.current.getUpstream()),
        false,
      );
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  // 失败提示是临时性的，几秒后自动消失。
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div
      data-canvas-no-zoom
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        borderRadius: 16,
        background: "#0b0b0f",
      }}
    >
      {loadError ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            color: "#e2e8f0",
            fontSize: 13,
            textAlign: "center",
            padding: 24,
            background: "#0b0b0f",
          }}
        >
          OpenReel 加载失败：请先构建并将产物放到 {APP_BASE}
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={buildFrameSrc(nodeId)}
          title="OpenReel 视频编辑器"
          onLoad={handleFrameLoad}
          onError={() => setLoadError(true)}
          allow="autoplay; fullscreen; clipboard-read; clipboard-write; camera; microphone"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            background: "#0b0b0f",
          }}
        />
      )}

      {/* 使用中：整节点高亮（描边 + 外发光），与画布选中态同一蓝色语言 */}
      {inUse && !loadError ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            inset: 0,
            borderRadius: 16,
            pointerEvents: "none",
            boxShadow: `0 0 0 2px ${HIGHLIGHT}, 0 0 26px 2px ${HIGHLIGHT}59`,
            zIndex: 3,
          }}
        />
      ) : null}

      {/* 仅悬停时出现的重载按钮（纯图标，不占界面、不带文字） */}
      {!loadError ? (
        <button
          type="button"
          title="重新加载 OpenReel 编辑器"
          aria-label="重新加载 OpenReel 编辑器"
          onMouseDown={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => {
            const frame = iframeRef.current;
            if (frame) frame.src = frame.src; // 重新加载 iframe
          }}
          style={{
            position: "absolute",
            top: 8,
            right: 8,
            zIndex: 4,
            width: 26,
            height: 26,
            display: "grid",
            placeItems: "center",
            borderRadius: 999,
            border: "1px solid rgba(255,255,255,0.22)",
            background: "rgba(15,15,20,0.72)",
            color: "#e2e8f0",
            fontSize: 13,
            lineHeight: 1,
            cursor: "pointer",
            opacity: hovered ? 1 : 0,
            pointerEvents: hovered ? "auto" : "none",
            transition: "opacity 140ms ease",
          }}
        >
          ⟳
        </button>
      ) : null}

      {/* 导入失败时才出现的临时提示（6 秒后自动消失） */}
      {notice ? (
        <div
          style={{
            position: "absolute",
            left: 10,
            bottom: 10,
            zIndex: 4,
            maxWidth: "80%",
            padding: "6px 10px",
            borderRadius: 8,
            background: "rgba(127,29,29,0.92)",
            color: "#fee2e2",
            fontSize: 12,
            pointerEvents: "none",
          }}
        >
          {notice}
        </div>
      ) : null}
    </div>
  );
}

export default definePlugin({
  id: "openreel-video",
  name: "OpenReel 视频编辑器",
  version: "1.1.0",
  description: "在画布内嵌 OpenReel 浏览器端专业视频编辑器：时间线剪辑、转场、滤镜、字幕、ffmpeg 导出",
  css: PLUGIN_CSS,
  setup: () => () => {
    inUseNodes.clear();
    syncInUseClass();
  },
  nodes: [
    {
      type: "openreel-video:editor",
      title: "OpenReel 视频编辑",
      icon: "🎬",
      description: "浏览器端专业视频编辑器（剪辑 / 转场 / 滤镜 / 字幕 / 导出）",
      defaultSize: { width: 960, height: 600 },
      defaultMetadata: {},
      minimapColor: "#ef4444",
      // 宿主会在具备交互内容的节点上加「交互 ⇄ 移动」开关；本节点 metadata.content 为空，
      // 宿主按「空节点始终可交互」处理，因此编辑器可直接操作，无需额外提示。
      interactionToggle: true,
      Content: OpenReelContent,
      toolbar: (ctx) => [
        {
          id: "reload",
          title: "重新加载 OpenReel 编辑器",
          // 留空以保持纯图标（toolbar 上的文字按需求去掉）
          label: "",
          icon: "🔄",
          onClick: () => {
            const frame = frameRegistry.get(ctx.node.id);
            if (frame) frame.src = frame.src; // 重新加载 iframe
          },
        },
      ],
    },
  ],
});
