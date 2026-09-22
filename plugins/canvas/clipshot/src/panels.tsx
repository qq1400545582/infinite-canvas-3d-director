import { useEffect, useRef, useState } from "@infinite-canvas/plugin-sdk";
import type { CanvasNodeContentProps, CanvasNodeData, CanvasNodeMetadata } from "@infinite-canvas/plugin-sdk";

import { PANELS_NODE_TYPE, PANELS_READY_EVENT } from "./ids";
import { DEFAULT_GRID, buildPanelPrefix, gridLabel, makeGrid, normalizePanels, type GridSpec, type PanelPrompt } from "./spec";
import { accentStyles, bodyStyle, errorMessage, fitNodeSize, mediaId, preparePanelImage, statusTextStyle, titleBarStyle } from "./shared";

// 分镜出图（clipshot 下游节点）
// -----------------------------------------------------------------------------
// 消费上游「分镜工作台」产出的分镜序列（node.metadata.clipshotPanels），按阅读顺序逐格调用
// 宿主注入的 ctx.ai.generateImage 出图，每格落成一个画布图片节点，并按网格排布在工作台右侧。
//
// 触发方式（都不需要额外点击）：
//   1. 工作台生成完分镜后广播 clipshot:panels-ready，本节点即时开工；
//   2. 本节点自身的轮询兜底：只要上游分镜版本号与「已出图版本」不同，就自动开工。
//      版本号随工程一起保存，因此刷新页面不会重复出图。
//
// 出图用的是逐格模式（单帧，不是网格纸），提示词前缀取自 visual-production 原文的视觉语言与
// 全局禁项（见 spec.ts 的 buildPanelPrefix），与工作台保持一致，不引入新的表现风格。
//
// 图片会直接写入宿主媒体库（IndexedDB infinite-canvas/image_files）拿到真 storageKey，
// 因此刷新后仍可播放/引用，也不会让工程 JSON 里塞进 base64。

const LAYOUT_CELL = 400; // 每格图片节点的排布间距（含间隙）
const IMAGE_BOX = 340; // 图片节点最大边
const POLL_INTERVAL_MS = 1600;

type PanelRunState = {
    running: boolean;
    /** 正在处理第几格（1 起） */
    activeIndex: number;
    done: number;
    total: number;
    message: string;
    error: string;
    /** 分镜序号 -> 已生成的图片节点 id（用于原地更新，避免重复堆节点） */
    images: Record<string, string>;
    /** 已经出过图的（也是当前已处理的）分镜版本号 */
    doneVersion: number;
    auto: boolean;
};

type PersistedPanels = { auto?: boolean; doneVersion?: number; images?: Record<string, string> };

/** 运行态放在模块级：节点被视口裁剪卸载时，出图过程与进度不会丢。 */
const runs = new Map<string, PanelRunState>();

function panelRuntime(nodeId: string): PanelRunState {
    let runtime = runs.get(nodeId);
    if (!runtime) {
        runtime = { running: false, activeIndex: 0, done: 0, total: 0, message: "", error: "", images: {}, doneVersion: 0, auto: true };
        runs.set(nodeId, runtime);
    }
    return runtime;
}

type UpstreamPanels = { node: CanvasNodeData; version: number; grid: GridSpec; ratio: string; panels: PanelPrompt[] };

/** 找出上游最新的分镜序列（多路上游时取版本号最大的一路）。 */
function resolveUpstream(ctx: CanvasNodeContentProps["ctx"]): UpstreamPanels | null {
    let best: UpstreamPanels | null = null;
    for (const node of ctx.getUpstream()) {
        const metadata = node.metadata as Record<string, unknown> | undefined;
        const panels = normalizePanels(metadata?.clipshotPanels, 0);
        if (!panels.length) continue;
        const rawGrid = metadata?.clipshotGrid as Partial<GridSpec> | undefined;
        const grid = makeGrid(Number(rawGrid?.cols) || panels.length, Number(rawGrid?.rows) || 1);
        const version = Number(metadata?.clipshotVersion) || 0;
        const candidate: UpstreamPanels = {
            node,
            version,
            grid: { ...grid, count: panels.length },
            ratio: typeof metadata?.clipshotRatio === "string" ? (metadata.clipshotRatio as string) : "16:9",
            panels,
        };
        if (!best || candidate.version >= best.version) best = candidate;
    }
    return best;
}

export const panelsRegistries = {
    run: new Map<string, () => void>(),
    clear: new Map<string, () => void>(),
};

function pad2(value: number) {
    return String(value).padStart(2, "0");
}

