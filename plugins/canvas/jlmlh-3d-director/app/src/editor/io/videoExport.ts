import { flushSync } from "react-dom";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";
import { Vector2 } from "three";
import { useDirectorStore } from "../store/directorStore";
import { usePlaybackStore } from "../runtime/playbackStore";
import { getVideoExportContext } from "./videoExportBridge";
import { applyActiveCameraViewAtTime, applyTimelineTransformsAtTime } from "../runtime/playbackTransforms";
import { getViewportAspectRatioValue } from "../schema/viewportAspectRatio";

export type VideoExportView = "director" | "camera";

const EXPORT_FPS = 30;
/** 导出分辨率按「短边 = 720」基准缩放，画面比例取自 viewportAspectRatio（auto 时用视口当前比例） */
const EXPORT_SHORT_EDGE = 720;

function pickMimeType(): { mimeType: string; ext: string } {
  if (typeof MediaRecorder === "undefined") return { mimeType: "", ext: "webm" };
  const candidates = [
    { mimeType: "video/mp4;codecs=avc1", ext: "mp4" },
    { mimeType: "video/webm;codecs=vp9", ext: "webm" },
    { mimeType: "video/webm;codecs=vp8", ext: "webm" },
    { mimeType: "video/webm", ext: "webm" },
  ];
  return (
    candidates.find((item) => {
      try {
        return MediaRecorder.isTypeSupported(item.mimeType);
      } catch {
        return false;
      }
    }) ?? { mimeType: "", ext: "webm" }
  );
}

function findViewportCanvas(): HTMLCanvasElement | null {
  return document.querySelector<HTMLCanvasElement>(".director-canvas canvas");
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function waitNextFrame(): Promise<void> {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  );
}

/**
 * 按视频比例（viewportAspectRatio）计算导出尺寸，短边 720，宽高取偶（编码器要求）。
 * 「自动」也固定按 16:9 导出 —— 导出画面比例绝不受视口布局（如时间轴拖高压扁视口）影响，
 * 否则视口是扁的时导出也会跟着扁。
 */
export function computeExportSize(
  aspectRatioId: ReturnType<typeof useDirectorStore.getState>["viewportAspectRatio"]
): { width: number; height: number } {
  const aspect = getViewportAspectRatioValue(aspectRatioId) ?? 16 / 9;
  let width: number;
  let height: number;
  if (aspect >= 1) {
    height = EXPORT_SHORT_EDGE;
    width = Math.round(height * aspect);
  } else {
    width = EXPORT_SHORT_EDGE;
    height = Math.round(width / aspect);
  }
  return { width: width + (width % 2), height: height + (height % 2) };
}

async function pickVideoEncoderConfig(width: number, height: number) {
  const candidates = [
    { codec: "avc1.640028" }, // High 4.0
    { codec: "avc1.4d0028" }, // Main 4.0
    { codec: "avc1.42001f" }, // Baseline 3.1
  ];
  const bitrate = Math.round(width * height * EXPORT_FPS * 0.15); // ≈6Mbps @720p30
  for (const { codec } of candidates) {
    const config: VideoEncoderConfig = {
      codec,
      width,
      height,
      bitrate,
      framerate: EXPORT_FPS,
    };
    try {
      const support = await VideoEncoder.isConfigSupported(config);
      if (support.supported) return config;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return null;
}

/**
 * 逐帧离线导出（快，不用实时播放一遍）：
 * - 渲染分辨率固定为视频比例（短边 720），不受视口布局影响 —— 时间轴拖多高画面都不会变扁
 * - 每帧直接 setPlayhead(t) + 手动渲染 + WebCodecs 编码，渲染多快导多快
 * - H.264 编码进 MP4（Chrome / Electron 均支持）
 */
async function exportVideoFrameByFrame(view: VideoExportView): Promise<void> {
  const bridge = getVideoExportContext();
  if (!bridge) throw new Error("找不到视口渲染上下文");
  const { gl, scene, camera } = bridge;
  const canvas = gl.domElement;

  const directorStore = useDirectorStore.getState();
  const { width, height } = computeExportSize(directorStore.viewportAspectRatio);
  const duration = directorStore.project.timeline.duration;
  const totalFrames = Math.max(1, Math.round(duration * EXPORT_FPS));

  const encoderConfig = await pickVideoEncoderConfig(width, height);
  if (!encoderConfig) throw new Error("当前浏览器不支持 H.264 编码，请用最新版 Chrome / Edge");

  // 保存现场：导出完原样恢复（视角 / 指针 / 渲染尺寸 / 相机比例）
  const previousViewMode = directorStore.viewMode;
  const previousPlayhead = usePlaybackStore.getState().playhead;
  const previousPlaying = usePlaybackStore.getState().isPlaying;
  const previousSize = new Vector2();
  gl.getSize(previousSize);
  const previousPixelRatio = gl.getPixelRatio();
  const previousAspect = camera.aspect;

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: "avc", width, height },
    fastStart: "in-memory",
  });
  let encodeError: unknown = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: (error) => {
      encodeError = encodeError ?? error;
    },
  });
  encoder.configure(encoderConfig);

  // 切到导出状态：固定分辨率渲染（不改 CSS 尺寸，canvas 加 object-fit: contain 保持显示不变形）
  usePlaybackStore.getState().setPlaying(false);
  directorStore.setViewMode(view);
  canvas.classList.add("is-video-exporting");
  gl.setPixelRatio(1);
  gl.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();

  // 切视角会让 R3F 更换渲染相机（机位视角挂载 drei PerspectiveCamera），
  // 等一拍让 VideoExportBridge 重新注册最新相机，导出循环里也每帧取最新引用
  await new Promise<void>((resolve) => window.setTimeout(resolve, 0));

  const frameDurationUs = Math.round(1_000_000 / EXPORT_FPS);
  try {
    for (let frameIndex = 0; frameIndex <= totalFrames; frameIndex += 1) {
      if (encodeError) throw encodeError;
      const time = Math.min(frameIndex / EXPORT_FPS, duration);
      // 相机可能因视角切换被替换，每帧从桥取最新；并保证导出画面比例
      const frameCamera = getVideoExportContext()?.camera ?? camera;
      frameCamera.aspect = width / height;
      frameCamera.updateProjectionMatrix();

      // 同步推进 playhead 让 React 侧内容（角色动作等）立刻更新到 t
      flushSync(() => {
        usePlaybackStore.getState().setPlayhead(time);
      });
      // 手动应用物体 / 相机运镜插值（与预览的 useFrame 同步逻辑共用）
      applyTimelineTransformsAtTime(
        scene,
        directorStore.project.timeline.tracks,
        directorStore.project.timeline.cameraTracks,
        time,
        usePlaybackStore.getState().editingObjectId
      );
      applyActiveCameraViewAtTime({
        camera: frameCamera,
        cameraTracks: directorStore.project.timeline.cameraTracks,
        activeCameraId: directorStore.project.activeCameraId,
        playhead: time,
        viewMode: view,
        editingObjectId: usePlaybackStore.getState().editingObjectId,
      });

      gl.render(scene, frameCamera);

      const frame = new VideoFrame(canvas, {
        timestamp: frameIndex * frameDurationUs,
        duration: frameDurationUs,
      });
      encoder.encode(frame, { keyFrame: frameIndex % (EXPORT_FPS * 2) === 0 });
      frame.close();

      // 背压：编码队列太深时等一等，防止内存堆积
      while (encoder.encodeQueueSize > 8) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 4));
      }
      // 让出主线程，保持界面可响应（进度画面快进效果）
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }

    await encoder.flush();
    muxer.finalize();
    if (encodeError) throw encodeError;

    const blob = new Blob([muxer.target.buffer], { type: "video/mp4" });
    const viewLabel = view === "director" ? "上帝视角" : "机位视角";
    downloadBlob(blob, `director-desk-${viewLabel}-${Date.now()}.mp4`);
  } finally {
    encoder.close();
    canvas.classList.remove("is-video-exporting");
    gl.setPixelRatio(previousPixelRatio);
    gl.setSize(previousSize.x, previousSize.y, false);
    const restoreCamera = getVideoExportContext()?.camera ?? camera;
    restoreCamera.aspect = previousAspect;
    restoreCamera.updateProjectionMatrix();
    directorStore.setViewMode(previousViewMode);
    usePlaybackStore.getState().setPlaying(previousPlaying);
    usePlaybackStore.getState().setPlayhead(previousPlayhead);
  }
}

