import {
  definePlugin,
  useEffect,
  useRef,
  useState,
} from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps } from "@infinite-canvas/plugin-sdk";

// ─────────────────────────────────────────────────────────────────────────────
// 3D 导演台节点插件（薄桥接层）
//
// 设计要点：jlmlh-3d-director 原本是 React 18 + @react-three/fiber 8 的独立应用，
// 而宿主画布是 React 19，且插件契约要求 React 为宿主单例（不得自带 React）。
// 由于 R3F 8 仅支持 React 18，内联打包会破坏其渲染逻辑，因此这里采用 iframe 嵌入：
//   · 导演台完整源码 vendor 在 app/ 下，功能逻辑一律不改；
//   · 本插件只是把导演台以同源 iframe 嵌入节点内容区，并补齐宿主⇄导演台的
//     postMessage 桥接（协议与 app/src/editor/io/hostBridge.ts 对齐）。
// 这样「在节点插件里随意安装/关闭」由宿主插件管理器负责，导演台功能逻辑保持不变。
// ─────────────────────────────────────────────────────────────────────────────

// 注意：必须显式带 index.html。
// Vite 开发服务器对 public/ 子目录的「目录 + 斜杠」请求不会解析到 index.html，
// 而是被宿主 SPA 兜底接管（iframe 里会载入宿主画布本身）。
// 显式文件名在 dev 与生产静态托管下行为一致。
const APP_BASE = "/jlmlh-3d-director/";
const APP_ENTRY = `${APP_BASE}index.html`;

// 宿主侧监听的入站消息（与 app/src/editor/io/hostBridge.ts 的 handleHostMessage 对齐）
type InboundMessage =
  | { type: "storyai:director-desk-ready" }
  | { type: "storyai:director-desk-close" }
  | {
      type: "storyai:director-desk-captures-sent";
      payload: { captures: Array<{ dataUrl: string; fileName?: string }> };
    }
  | {
      type: "storyai:director-desk-panorama-removed";
      payload: { edgeId?: string; sourceNodeId?: string };
    };

// 宿主侧发出的出站消息（与 hostBridge 的 openHostSession / importHostPanorama 对齐）
type OutboundMessage =
  | { type: "storyai:director-desk-session"; payload: { instanceId: string; theme: "dark" | "light" } }
  | {
      type: "storyai:director-desk-panorama";
      payload: { edgeId: string; sourceNodeId: string; imageUrl: string; fileName: string };
    };

// 读取宿主明暗主题：宿主在 <html> 上挂 "dark" class。
function getHostTheme(): "dark" | "light" {
  if (typeof document !== "undefined" && document.documentElement.classList.contains("dark")) {
    return "dark";
  }
  return "light";
}

// 模块级注册表：toolbar 的「重载」按钮按 node id 找到对应 iframe 重新加载。
const frameRegistry = new Map<string, HTMLIFrameElement>();

