import { useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { CameraKeyframeValue, KeyframeTransformValue } from "../schema/timeline";
import { useDirectorStore } from "../store/directorStore";
import { usePlaybackStore } from "../runtime/playbackStore";
import { exportVideo, type VideoExportView } from "../io/videoExport";

interface SelectedKeyframe {
  kind: "object" | "camera";
  targetId: string;
  keyframeId: string;
}

const TIMELINE_MIN_HEIGHT = 160;
const TIMELINE_DEFAULT_HEIGHT = 300;
/** 面板最大高度固定值：内容再多也在面板内部滚动，不把 3D 视口压没 */
const TIMELINE_MAX_HEIGHT = 420;
const TIMELINE_HEIGHT_STORAGE_KEY = "director.timeline.height";

function clampTimelineHeight(height: number) {
  return Math.min(Math.max(Math.round(height), TIMELINE_MIN_HEIGHT), TIMELINE_MAX_HEIGHT);
}

function loadTimelineHeight() {
  try {
    const raw = window.localStorage.getItem(TIMELINE_HEIGHT_STORAGE_KEY);
    if (!raw) return TIMELINE_DEFAULT_HEIGHT;
    const value = Number(raw);
    return Number.isFinite(value) ? clampTimelineHeight(value) : TIMELINE_DEFAULT_HEIGHT;
  } catch {
    return TIMELINE_DEFAULT_HEIGHT;
  }
}

function formatTime(t: number) {
  return `${t.toFixed(1)}s`;
}

export function TimelinePanel() {
  const project = useDirectorStore((state) => state.project);
  const selectedObjectId = useDirectorStore((state) => state.selectedObjectId);

  const addKeyframe = useDirectorStore((state) => state.addKeyframe);
  const removeKeyframe = useDirectorStore((state) => state.removeKeyframe);
  const updateKeyframeValue = useDirectorStore((state) => state.updateKeyframeValue);
  const applyKeyframeToObjectTransform = useDirectorStore((state) => state.applyKeyframeToObjectTransform);
  const addCameraKeyframe = useDirectorStore((state) => state.addCameraKeyframe);
  const removeCameraKeyframe = useDirectorStore((state) => state.removeCameraKeyframe);
  const updateCameraKeyframeValue = useDirectorStore((state) => state.updateCameraKeyframeValue);
  const applyCameraKeyframeToShot = useDirectorStore((state) => state.applyCameraKeyframeToShot);
  const setTimelineDuration = useDirectorStore((state) => state.setTimelineDuration);
  const clearAllKeyframes = useDirectorStore((state) => state.clearAllKeyframes);

  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const playhead = usePlaybackStore((state) => state.playhead);
  const duration = usePlaybackStore((state) => state.duration);
  const togglePlaying = usePlaybackStore((state) => state.togglePlaying);
  const setPlaying = usePlaybackStore((state) => state.setPlaying);
  const setPlayhead = usePlaybackStore((state) => state.setPlayhead);

  const [selectedKeyframe, setSelectedKeyframe] = useState<SelectedKeyframe | null>(null);
  const [isRecording, setIsRecording] = useState(false);

  // 时间轴面板高度：可拖动顶部手柄调整（向上拖变大），并持久化到 localStorage
  const [timelineHeight, setTimelineHeight] = useState(loadTimelineHeight);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartRef = useRef<{ pointerY: number; startHeight: number } | null>(null);
  const timelineHeightRef = useRef(timelineHeight);
  timelineHeightRef.current = timelineHeight;

  useEffect(() => {
    if (!isResizing) return;
    document.body.classList.add("is-resizing-timeline");
    return () => document.body.classList.remove("is-resizing-timeline");
  }, [isResizing]);

  function handleResizeStart(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    resizeStartRef.current = { pointerY: event.clientY, startHeight: timelineHeight };
    setIsResizing(true);
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 某些环境（如 jsdom）不支持 pointer capture，忽略后仍可通过 move/up 事件拖拽
    }
  }

  function handleResizeMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = resizeStartRef.current;
    if (!start) return;
    setTimelineHeight(clampTimelineHeight(start.startHeight + (start.pointerY - event.clientY)));
  }

  function handleResizeEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (!resizeStartRef.current) return;
    resizeStartRef.current = null;
    setIsResizing(false);
    try {
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {
      // 同上，忽略不支持的环境
    }
    try {
      window.localStorage.setItem(TIMELINE_HEIGHT_STORAGE_KEY, String(timelineHeightRef.current));
    } catch {
      // 持久化失败（如隐私模式）不影响功能
    }
  }

  const timeline = project.timeline;

  // 选中目标解析：物体 or 相机
  const selectedObject = project.objects.find((o) => o.id === selectedObjectId) ?? null;
  const selectedCameraObject =
    selectedObject?.kind === "camera" ? selectedObject : null;
  const selectedShot = selectedCameraObject?.linkedCameraId
    ? project.cameras.find((c) => c.id === selectedCameraObject.linkedCameraId) ?? null
    : null;
  const canAddCameraKeyframe = Boolean(selectedShot && selectedShot.targetMode === "manual");
  const selectionIsManualCamera = Boolean(selectedCameraObject);

  function snapshotObjectTransform(): KeyframeTransformValue {
    if (!selectedObject) throw new Error("no selected object");
    return {
      position: [...selectedObject.transform.position] as [number, number, number],
      rotation: [...selectedObject.transform.rotation] as [number, number, number],
      scale: [...selectedObject.transform.scale] as [number, number, number],
    };
  }
  function snapshotShot(): CameraKeyframeValue {
    if (!selectedShot) throw new Error("no selected shot");
    return {
      position: [...selectedShot.transform.position] as [number, number, number],
      target: [...selectedShot.target] as [number, number, number],
      fov: selectedShot.fov,
    };
  }

  function handleAddKeyframe() {
    if (selectionIsManualCamera) {
      if (!selectedShot || selectedShot.targetMode !== "manual") return;
      addCameraKeyframe(selectedShot.id, playhead, snapshotShot());
    } else if (selectedObject) {
      addKeyframe(selectedObject.id, playhead, snapshotObjectTransform());
    }
  }

  function handleSelectObjectKeyframe(objectId: string, keyframeId: string, time: number, value: KeyframeTransformValue) {
    setPlaying(false);
    setPlayhead(time);
    applyKeyframeToObjectTransform(objectId, value);
    setSelectedKeyframe({ kind: "object", targetId: objectId, keyframeId });
  }
  function handleSelectCameraKeyframe(cameraId: string, keyframeId: string, time: number, value: CameraKeyframeValue) {
    setPlaying(false);
    setPlayhead(time);
    applyCameraKeyframeToShot(cameraId, value);
    setSelectedKeyframe({ kind: "camera", targetId: cameraId, keyframeId });
  }

  function handleUpdateSelected() {
    if (!selectedKeyframe) return;
    if (selectedKeyframe.kind === "object" && selectedObject) {
      updateKeyframeValue(selectedKeyframe.targetId, selectedKeyframe.keyframeId, snapshotObjectTransform());
    } else if (selectedKeyframe.kind === "camera" && selectedShot) {
      updateCameraKeyframeValue(selectedKeyframe.targetId, selectedKeyframe.keyframeId, snapshotShot());
    }
  }
  function handleDeleteSelected() {
    if (!selectedKeyframe) return;
    if (selectedKeyframe.kind === "object") {
      removeKeyframe(selectedKeyframe.targetId, selectedKeyframe.keyframeId);
    } else {
      removeCameraKeyframe(selectedKeyframe.targetId, selectedKeyframe.keyframeId);
    }
    setSelectedKeyframe(null);
  }

  function handleClearAll() {
    if (timeline.tracks.length === 0 && timeline.cameraTracks.length === 0) return;
    if (window.confirm("确定清空所有关键帧吗？此操作可用撤销恢复。")) {
      clearAllKeyframes();
      setSelectedKeyframe(null);
    }
  }

  async function handleExportVideo(view: VideoExportView) {
    setIsRecording(true);
    try {
      await exportVideo(view);
    } catch (error) {
      console.error("[videoExport]", error);
      window.alert(error instanceof Error ? error.message : "视频导出失败");
    } finally {
      setIsRecording(false);
    }
  }

  const addKeyframeDisabled = selectionIsManualCamera ? !canAddCameraKeyframe : !selectedObject;
  const addKeyframeTitle = selectionIsManualCamera
    ? canAddCameraKeyframe
      ? `把相机「${selectedShot?.name}」当前机位记录为 ${formatTime(playhead)} 处的运镜关键帧`
      : "锁定物体的相机（targetMode=object）不支持运镜关键帧"
    : selectedObject
      ? `把「${selectedObject.name}」当前位置记录为 ${formatTime(playhead)} 处的关键帧`
      : "请先选择一个对象或相机";

  return (
    <section
      className="panel-card timeline-panel"
      aria-label="时间轴"
      style={{ height: timelineHeight }}
    >
      <div
        className={`timeline-resizer${isResizing ? " is-active" : ""}`}
        role="separator"
        aria-orientation="horizontal"
        aria-label="拖动调整时间轴高度"
        title="向上拖动增大时间轴高度"
        onPointerDown={handleResizeStart}
        onPointerMove={handleResizeMove}
        onPointerUp={handleResizeEnd}
        onPointerCancel={handleResizeEnd}
      />
      <div className="timeline-toolbar">
        <button type="button" onClick={togglePlaying}>
          {isPlaying ? "暂停" : "播放"}
        </button>
        <span className="timeline-time-readout">
          {formatTime(playhead)} / {formatTime(duration)}
        </span>
        <input
          type="range"
          min={0}
          max={duration}
          step={0.05}
          value={playhead}
          onChange={(event) => setPlayhead(Number(event.target.value))}
          aria-label="时间指针"
        />
        <label className="timeline-duration">
          时长
          <input
            type="number"
            min={0.1}
            step={0.5}
            value={duration}
            onChange={(event) => setTimelineDuration(Number(event.target.value))}
          />
        </label>
        <button type="button" disabled={addKeyframeDisabled} onClick={handleAddKeyframe} title={addKeyframeTitle}>
          在指针处打关键帧
        </button>
        {selectedKeyframe ? (
          <>
            <button type="button" onClick={handleUpdateSelected}>更新选中关键帧</button>
            <button type="button" onClick={handleDeleteSelected}>删除选中关键帧</button>
          </>
        ) : null}
        {timeline.tracks.length > 0 || timeline.cameraTracks.length > 0 ? (
          <button type="button" className="timeline-clear-all" onClick={handleClearAll}>
            清空全部
          </button>
        ) : null}
        <div className="timeline-export-row">
          <button
            type="button"
            className="timeline-export-video"
            disabled={isRecording}
            onClick={() => void handleExportVideo("director")}
            title="从导演视角逐帧快速导出整段动画为 MP4 视频"
          >
            {isRecording ? "导出中…" : "导出视频·上帝视角"}
          </button>
          <button
            type="button"
            className="timeline-export-video"
            disabled={isRecording}
            onClick={() => void handleExportVideo("camera")}
            title="从当前选中相机的运镜画面逐帧快速导出为 MP4 视频"
          >
            {isRecording ? "录制中…" : "导出视频·机位视角"}
          </button>
        </div>
      </div>

      <div className="timeline-tracks">
        {timeline.tracks.length === 0 && timeline.cameraTracks.length === 0 ? (
          <p className="timeline-empty">还没有关键帧。选中对象或相机，摆好状态后点「在指针处打关键帧」。</p>
        ) : null}

        {timeline.tracks.map((track) => {
          const obj = project.objects.find((o) => o.id === track.objectId);
          return (
            <div className="timeline-track" key={track.objectId}>
              <span className="timeline-track-label">{obj?.name ?? track.objectId}</span>
              <div className="timeline-track-lane">
                {track.keyframes.map((kf) => {
                  const leftPercent = duration === 0 ? 0 : (kf.time / duration) * 100;
                  const isSelected =
                    selectedKeyframe?.kind === "object" &&
                    selectedKeyframe.targetId === track.objectId &&
                    selectedKeyframe.keyframeId === kf.id;
                  return (
                    <div
                      key={kf.id}
                      className={`timeline-keyframe${isSelected ? " is-selected" : ""}`}
                      style={{ left: `${leftPercent}%` }}
                      role="button"
                      tabIndex={0}
                      aria-label={`关键帧 ${formatTime(kf.time)}`}
                      onClick={() => handleSelectObjectKeyframe(track.objectId, kf.id, kf.time, kf.value)}
                    >
                      <button
                        type="button"
                        className="timeline-keyframe-delete"
                        aria-label={`删除关键帧 ${formatTime(kf.time)}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeKeyframe(track.objectId, kf.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        {timeline.cameraTracks.map((track) => {
          const shot = project.cameras.find((c) => c.id === track.cameraId);
          return (
            <div className="timeline-track timeline-track-camera" key={track.cameraId}>
              <span className="timeline-track-label">📷 {shot?.name ?? track.cameraId}</span>
              <div className="timeline-track-lane">
                {track.keyframes.map((kf) => {
                  const leftPercent = duration === 0 ? 0 : (kf.time / duration) * 100;
                  const isSelected =
                    selectedKeyframe?.kind === "camera" &&
                    selectedKeyframe.targetId === track.cameraId &&
                    selectedKeyframe.keyframeId === kf.id;
                  return (
                    <div
                      key={kf.id}
                      className={`timeline-keyframe timeline-keyframe-camera${isSelected ? " is-selected" : ""}`}
                      style={{ left: `${leftPercent}%` }}
                      role="button"
                      tabIndex={0}
                      aria-label={`运镜关键帧 ${formatTime(kf.time)}`}
                      onClick={() => handleSelectCameraKeyframe(track.cameraId, kf.id, kf.time, kf.value)}
                    >
                      <button
                        type="button"
                        className="timeline-keyframe-delete"
                        aria-label={`删除运镜关键帧 ${formatTime(kf.time)}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          removeCameraKeyframe(track.cameraId, kf.id);
                        }}
                      >
                        ×
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
