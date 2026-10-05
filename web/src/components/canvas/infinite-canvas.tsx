import React, { useEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundKind, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { isTouchPointerEvent } from "@/lib/canvas-environment";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

/** 触摸捏合的最小/最大缩放，与滚轮缩放保持一致（见 handleWheel）。 */
const MIN_PINCH_SCALE = 0.05;
const MAX_PINCH_SCALE = 5;
/** 轻点判定：按下到抬起不超过 300ms 且位移小于 8px 才算 tap（位移阈值见 touchPoints.moved）。 */
const TOUCH_TAP_MS = 300;
/** 双击阈值：300ms 内、相距 32px 以内的两次轻点。 */
const TOUCH_DOUBLE_TAP_MS = 300;
const TOUCH_DOUBLE_TAP_DISTANCE = 32;

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    tool: "select" | "pan";
    backgroundMode?: CanvasBackgroundMode;
    /** 画布外观 - 自定义背景媒体（已解析出的可显示 URL） */
    backgroundMediaUrl?: string;
    backgroundMediaKind?: CanvasBackgroundKind;
    /** 画布外观 - 背景媒体透明度 0~1 */
    backgroundOpacity?: number;
    /** 画布外观 - 节点上文字透明度 0~1 */
    fontOpacity?: number;
    /** 画布外观 - 节点卡面透明度 0~1 */
    nodeOpacity?: number;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, tool, backgroundMode = "lines", backgroundMediaUrl = "", backgroundMediaKind = "image", backgroundOpacity = 1, fontOpacity = 1, nodeOpacity = 1, onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    // 画布外观的可调项通过 CSS 变量下发给节点层，节点侧只在自身样式里引用变量，无需逐层透传 props。
    const appearanceVars = {
        "--canvas-node-opacity": String(nodeOpacity),
        "--canvas-font-opacity": String(fontOpacity),
    } as React.CSSProperties;
    const panState = useRef({
        isPanning: false,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const scaleRef = useRef(viewport.k);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    // 触摸姿态：正在按下的手指（pointerId → 按下/当前坐标，以及是否移动过）。
    // 只记录「在空白处按下」的手指 —— 落在节点/浮层上的被它们自己 stopPropagation 掉了。
    const touchPoints = useRef(new Map<number, { x: number; y: number; startX: number; startY: number; startTime: number; moved: boolean }>());
    // 上一次「空白处的轻点」信息：手机上没有原生 dblclick（浏览器也不再补发），双击 += 自己识别。
    const lastTapRef = useRef<{ time: number; x: number; y: number } | null>(null);
    // 捏合中记录的基准：起始指距、起始缩放、以及起始中点下方的世界坐标（双指平移时跟着走）。
    const pinchRef = useRef<{ startDistance: number; startScale: number; worldX: number; worldY: number } | null>(null);
    const pinchFrameRef = useRef<number | null>(null);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useEffect(() => {
        scaleRef.current = viewport.k;
    }, [viewport.k]);

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (pinchFrameRef.current) cancelAnimationFrame(pinchFrameRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            setIsSpacePressed(false);
            setIsControlPressed(false);
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        const delta = -event.deltaY;
        const factor = Math.pow(1.1, delta / 100);
        const newScale = Math.min(Math.max(viewport.k * factor, 0.05), 5);
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;

        const mouseX = event.clientX - rect.left;
        const mouseY = event.clientY - rect.top;
        const worldX = (mouseX - viewport.x) / viewport.k;
        const worldY = (mouseY - viewport.y) / viewport.k;

        onViewportChange({
            x: mouseX - worldX * newScale,
            y: mouseY - worldY * newScale,
            k: newScale,
        });
    };

    /**
     * 读取当前两指的距离与中点（换算到容器局部坐标）。
     * 少于两指时返回 null，调用方据此判断「捏合是否还成立」。
     */
    const readPinch = () => {
        const rect = containerRef.current?.getBoundingClientRect();
        const points = Array.from(touchPoints.current.values());
        if (!rect || points.length < 2) return null;
        const [first, second] = points;
        return {
            distance: Math.hypot(first.x - second.x, first.y - second.y) || 1,
            midX: (first.x + second.x) / 2 - rect.left,
            midY: (first.y + second.y) / 2 - rect.top,
        };
    };

    /** 第二根手指落下时开始捏合：以「此刻的视口 + 此刻中点下方的画布坐标」为基准。 */
    const startPinch = () => {
        const read = readPinch();
        if (!read) return;
        pinchRef.current = {
            startDistance: read.distance,
            startScale: viewport.k,
            worldX: (read.midX - viewport.x) / viewport.k,
            worldY: (read.midY - viewport.y) / viewport.k,
        };
        // 双指介入时立刻收掉单指平移，避免两套投影互相打架。
        panState.current.isPanning = false;
        setIsPanning(false);
        document.body.style.cursor = "";
    };

    /**
     * 捏合过程中刷新视口：把「起始中点下方那个画布点」钉在当前中点上。
     * 这样捏合缩放与双指平移是同一套公式，两指同时移动时画布跟手。
     */
    const applyPinch = () => {
        if (pinchFrameRef.current) return;
        pinchFrameRef.current = requestAnimationFrame(() => {
            pinchFrameRef.current = null;
            const pinch = pinchRef.current;
            const read = pinch ? readPinch() : null;
            if (!pinch || !read) return;
            const nextScale = Math.min(Math.max((pinch.startScale * read.distance) / pinch.startDistance, MIN_PINCH_SCALE), MAX_PINCH_SCALE);
            onViewportChange({
                x: read.midX - pinch.worldX * nextScale,
                y: read.midY - pinch.worldY * nextScale,
                k: nextScale,
            });
        });
    };

    /** 手指落在空白处启动平移：写入与鼠标平移完全相同的 panState，后续 move/up 逻辑原样复用。 */
    const startTouchPan = (event: React.PointerEvent<HTMLDivElement>) => {
        panState.current = {
            isPanning: true,
            startX: event.clientX,
            startY: event.clientY,
            initialX: viewport.x,
            initialY: viewport.y,
            hasMoved: false,
            startedOnBackground: true,
        };
        setIsPanning(true);
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;

        // —— 触摸 / 触控笔链路：这一支只为手指服务，鼠标那条链路（button===0/1、工具状态）一行未动 ——
        if (isTouchPointerEvent(event)) {
            touchPoints.current.set(event.pointerId, { x: event.clientX, y: event.clientY, startX: event.clientX, startY: event.clientY, startTime: Date.now(), moved: false });

            // 第二根手指落下 → 捏合缩放（同时支持双指平移）。
            if (touchPoints.current.size >= 2) {
                event.preventDefault();
                startPinch();
                return;
            }

            // 手指落在节点或连线上 → 完全交给它们自己的 pointerdown，画布不抢占。
            if (target?.closest("[data-node-id],[data-connection-id]")) return;

            // 空白处单指 → 平移画布。手机上「一根手指拖动画布」是通用直觉，与当前选中哪个工具无关；
            // 拉框框选对手指来说精度太差，仍只保留给鼠标手势。
            event.preventDefault();
            startTouchPan(event);
            return;
        }

        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        const temporaryTool = event.ctrlKey || isSpacePressed;
        const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
        const shouldPan = event.button === 1 || (event.button === 0 && activeTool === "pan" && isBackgroundClick);

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                startX: event.clientX,
                startY: event.clientY,
                initialX: viewport.x,
                initialY: viewport.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick,
            };
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && isBackgroundClick) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            // 维护手指位置表：捏合与单指平移都从这里取当前坐标。
            const activePoint = touchPoints.current.get(event.pointerId);
            if (activePoint) {
                activePoint.x = event.clientX;
                activePoint.y = event.clientY;
                if (Math.abs(event.clientX - activePoint.startX) > 8 || Math.abs(event.clientY - activePoint.startY) > 8) activePoint.moved = true;
            }

            // 捏合优先级最高：双指在屏幕时忽略单指平移，避免两套属于不同意图的位移叠加。
            if (pinchRef.current) {
                if (touchPoints.current.size >= 2) applyPinch();
                return;
            }

            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
                panState.current.hasMoved = true;
            }

            nextViewportRef.current = {
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: scaleRef.current,
            };
            if (frameRef.current) return;
            frameRef.current = requestAnimationFrame(() => {
                frameRef.current = null;
                if (nextViewportRef.current) onViewportChange(nextViewportRef.current);
            });
        };

        const handlePointerUp = (event: PointerEvent) => {
            // 手指抬起：先维护登记表，再判断要不要结束捏合。
            const liftedPoint = touchPoints.current.get(event.pointerId);
            touchPoints.current.delete(event.pointerId);

            // 空白处轻点 → 记录；连续两次轻点视为双击（唤出节点创建菜单）。
            // 背景手势是 preventDefault 的，浏览器不会再补发 click/dblclick，这一步必须自己做。
            if (liftedPoint && !liftedPoint.moved && Date.now() - liftedPoint.startTime < TOUCH_TAP_MS) {
                const previousTap = lastTapRef.current;
                const isDoubleTap = Boolean(previousTap) && Date.now() - previousTap!.time < TOUCH_DOUBLE_TAP_MS && Math.hypot(event.clientX - previousTap!.x, event.clientY - previousTap!.y) < TOUCH_DOUBLE_TAP_DISTANCE;
                lastTapRef.current = { time: Date.now(), x: event.clientX, y: event.clientY };
                if (isDoubleTap) {
                    lastTapRef.current = null;
                    onCanvasDoubleClick?.({ clientX: event.clientX, clientY: event.clientY } as unknown as React.MouseEvent<HTMLDivElement>);
                }
            } else if (liftedPoint && liftedPoint.moved) {
                lastTapRef.current = null;
            }

            if (pinchRef.current && touchPoints.current.size < 2) {
                pinchRef.current = null;
                if (pinchFrameRef.current) {
                    cancelAnimationFrame(pinchFrameRef.current);
                    pinchFrameRef.current = null;
                }
                // 捏合结束后可能还剩一根手指：这里不接管为平移，免得松一只手时画布突然窜一下，
                // 让用户重新落一次手指即可继续平移，起算点干净。
                panState.current.isPanning = false;
                setIsPanning(false);
                document.body.style.cursor = "";
                return;
            }

            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            panState.current.isPanning = false;
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const temporaryTool = isControlPressed || isSpacePressed;
    const activeTool = temporaryTool ? (tool === "select" ? "pan" : "select") : tool;
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : undefined;

    return (
        <div
            ref={containerRef}
            className="relative h-full w-full select-none overflow-hidden"
            // touch-action: none —— 把手势完全交给画布处理，浏览器不再抢去做「页面滚动 / 双击放大 / 长按呼菜单」。
            // 注意：touch-action 沿祖先链取交集，因此节点内部需要滚动的区域（文本/提示词）会另行声明 touch-action: pan-y。
            style={{ background: theme.canvas.background, cursor, touchAction: "none", ...appearanceVars }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            {backgroundMediaUrl ? <CanvasBackgroundMediaLayer url={backgroundMediaUrl} kind={backgroundMediaKind} opacity={backgroundOpacity} /> : null}
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

/**
 * 画布外观 - 自定义背景层（图片/视频，格式不限）。
 * 固定铺满视口且不随画布平移缩放移动，纯展示层：pointer-events 关闭，不参与任何画布交互。
 */
function CanvasBackgroundMediaLayer({ url, kind, opacity }: { url: string; kind: CanvasBackgroundKind; opacity: number }) {
    const style = { opacity: Math.min(Math.max(opacity, 0), 1) };
    if (kind === "video") return <video className="pointer-events-none absolute inset-0 h-full w-full object-cover" style={style} src={url} autoPlay loop muted playsInline />;
    return <div className="pointer-events-none absolute inset-0 bg-cover bg-center bg-no-repeat" style={{ ...style, backgroundImage: `url("${url.replace(/["\\]/g, "\\$&")}")` }} />;
}

function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = 48 * viewport.k;
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            className="pointer-events-none absolute inset-0 opacity-40"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}