export function PanelsContent({ ctx }: CanvasNodeContentProps) {
    const nodeId = ctx.node.id;
    const theme = ctx.theme;
    const [, setTick] = useState(0);
    const refresh = () => setTick((value) => value + 1);

    const ctxRef = useRef(ctx);
    ctxRef.current = ctx;
    const abortRef = useRef<AbortController | null>(null);
    const loadedRef = useRef(false);
    const runtime = panelRuntime(nodeId);

    const persistSettings = () => {
        const current = panelRuntime(nodeId);
        const payload: PersistedPanels = { auto: current.auto, doneVersion: current.doneVersion, images: current.images };
        void ctxRef.current.storage.set(`panels:${nodeId}`, payload).catch(() => undefined);
    };

    const startRun = async (upstream: UpstreamPanels, force: boolean) => {
        const current = panelRuntime(nodeId);
        if (current.running) return;
        const api = ctxRef.current;
        if (!upstream.panels.length) return;

        current.running = true;
        current.total = upstream.panels.length;
        current.done = 0;
        current.activeIndex = upstream.panels[0].index;
        current.error = "";
        current.message = `开始按分镜序列出图：共 ${upstream.panels.length} 格`;
        // 先记版本号：即使中途失败也不会被自动逻辑无限重试（手动「重新出图」可强制重跑）
        if (!force || current.doneVersion !== upstream.version) current.doneVersion = upstream.version;
        persistSettings();
        refresh();

        const controller = new AbortController();
        abortRef.current = controller;
        const prefix = buildPanelPrefix(upstream.ratio);
        const cols = Math.max(1, upstream.grid.cols);
        const origin = { x: api.node.position.x, y: api.node.position.y };
        const originWidth = api.node.width;

        for (let position = 0; position < upstream.panels.length; position += 1) {
            if (controller.signal.aborted) break;
            const panel = upstream.panels[position];
            current.activeIndex = panel.index;
            current.message = `正在出第 ${position + 1} / ${upstream.panels.length} 格（Panel ${pad2(panel.index)}）…`;
            refresh();
            try {
                const { images } = await api.ai.generateImage(`${prefix}\n\n${panel.prompt}`, { count: 1, signal: controller.signal });
                const dataUrl = images && images[0];
                if (!dataUrl) throw new Error("图像模型未返回图片");

                const prepared = await preparePanelImage(dataUrl);
                const size = fitNodeSize(prepared.width || IMAGE_BOX, prepared.height || IMAGE_BOX, IMAGE_BOX, IMAGE_BOX);
                const metadata: CanvasNodeMetadata = {
                    content: prepared.url,
                    ...(prepared.storageKey ? { storageKey: prepared.storageKey } : {}),
                    mimeType: prepared.mimeType,
                    naturalWidth: prepared.width,
                    naturalHeight: prepared.height,
                    bytes: prepared.bytes,
                    prompt: panel.prompt,
                    clipshotPanelIndex: panel.index,
                    clipshotPanelTimecode: panel.timecode,
                };

                const existingId = current.images[String(panel.index)];
                const existing = existingId ? api.getNode(existingId) : null;
                if (existing) {
                    // 重新出图：原地替换，不堆新节点
                    api.applyOps([{ type: "update_node", id: existing.id, metadata }]);
                } else {
                    const column = position % cols;
                    const row = Math.floor(position / cols);
                    const id = `${PANELS_NODE_TYPE}-img-${mediaId()}`;
                    api.applyOps([
                        {
                            type: "add_node",
                            id,
                            nodeType: "image",
                            title: `Panel ${pad2(panel.index)}${panel.shot ? ` · ${panel.shot}` : ""}`.slice(0, 60),
                            position: { x: origin.x + originWidth + 96 + column * LAYOUT_CELL, y: origin.y + row * LAYOUT_CELL },
                            width: size.width,
                            height: size.height,
                            metadata,
                        },
                        { type: "connect_nodes", fromNodeId: nodeId, toNodeId: id },
                    ]);
                    current.images[String(panel.index)] = id;
                    persistSettings();
                }

                current.done += 1;
                current.message = `已完成 ${current.done} / ${upstream.panels.length} 格`;
                refresh();
            } catch (error) {
                if (controller.signal.aborted) {
                    current.message = `已停止（完成 ${current.done} / ${upstream.panels.length} 格）`;
                    break;
                }
                current.error = `Panel ${pad2(panel.index)} 出图失败：${errorMessage(error)}`;
                current.message = `已中断（完成 ${current.done} / ${upstream.panels.length} 格）`;
                break;
            }
        }

        if (controller.signal.aborted && !current.error) current.message = `已停止（完成 ${current.done} / ${upstream.panels.length} 格）`;
        else if (!current.error) current.message = `已按分镜序列出图完成：${current.done} / ${upstream.panels.length} 格`;
        current.running = false;
        abortRef.current = null;
        if (current.done >= upstream.panels.length) current.activeIndex = 0;
        refresh();
    };

    const stopRun = () => {
        abortRef.current?.abort();
    };

    const clearImages = () => {
        const current = panelRuntime(nodeId);
        const ids = Object.values(current.images).filter((id) => Boolean(ctxRef.current.getNode(id)));
        if (!ids.length) {
            current.message = "没有由本节点生成的图片";
            refresh();
            return;
        }
        ctxRef.current.applyOps([{ type: "delete_node", ids }]);
        current.images = {};
        current.message = `已删除 ${ids.length} 个已出图节点`;
        persistSettings();
        refresh();
    };

    const toggleAuto = (next: boolean) => {
        const current = panelRuntime(nodeId);
        current.auto = next;
        current.message = next ? "已开启自动出图：上游分镜变化时会自动按序列出图" : "已关闭自动出图";
        persistSettings();
        refresh();
    };

    // 载入持久化设置（自动开关 / 已出图版本 / 图片节点记录）
    useEffect(() => {
        let alive = true;
        void (async () => {
            const current = panelRuntime(nodeId);
            try {
                const saved = await ctxRef.current.storage.get<PersistedPanels>(`panels:${nodeId}`);
                if (saved && typeof saved === "object") {
                    if (typeof saved.auto === "boolean") current.auto = saved.auto;
                    if (typeof saved.doneVersion === "number") current.doneVersion = saved.doneVersion;
                    if (saved.images && typeof saved.images === "object") current.images = { ...current.images, ...saved.images };
                }
            } catch {
                // 读不出来就用默认值
            } finally {
                if (alive) {
                    loadedRef.current = true;
                    refresh();
                }
            }
        })();
        return () => {
            alive = false;
        };
    }, [nodeId]);

    // 自动开工：事件即时触发 + 轮询兜底（节点被卸载时不 abort，出图过程继续）
    useEffect(() => {
        const maybeStart = () => {
            const current = panelRuntime(nodeId);
            if (!loadedRef.current || current.running || !current.auto) return;
            const upstream = resolveUpstream(ctxRef.current);
            if (!upstream) return;
            if (current.doneVersion === upstream.version) return;
            void startRun(upstream, false);
        };
        const off = ctxRef.current.on(PANELS_READY_EVENT, () => {
            window.setTimeout(maybeStart, 80);
        });
        const timer = window.setInterval(maybeStart, POLL_INTERVAL_MS);
        window.setTimeout(maybeStart, 400);
        return () => {
            off();
            window.clearInterval(timer);
        };
    }, [nodeId]);

    useEffect(() => {
        panelsRegistries.run.set(nodeId, () => {
            const current = panelRuntime(nodeId);
            if (current.running) return;
            const upstream = resolveUpstream(ctxRef.current);
            if (!upstream) {
                current.error = "";
                current.message = "上游没有分镜序列：请先把「分镜工作台」节点连接到本节点。";
                refresh();
                return;
            }
            current.error = "";
            void startRun(upstream, true);
        });
        panelsRegistries.clear.set(nodeId, clearImages);
        return () => {
            panelsRegistries.run.delete(nodeId);
            panelsRegistries.clear.delete(nodeId);
        };
    });

    const upstream = resolveUpstream(ctx);
    const grid = upstream?.grid || DEFAULT_GRID;
    const panels = upstream?.panels || [];
    const styles = accentStyles(theme);
    const { labelStyle, chipStyle, buttonStyle } = styles;
    const doneCount = panels.filter((panel) => runtime.images[String(panel.index)] && ctx.getNode(runtime.images[String(panel.index)])).length;

    return (
        <div
            data-canvas-no-zoom
            style={{
                position: "relative",
                width: "100%",
                height: "100%",
                display: "flex",
                flexDirection: "column",
                background: theme.node.panel,
                color: theme.node.text,
                borderRadius: 16,
                overflow: "hidden",
                outline: "2px solid #8b5cf6",
                outlineOffset: -2,
            }}
        >
            <div style={titleBarStyle(theme)}>
                <span style={{ flex: "0 0 auto" }}>🧩 分镜出图 · 拖拽标题栏移动节点</span>
                <span style={statusTextStyle()} title={runtime.error || runtime.message}>
                    {runtime.error || runtime.message}
                </span>
            </div>

            <div
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                onWheel={(event) => event.stopPropagation()}
                style={bodyStyle()}
            >
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button
                        type="button"
                        style={buttonStyle(true, runtime.running || !panels.length)}
                        onClick={() => {
                            const current = panelRuntime(nodeId);
                            if (current.running) return;
                            if (!upstream) {
                                current.message = "上游没有分镜序列：请先把「分镜工作台」节点连接到本节点。";
                                refresh();
                                return;
                            }
                            current.error = "";
                            void startRun(upstream, true);
                        }}
                    >
                        {runtime.running ? "出图中…" : doneCount ? "重新出图" : "开始出图"}
                    </button>
                    {runtime.running ? (
                        <button type="button" style={buttonStyle()} onClick={stopRun}>
                            停止
                        </button>
                    ) : null}
                    <button type="button" style={buttonStyle(false, !doneCount)} onClick={clearImages}>
                        删除已出图
                    </button>
                    <button
                        type="button"
                        style={chipStyle(runtime.auto)}
                        onClick={() => toggleAuto(!runtime.auto)}
                        title="开启后，只要上游分镜有新版本，就自动按分镜序列逐格出图"
                    >
                        自动出图：{runtime.auto ? "开" : "关"}
                    </button>
                </div>

                {upstream ? (
                    <div style={{ fontSize: 11.5, lineHeight: 1.7, color: theme.node.muted }}>
                        上游分镜：<span style={{ color: theme.node.text }}>{upstream.node.title || "分镜工作台"}</span> · {gridLabel(grid)} · 单格 {upstream.ratio}
                        {upstream.version ? <span> · 版本 {new Date(upstream.version).toLocaleString()}</span> : null}
                    </div>
                ) : (
                    <div style={{ fontSize: 11.5, lineHeight: 1.7, color: theme.node.muted, background: theme.node.faint, border: `1px solid ${theme.node.stroke}`, borderRadius: 8, padding: "8px 10px" }}>
                        把「分镜工作台」节点连接到本节点左侧，生成分镜后这里会自动按分镜序列逐格出图。
                        {`（本节点也可用工具条「开始出图」手动触发）`}
                    </div>
                )}

                {runtime.running || runtime.done ? (
                    <div style={{ fontSize: 11.5, color: theme.node.muted }}>
                        进度：{runtime.done} / {runtime.total || panels.length} 格{runtime.running && runtime.activeIndex ? ` · 正在处理 Panel ${pad2(runtime.activeIndex)}` : ""}
                        <div style={{ marginTop: 6, height: 6, borderRadius: 999, background: theme.node.faint, overflow: "hidden" }}>
                            <div
                                style={{
                                    width: `${Math.round((runtime.done / Math.max(1, runtime.total || panels.length)) * 100)}%`,
                                    height: "100%",
                                    background: "#8b5cf6",
                                    transition: "width 200ms ease",
                                }}
                            />
                        </div>
                    </div>
                ) : null}

                {runtime.error ? (
                    <div style={{ fontSize: 11.5, color: "#f87171", background: "rgba(248,113,113,.12)", border: "1px solid rgba(248,113,113,.35)", borderRadius: 8, padding: "8px 10px", lineHeight: 1.6 }}>
                        {runtime.error}
                        <div style={{ marginTop: 4, color: theme.node.muted }}>已出图的部分会保留；修好模型/额度后点「重新出图」即可从第一格重跑（已出图的格子会原地更新）。</div>
                    </div>
                ) : null}

                {panels.length ? (
                    <div>
                        <div style={{ ...labelStyle, marginBottom: 6 }}>分镜序列（{panels.length} 格 · 逐格出图）</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                            {panels.map((panel) => {
                                const imageId = runtime.images[String(panel.index)];
                                const node = imageId ? ctx.getNode(imageId) : null;
                                const active = runtime.running && runtime.activeIndex === panel.index;
                                return (
                                    <div
                                        key={panel.index}
                                        style={{
                                            display: "flex",
                                            alignItems: "center",
                                            gap: 8,
                                            padding: "5px 8px",
                                            borderRadius: 8,
                                            border: `1px solid ${active ? "#8b5cf6" : theme.node.stroke}`,
                                            background: active ? "rgba(139,92,246,.12)" : "transparent",
                                        }}
                                    >
                                        <span style={{ flex: "0 0 auto", fontSize: 11.5, fontWeight: 600, color: "#8b5cf6" }}>Panel {pad2(panel.index)}</span>
                                        <span style={{ flex: "1 1 auto", minWidth: 0, fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: theme.node.muted }} title={panel.prompt}>
                                            {panel.timecode ? `${panel.timecode} · ` : ""}
                                            {panel.shot || panel.prompt.slice(0, 64)}
                                        </span>
                                        <span style={{ flex: "0 0 auto", fontSize: 11, color: node ? "#22c55e" : theme.node.muted }}>
                                            {node ? "已出图" : active ? "出图中" : runtime.running ? "排队中" : "未出图"}
                                        </span>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : null}

                <div style={{ fontSize: 11, lineHeight: 1.7, color: theme.node.muted }}>
                    逐格图沿用 visual-production 的固定视觉语言与禁项（单帧版，不画网格），每格落成一个画布图片节点并写入本地媒体库；
                    分镜序列来自上游「分镜工作台」节点，本节点不修改任何创作规则。
                </div>
            </div>
        </div>
    );
}
