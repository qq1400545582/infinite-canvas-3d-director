/**
 * 运行环境自适应（环境判断的唯一入口）。
 *
 * 设计原则：不做「一次性 UA 判断」来决定整站行为，而是分三层判断，各自用最合适的信号 ——
 *
 *  1. 布局层（收不收侧栏、工具栏避让、控件密度）：看**视口宽度**，
 *     用 `useCanvasEnvironment().compact`，随窗口缩放/手机横竖屏实时刷新。
 *  2. 交互层（这一下是拖拽还是缩放）：看**当次事件的 pointerType**，
 *     用 `isTouchPointerEvent(event)`。这样二合一设备/带触屏的笔记本插着鼠标也能自动切换，
 *     同一台机器上手指和鼠标各走各的逻辑，互不干扰。
 *  3. 兜底层（触屏上不存在 hover，必须换触发方式）：看**是否粗指针**，
 *     用 `coarse`，只在少数场景用于初始化状态（例如底部坞默认展开）。
 */

import { useEffect, useState } from "react";

/** 与 Tailwind 的 `md:` 断点保持一致（768px），低于该宽度视为紧凑布局。 */
export const COMPACT_VIEWPORT_QUERY = "(max-width: 767px)";
/** 粗指针 = 主要输入是手指（手机/平板/触屏一体机）。 */
export const COARSE_POINTER_QUERY = "(pointer: coarse)";

function queryMatches(query: string): boolean {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
}

/** 当前视口是否属于紧凑布局（手机竖屏/小窗）。 */
export function isCompactViewport(): boolean {
    return queryMatches(COMPACT_VIEWPORT_QUERY);
}

/** 当前主输入设备是否粗指针（触摸优先）。 */
export function isCoarsePointer(): boolean {
    return queryMatches(COARSE_POINTER_QUERY);
}

/**
 * 订阅媒体查询的 Hook（SSR / jsdom 安全）。
 * 返回值随窗口缩放、旋转屏幕、外接鼠标等变化自动刷新。
 */
export function useMediaQuery(query: string): boolean {
    const [matches, setMatches] = useState(() => queryMatches(query));

    useEffect(() => {
        if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
        const list = window.matchMedia(query);
        const update = () => setMatches(list.matches);
        update();
        list.addEventListener("change", update);
        return () => list.removeEventListener("change", update);
    }, [query]);

    return matches;
}

/** 画布页面的统一环境读数。 */
export function useCanvasEnvironment(): { compact: boolean; coarse: boolean } {
    const compact = useMediaQuery(COMPACT_VIEWPORT_QUERY);
    const coarse = useMediaQuery(COARSE_POINTER_QUERY);
    return { compact, coarse };
}

/**
 * 判断一次指针事件是否来自手指/触控笔（非鼠标）。
 * 鼠标一律返回 false —— 鼠标路径完全交还给既有的 mouse 事件链路，桌面端行为零改动。
 */
export function isTouchPointerEvent(event: { pointerType?: string }): boolean {
    return event.pointerType === "touch" || event.pointerType === "pen";
}

/** 把 PointerEvent 当成 MouseEvent 交给既有的鼠标处理函数（字段兼容：clientX/Y、button、shiftKey…）。 */
export function asSyntheticMouseEvent<T>(event: T): T & Pick<MouseEvent, "button" | "clientX" | "clientY" | "shiftKey" | "metaKey" | "ctrlKey"> {
    return event as T & Pick<MouseEvent, "button" | "clientX" | "clientY" | "shiftKey" | "metaKey" | "ctrlKey">;
}
