import type { Object3D, PerspectiveCamera, WebGLRenderer } from "three";

/**
 * 把 R3F <Canvas> 内部的渲染三件套（renderer / scene / camera）暴露给
 * Canvas 外的视频导出逻辑（videoExport.ts），供逐帧离线渲染。
 * 模式与 captureBridge.ts 一致：Canvas 内的桥组件注册，导出方读取。
 */
export interface VideoExportContext {
  gl: WebGLRenderer;
  scene: Object3D;
  camera: PerspectiveCamera;
}

let videoExportContext: VideoExportContext | null = null;

export function setVideoExportContext(context: VideoExportContext | null) {
  videoExportContext = context;
}

export function getVideoExportContext() {
  return videoExportContext;
}
