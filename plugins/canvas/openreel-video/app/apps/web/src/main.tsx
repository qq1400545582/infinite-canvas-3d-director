import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./index.css";
import { AstryxProvider } from "./components/astryx/AstryxProvider";
import { registerServiceWorker } from "./services/service-worker";
import { installCanvasHostBridge } from "./bridges/canvas-host-bridge";
import { initCustomFonts } from "./components/editor/inspector/font-options";
import { setEncoderBackendFactory } from "@openreel/core";
import { NativeFFmpegBackend } from "./services/native-ffmpeg-backend";

const DesktopApp = React.lazy(() =>
  import("./desktop/DesktopApp").then((module) => ({
    default: module.DesktopApp,
  })),
);

const isDesktop =
  typeof window !== "undefined" && window.openreel?.platform === "desktop";

if (isDesktop) {
  setEncoderBackendFactory(
    () =>
      new NativeFFmpegBackend(
        () =>
          (window as { __openreelExportPath?: string }).__openreelExportPath ??
          "",
      ),
  );
}

registerServiceWorker().then((registration) => {
  if (registration) {
  }
});

// 画布宿主桥：被 infinite-canvas 以同源 iframe 嵌入时，接收上游图片/视频节点产出的
// 媒体并写入媒体库（复用 importMedia，与「导入媒体」按钮同一条链路）。独立打开时无副作用。
installCanvasHostBridge();

void initCustomFonts();

const root = document.getElementById("root")!;

async function renderApplication(): Promise<void> {
  const application: React.ReactNode = isDesktop ? (
        <React.Suspense fallback={<div className="h-screen w-screen bg-bg" />}>
          <DesktopApp />
        </React.Suspense>
      ) : (
        <App />
      );

  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <AstryxProvider>{application}</AstryxProvider>
    </React.StrictMode>,
  );
}

void renderApplication();
