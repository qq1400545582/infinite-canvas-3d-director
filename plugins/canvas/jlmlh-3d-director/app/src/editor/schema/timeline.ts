import { Euler, Quaternion } from "three";

export type TransformTuple = [number, number, number];

// ===== 物体关键帧 =====
export interface KeyframeTransformValue {
  position: TransformTuple;
  rotation: TransformTuple;
  scale: TransformTuple;
}
export interface TimelineKeyframe {
  id: string;
  time: number; // 秒，>= 0
  value: KeyframeTransformValue;
  easing?: "linear"; // 预留：MVP 只用线性插值，该字段当前不读取
}
export interface TimelineTrack {
  objectId: string; // 对应 DirectorObject.id
  keyframes: TimelineKeyframe[]; // 保持按 time 升序
}

// ===== 相机关键帧 =====
export interface CameraKeyframeValue {
  position: TransformTuple;
  target: TransformTuple;
  fov: number;
}
export interface CameraTimelineKeyframe {
  id: string;
  time: number;
  value: CameraKeyframeValue;
}
export interface CameraTimelineTrack {
  cameraId: string; // 对应 DirectorCameraShot.id
  keyframes: CameraTimelineKeyframe[];
}

export interface Timeline {
  duration: number; // 秒
  tracks: TimelineTrack[];
  cameraTracks: CameraTimelineTrack[];
}

export const DEFAULT_TIMELINE_DURATION = 5;
const KEYFRAME_TIME_TOLERANCE = 0.001;

export function createDefaultTimeline(): Timeline {
  return { duration: DEFAULT_TIMELINE_DURATION, tracks: [], cameraTracks: [] };
}