/**
 * 旧版实时录制（MediaRecorder 兜底路径）：只在浏览器不支持 WebCodecs 时使用。
 * 从 playhead 0 播放到时间轴末尾录屏，耗时 = 视频时长。
 */
async function exportVideoWithMediaRecorder(view: VideoExportView): Promise<void> {
  const canvas = findViewportCanvas();
  if (!canvas) throw new Error("找不到视口画布");
  if (typeof MediaRecorder === "undefined") {
    throw new Error("当前浏览器不支持视频录制（MediaRecorder），请用 Chrome/Edge/Firefox");
  }

  const { mimeType, ext } = pickMimeType();
  const fps = 30;
  const stream = canvas.captureStream(fps);
  const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) chunks.push(event.data);
  };

  const directorStore = useDirectorStore.getState();
  const duration = directorStore.project.timeline.duration;

  // 切视角 + 复位指针 + 录制模式（到末尾停住不循环）
  directorStore.setViewMode(view);
  const playback = usePlaybackStore.getState();
  playback.setStopAtEnd(true);
  playback.setPlayhead(0);

  const stopped = new Promise<void>((resolve) => {
    recorder.onstop = () => resolve();
  });

  recorder.start();

  // 等两帧让视角切换 + 首帧渲染，避免录到上一视角的残影
  await waitNextFrame();

  // 监听播放结束（stopAtEnd → isPlaying 置 false）→ 停止录制
  const unsubscribe = usePlaybackStore.subscribe((state) => {
    if (!state.isPlaying) {
      try {
        if (recorder.state !== "inactive") recorder.stop();
      } catch {
        /* ignore */
      }
    }
  });

  usePlaybackStore.getState().setPlaying(true);

  // 保底：duration + 余量后强制停（防止 advance 因帧率/时序没准确触发）
  const fallbackTimer = window.setTimeout(() => {
    try {
      if (recorder.state !== "inactive") recorder.stop();
    } catch {
      /* ignore */
    }
  }, duration * 1000 + 600);

  await stopped;
  clearTimeout(fallbackTimer);
  unsubscribe();

  usePlaybackStore.getState().setStopAtEnd(false);
  usePlaybackStore.getState().setPlaying(false);

  const viewLabel = view === "director" ? "上帝视角" : "机位视角";
  const blob = new Blob(chunks, { type: mimeType || "video/webm" });
  downloadBlob(blob, `director-desk-${viewLabel}-${Date.now()}.${ext}`);
}

/**
 * 导出视频：优先 WebCodecs 逐帧快速导出（MP4，固定分辨率，不受视口布局影响）；
 * 浏览器不支持时回退 MediaRecorder 实时录屏（WebM/MP4，耗时 = 视频时长）。
 */
export async function exportVideo(view: VideoExportView): Promise<void> {
  if (typeof VideoEncoder !== "undefined") {
    await exportVideoFrameByFrame(view);
    return;
  }
  await exportVideoWithMediaRecorder(view);
}
