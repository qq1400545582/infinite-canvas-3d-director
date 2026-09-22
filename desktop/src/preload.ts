import { contextBridge } from "electron";

// 暴露一个全局标志，让 web 端（LayerVersionPanel 等）知道自己运行在桌面壳里。
// web/ 端据此决定是否渲染「三层更新」面板，网页版（CF Pages）无此标志 → 完全不渲染，零行为变化。
contextBridge.exposeInMainWorld("__INFINITE_CANVAS_DESKTOP__", true);