export function createKeyframeId(): string {
  return `kf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export function sortKeyframes<K extends { time: number }>(keyframes: K[]): K[] {
  return [...keyframes].sort((a, b) => a.time - b.time);
}

function clampTime(time: number, duration: number) {
  return Math.max(0, Math.min(time, duration));
}
function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}
function lerpTuple(a: TransformTuple, b: TransformTuple, t: number): TransformTuple {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

// ===== 共享求值（物体与相机同构） =====
interface TimedValue<V> {
  time: number;
  value: V;
}
function evaluateKeyframes<V>(
  keyframes: TimedValue<V>[],
  time: number,
  lerpFn: (a: V, b: V, t: number) => V
): V | null {
  if (keyframes.length === 0) return null;
  if (time <= keyframes[0].time) return keyframes[0].value;
  const last = keyframes[keyframes.length - 1];
  if (time >= last.time) return last.value;
  for (let i = 0; i < keyframes.length - 1; i += 1) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (time >= a.time && time <= b.time) {
      const span = b.time - a.time;
      const t = span === 0 ? 0 : (time - a.time) / span;
      return lerpFn(a.value, b.value, t);
    }
  }
  return last.value;
}

// ===== 物体插值 =====
const _qa = new Quaternion();
const _qb = new Quaternion();
const _qr = new Quaternion();
const _tmpEuler = new Euler();

function slerpRotation(a: TransformTuple, b: TransformTuple, t: number): TransformTuple {
  if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) return [a[0], a[1], a[2]];
  _qa.setFromEuler(_tmpEuler.set(a[0], a[1], a[2]));
  _qb.setFromEuler(_tmpEuler.set(b[0], b[1], b[2]));
  _qr.slerpQuaternions(_qa, _qb, t);
  _tmpEuler.setFromQuaternion(_qr);
  return [_tmpEuler.x, _tmpEuler.y, _tmpEuler.z];
}

function lerpTransformValue(a: KeyframeTransformValue, b: KeyframeTransformValue, t: number): KeyframeTransformValue {
  return {
    position: lerpTuple(a.position, b.position, t),
    rotation: slerpRotation(a.rotation, b.rotation, t),
    scale: lerpTuple(a.scale, b.scale, t),
  };
}
export function evaluateTrackAtTime(track: TimelineTrack, time: number): KeyframeTransformValue | null {
  return evaluateKeyframes(track.keyframes, time, lerpTransformValue);
}

// ===== 相机插值 =====
function lerpCameraValue(a: CameraKeyframeValue, b: CameraKeyframeValue, t: number): CameraKeyframeValue {
  return {
    position: lerpTuple(a.position, b.position, t),
    target: lerpTuple(a.target, b.target, t),
    fov: lerp(a.fov, b.fov, t),
  };
}
export function evaluateCameraTrackAtTime(track: CameraTimelineTrack, time: number): CameraKeyframeValue | null {
  return evaluateKeyframes(track.keyframes, time, lerpCameraValue);
}

// ===== 物体增删改 =====
export function upsertKeyframe(
  timeline: Timeline,
  objectId: string,
  time: number,
  value: KeyframeTransformValue,
  keyframeId: string = createKeyframeId()
): Timeline {
  const safeTime = clampTime(time, timeline.duration);
  let touchedExisting = false;
  const tracks = timeline.tracks.map((track) => {
    if (track.objectId !== objectId) return track;
    const idx = track.keyframes.findIndex((k) => Math.abs(k.time - safeTime) < KEYFRAME_TIME_TOLERANCE);
    if (idx >= 0) {
      touchedExisting = true;
      return { ...track, keyframes: track.keyframes.map((k, i) => (i === idx ? { ...k, value } : k)) };
    }
    return { ...track, keyframes: sortKeyframes([...track.keyframes, { id: keyframeId, time: safeTime, value }]) };
  });
  if (touchedExisting || tracks.some((t) => t.objectId === objectId)) return { ...timeline, tracks };
  return { ...timeline, tracks: [...timeline.tracks, { objectId, keyframes: [{ id: keyframeId, time: safeTime, value }] }] };
}

export function removeKeyframe(timeline: Timeline, objectId: string, keyframeId: string): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks
      .map((track) =>
        track.objectId === objectId
          ? { ...track, keyframes: track.keyframes.filter((k) => k.id !== keyframeId) }
          : track
      )
      .filter((track) => track.keyframes.length > 0),
  };
}

export function updateKeyframeTime(timeline: Timeline, objectId: string, keyframeId: string, time: number): Timeline {
  const safeTime = clampTime(time, timeline.duration);
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) => {
      if (track.objectId !== objectId) return track;
      return { ...track, keyframes: sortKeyframes(track.keyframes.map((k) => (k.id === keyframeId ? { ...k, time: safeTime } : k))) };
    }),
  };
}

export function updateKeyframeValue(timeline: Timeline, objectId: string, keyframeId: string, value: KeyframeTransformValue): Timeline {
  return {
    ...timeline,
    tracks: timeline.tracks.map((track) =>
      track.objectId === objectId
        ? { ...track, keyframes: track.keyframes.map((k) => (k.id === keyframeId ? { ...k, value } : k)) }
        : track
    ),
  };
}

// ===== 相机增删改（与物体同构，操作 cameraTracks） =====
export function upsertCameraKeyframe(
  timeline: Timeline,
  cameraId: string,
  time: number,
  value: CameraKeyframeValue,
  keyframeId: string = createKeyframeId()
): Timeline {
  const safeTime = clampTime(time, timeline.duration);
  let touchedExisting = false;
  const cameraTracks = timeline.cameraTracks.map((track) => {
    if (track.cameraId !== cameraId) return track;
    const idx = track.keyframes.findIndex((k) => Math.abs(k.time - safeTime) < KEYFRAME_TIME_TOLERANCE);
    if (idx >= 0) {
      touchedExisting = true;
      return { ...track, keyframes: track.keyframes.map((k, i) => (i === idx ? { ...k, value } : k)) };
    }
    return { ...track, keyframes: sortKeyframes([...track.keyframes, { id: keyframeId, time: safeTime, value }]) };
  });
  if (touchedExisting || cameraTracks.some((t) => t.cameraId === cameraId)) return { ...timeline, cameraTracks };
  return { ...timeline, cameraTracks: [...timeline.cameraTracks, { cameraId, keyframes: [{ id: keyframeId, time: safeTime, value }] }] };
}

export function removeCameraKeyframe(timeline: Timeline, cameraId: string, keyframeId: string): Timeline {
  return {
    ...timeline,
    cameraTracks: timeline.cameraTracks
      .map((track) =>
        track.cameraId === cameraId
          ? { ...track, keyframes: track.keyframes.filter((k) => k.id !== keyframeId) }
          : track
      )
      .filter((track) => track.keyframes.length > 0),
  };
}

export function updateCameraKeyframeTime(timeline: Timeline, cameraId: string, keyframeId: string, time: number): Timeline {
  const safeTime = clampTime(time, timeline.duration);
  return {
    ...timeline,
    cameraTracks: timeline.cameraTracks.map((track) => {
      if (track.cameraId !== cameraId) return track;
      return { ...track, keyframes: sortKeyframes(track.keyframes.map((k) => (k.id === keyframeId ? { ...k, time: safeTime } : k))) };
    }),
  };
}

export function updateCameraKeyframeValue(timeline: Timeline, cameraId: string, keyframeId: string, value: CameraKeyframeValue): Timeline {
  return {
    ...timeline,
    cameraTracks: timeline.cameraTracks.map((track) =>
      track.cameraId === cameraId
        ? { ...track, keyframes: track.keyframes.map((k) => (k.id === keyframeId ? { ...k, value } : k)) }
        : track
    ),
  };
}