function DirectorDeskContent({ ctx }: CanvasNodeContentProps) {
  const nodeId = ctx.node.id;
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loadError, setLoadError] = useState(false);
  const interactive =
    (ctx.node.metadata as { interactive?: boolean } | undefined)?.interactive === true;

  useEffect(() => {
    const frame = iframeRef.current;
    if (!frame) return;
    frameRegistry.set(nodeId, frame);

    const origin = window.location.origin;
    const target = frame.contentWindow;

    const post = (msg: OutboundMessage) => target?.postMessage(msg, origin);

    const sendSession = () =>
      post({ type: "storyai:director-desk-session", payload: { instanceId: nodeId, theme: getHostTheme() } });

    const sendUpstreamPanorama = () => {
      const upstream = ctx.getUpstream();
      for (const up of upstream) {
        const content = up.metadata?.content;
        if (typeof content === "string" && content) {
          const connection = ctx
            .getConnections()
            .find((c) => c.fromNodeId === up.id && c.toNodeId === nodeId);
          post({
            type: "storyai:director-desk-panorama",
            payload: {
              edgeId: connection?.id ?? `${up.id}->${nodeId}`,
              sourceNodeId: up.id,
              imageUrl: content,
              fileName: up.title || "画布全景图.png",
            },
          });
          break; // 仅取第一个上游图片节点
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      // 同源校验（导演台 hostBridge 同样按 origin 校验入站消息）
      if (event.origin !== origin) return;
      if (event.source !== target) return;
      const data = event.data as InboundMessage | undefined;
      if (!data || typeof data.type !== "string") return;

      if (data.type === "storyai:director-desk-ready") {
        // 应用挂载完成并已注册 bridge 监听，此刻回送会话（含实例隔离 id 与主题）
        sendSession();
        sendUpstreamPanorama();
        return;
      }

      if (data.type === "storyai:director-desk-captures-sent") {
        const captures = data.payload?.captures ?? [];
        if (captures.length === 0) return;
        const startX = ctx.node.position.x + ctx.node.width + 48;
        const startY = ctx.node.position.y;
        const ops = captures.map((cap, i) => ({
          type: "add_node" as const,
          nodeType: "image" as const,
          title: cap.fileName || `导演台截图 ${i + 1}`,
          position: { x: startX, y: startY + i * 200 },
          width: 360,
          height: 360,
          metadata: { content: cap.dataUrl, freeResize: true },
        }));
        // 把最后一张写回本节点，供下游节点引用（resource 返回它）
        ctx.updateMetadata({ content: captures[captures.length - 1].dataUrl });
        ctx.applyOps(ops);
        return;
      }

      // storyai:director-desk-close / storyai:director-desk-panorama-removed 暂无需宿主处理
    };

    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (frameRegistry.get(nodeId) === frame) frameRegistry.delete(nodeId);
    };
    // 位置/尺寸变化时重新绑定，使截图落点跟随节点；ctx 的 host 回调本身是稳定的
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, ctx.node.position.x, ctx.node.position.y, ctx.node.width]);

  const src = `${APP_ENTRY}?instanceId=${encodeURIComponent(nodeId)}&theme=${getHostTheme()}`;

  return (
    <div
      data-canvas-no-zoom
      style={{
        position: "relative",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        borderRadius: 16,
        background: "#090909",
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
            background: "#0b0b0b",
          }}
        >
          3D 导演台加载失败：请先构建并将产物放到 {APP_BASE}
        </div>
      ) : (
        <iframe
          ref={iframeRef}
          src={src}
          title="3D 导演台"
          onError={() => setLoadError(true)}
          allow="autoplay; fullscreen"
          style={{
            width: "100%",
            height: "100%",
            border: "none",
            display: "block",
            background: "#090909",
          }}
        />
      )}

      {!interactive && !loadError ? (
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "grid",
            placeItems: "center",
            pointerEvents: "none",
            color: "#cbd5e1",
            fontSize: 13,
            textAlign: "center",
            background: "rgba(9,9,9,0.55)",
          }}
        >
          点击节点上的「交互」按钮以操作 3D 导演台
        </div>
      ) : null}
    </div>
  );
}

export default definePlugin({
  id: "jlmlh-3d-director",
  name: "3D 导演台节点",
  version: "1.0.0",
  description: "在画布内嵌 jlmlh-3d-director 三维导演台：模型导入、机位管理、时间线动画、截图导出到画布",
  nodes: [
    {
      type: "jlmlh-3d-director:scene",
      title: "3D 导演台",
      icon: "🎬",
      description: "三维导演工作台（对象 / 机位 / 时间线 / 截图）",
      defaultSize: { width: 760, height: 520 },
      defaultMetadata: {},
      minimapColor: "#7c3aed",
      // 宿主自动加「交互 ⇄ 移动」开关：默认移动（拖动节点），切到交互后可用导演台
      interactionToggle: true,
      // 把最近一次截图作为本节点资源输出，供下游节点引用
      resource: (node) => {
        const content = node.metadata?.content;
        return typeof content === "string" && content ? { kind: "image", url: content } : null;
      },
      Content: DirectorDeskContent,
      toolbar: (ctx) => [
        {
          id: "reload",
          title: "重新加载 3D 导演台",
          label: "重载",
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
