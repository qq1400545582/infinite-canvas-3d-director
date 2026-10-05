import { create } from "zustand";

import { isCoarsePointer, isCompactViewport } from "@/lib/canvas-environment";

export const CANVAS_SIDE_PANEL_MOTION_MS = 500;
export const CANVAS_SIDE_PANEL_MIN_WIDTH = 220;
export const CANVAS_SIDE_PANEL_MAX_WIDTH = 480;
export const CANVAS_SIDE_PANEL_DEFAULT_WIDTH = 280;

const WIDTH_KEY = "canvas-side-panel-width";
const OPEN_KEY = "canvas-side-panel-open";

function initialWidth() {
    if (typeof window === "undefined") return CANVAS_SIDE_PANEL_DEFAULT_WIDTH;
    const stored = Number(localStorage.getItem(WIDTH_KEY));
    if (!stored) return CANVAS_SIDE_PANEL_DEFAULT_WIDTH;
    return Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, stored));
}

/**
 * 自适应默认：窄屏或手指优先的设备上，默认收起侧栏，把整块屏幕让给画布（用户仍可一键展开）。
 * 只要用户自己切换过（localStorage 里有值），就以用户的决定为准，不再自动改变。
 */
function initialOpen() {
    if (typeof window === "undefined") return true;
    const stored = localStorage.getItem(OPEN_KEY);
    if (stored !== null) return stored !== "0";
    return !(isCompactViewport() || isCoarsePointer());
}

type CanvasSidePanelStore = {
    width: number;
    panelOpen: boolean;
    panelMounted: boolean;
    panelClosing: boolean;
    setWidth: (width: number) => void;
    openPanel: () => void;
    closePanel: () => void;
    togglePanel: () => void;
};

export const useCanvasSidePanelStore = create<CanvasSidePanelStore>((set, get) => ({
    width: initialWidth(),
    panelOpen: initialOpen(),
    panelMounted: initialOpen(),
    panelClosing: false,
    setWidth: (width) => set({ width }),
    openPanel: () => {
        if (typeof window !== "undefined") localStorage.setItem(OPEN_KEY, "1");
        set({ panelOpen: true, panelMounted: true, panelClosing: false });
    },
    closePanel: () => {
        if (!get().panelMounted || get().panelClosing) return;
        if (typeof window !== "undefined") localStorage.setItem(OPEN_KEY, "0");
        set({ panelOpen: false, panelClosing: true });
        setTimeout(() => {
            if (get().panelClosing) set({ panelMounted: false, panelClosing: false });
        }, CANVAS_SIDE_PANEL_MOTION_MS);
    },
    togglePanel: () => (get().panelOpen ? get().closePanel() : get().openPanel()),
}));
