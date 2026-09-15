# 关键帧动画（物体移动 + 镜头运镜）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 3D 导演台增加关键帧动画能力——物体（人物/道具）的位移·旋转·缩放、以及相机的运镜（position + target + fov），都能在时间轴上打关键帧、线性插值，并在视口实时预览回放。

**Architecture:** 时间轴是工程数据的一部分（写进 `DirectorProject.timeline`，走现有的 undo / localStorage 持久化 / JSON 导入导出，白嫖）。它含两类轨道：`tracks`（物体，按 `DirectorObject.id`）和 `cameraTracks`（相机，按 `DirectorCameraShot.id`）。回放是**派生态**——独立的 `playbackStore` 存播放状态，`useFrame` 每帧把插值结果直接写到 Three.js 对象（物体写 `groupRef`，相机写导演视图线框 + 机位视图渲染相机），**不写主 store**（避免撑爆 undo 栈和持久化）。所有时间轴数据操作是纯函数，集中在 `timeline.ts`，便于 TDD。

**Tech Stack:** TypeScript、React 18、Zustand 5、@react-three/fiber 8（`useFrame`）、Three.js 0.184、Vitest 4。

> ⚠️ **执行约定（用户指定）：本阶段不使用 git。** 计划里每个 Task 末尾的 `git add / git commit` 步骤**一律跳过**，仅执行"写代码 → 跑测试 → 构建"的部分。阶段产出直接落在工作区即可，不做版本管理。

---

## 范围

**做：**
- 物体的 `position / rotation / scale` 关键帧，**线性插值**
- 相机运镜关键帧：`position`（机位）+ `target`（看向的点）+ `fov`（变焦），线性插值
- 运镜预览**两种形态都做**：① 导演视图里相机线框移动；② 机位视图里真正进入相机画面看运镜
- 时间轴 UI：播放/暂停、时间指针拖动、时长调整、打关键帧、选中/删除/更新关键帧（物体 + 相机）
- 视口实时预览回放（`useFrame` 驱动）
- 工程 JSON / localStorage 自动带上 timeline（复用现有机制）

**不做（明确排除）：**
- ❌ 角色姿势（pose / 骨骼 controls）动画——人物只作为整体移动
- ❌ 视频导出（MediaRecorder / WebCodecs）
- ❌ 缓动曲线编辑器（只线性；数据结构里物体关键帧预留 `easing` 字段但不读取）
- ❌ 四元数球面插值（物体旋转用欧拉线性插值，MVP 够用）
- ❌ `targetMode === "object"`（锁定物体的相机）的运镜——这类相机 target 跟物体走，与运镜插值冲突，UI 层**只允许 `manual` 相机打运镜关键帧**

---

## File Structure

### 新增文件

| 文件 | 职责 |
|------|------|
| `src/editor/schema/timeline.ts` | 时间轴数据类型 + 所有纯函数（物体/相机插值、增删改查、排序、id、默认值）。**承载全部时间轴逻辑，DRY 核心** |
| `src/editor/schema/timeline.test.ts` | 纯函数单测（物体 + 相机） |
| `src/editor/runtime/playbackStore.ts` | 播放状态 zustand store（`isPlaying / playhead / duration / advance`） |
| `src/editor/runtime/playbackStore.test.ts` | store 状态机单测 |
| `src/editor/runtime/PlaybackFrameDriver.tsx` | R3F 组件：`useFrame` 推进 playhead + 把 timeline.duration 同步到 playbackStore |
| `src/editor/runtime/ActiveCameraPlaybackSync.tsx` | R3F 组件：机位视图下，`useFrame` 用相机轨道插值覆盖渲染相机的 position/lookAt/fov |
| `src/editor/panels/TimelinePanel.tsx` | 时间轴 UI（播放控制 + 物体/相机关键帧编辑） |
| `src/editor/panels/TimelinePanel.test.tsx` | UI 组件测试 |

### 修改文件

| 文件 | 改什么 |
|------|--------|
| `src/editor/schema/directorProject.ts` | `DirectorProject` 加 `timeline` 字段；`version: 1` → `2` |
| `src/editor/store/directorStore.ts` | `migrateDirectorProject` 补 v1→v2 迁移；`createDefaultDirectorProject` 带默认 timeline；`isDirectorProjectShape` 兼容 v1/v2；`replaceProject` 走 migrate；新增 5 个物体 + 5 个相机 timeline actions |
| `src/editor/store/directorStore.test.ts` | 补 timeline actions + migration 断言 |
| `src/editor/canvas/SceneRoot.tsx` | `ObjectSceneNode` 用 `useFrame` 覆盖物体 transform；`ViewportCameraRig` 用 `useFrame` 覆盖相机线框（导演视图运镜预览①）；播放时禁用物体 TransformControls |
| `src/editor/canvas/DirectorCanvas.tsx` | 挂载 `<PlaybackFrameDriver />` 和 `<ActiveCameraPlaybackSync />`（机位视图运镜预览②） |
| `src/app/layout/DirectorDeskShell.tsx` | 视口列底部挂 `<TimelinePanel />` |

---

## Task 1: 时间轴数据模型 + 纯函数（物体 + 相机）

**Files:**
- Create: `src/editor/schema/timeline.ts`
- Test: `src/editor/schema/timeline.test.ts`

- [ ] **Step 1: 写失败测试 `timeline.test.ts`**

```ts
import {
  DEFAULT_TIMELINE_DURATION,
  createDefaultTimeline,
  evaluateTrackAtTime,
  evaluateCameraTrackAtTime,
  sortKeyframes,
  upsertKeyframe,
  removeKeyframe,
  updateKeyframeTime,
  updateKeyframeValue,
  upsertCameraKeyframe,
  removeCameraKeyframe,
  updateCameraKeyframeTime,
  updateCameraKeyframeValue,
} from "./timeline";

const V0 = { position: [0, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
const V1 = { position: [10, 0, 0] as [number, number, number], rotation: [0, 0, 0] as [number, number, number], scale: [1, 1, 1] as [number, number, number] };
const CAM_A = { position: [0, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 50 };
const CAM_B = { position: [10, 0, 0] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 70 };

it("creates a default empty timeline with both track kinds", () => {
  expect(createDefaultTimeline()).toEqual({ duration: DEFAULT_TIMELINE_DURATION, tracks: [], cameraTracks: [] });
});

// ---------- 物体插值 ----------
it("clamps before the first object keyframe to the first value", () => {
  const track = { objectId: "a", keyframes: [{ id: "k1", time: 1, value: V1 }] };
  expect(evaluateTrackAtTime(track, 0)).toEqual(V1);
});

it("lerps an object linearly between two keyframes", () => {
  const track = { objectId: "a", keyframes: [{ id: "k1", time: 0, value: V0 }, { id: "k2", time: 2, value: V1 }] };
  expect(evaluateTrackAtTime(track, 1)).toEqual({ position: [5, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] });
});

it("clamps after the last object keyframe to the last value", () => {
  const track = { objectId: "a", keyframes: [{ id: "k1", time: 0, value: V0 }, { id: "k2", time: 2, value: V1 }] };
  expect(evaluateTrackAtTime(track, 10)).toEqual(V1);
});

it("returns null for an object track with no keyframes", () => {
  expect(evaluateTrackAtTime({ objectId: "a", keyframes: [] }, 1)).toBeNull();
});

// ---------- 相机插值 ----------
it("lerps camera position/target/fov linearly between two keyframes", () => {
  const track = { cameraId: "cam_1", keyframes: [{ id: "k1", time: 0, value: CAM_A }, { id: "k2", time: 2, value: CAM_B }] };
  expect(evaluateCameraTrackAtTime(track, 1)).toEqual({ position: [5, 0, 0], target: [0, 0, 0], fov: 60 });
});

it("returns null for a camera track with no keyframes", () => {
  expect(evaluateCameraTrackAtTime({ cameraId: "cam_1", keyframes: [] }, 1)).toBeNull();
});

// ---------- 排序 ----------
it("sorts keyframes by time", () => {
  const sorted = sortKeyframes([{ id: "k2", time: 2, value: V1 }, { id: "k1", time: 0, value: V0 }]);
  expect(sorted.map((k) => k.id)).toEqual(["k1", "k2"]);
});

// ---------- 物体增删改 ----------
it("upserts an object keyframe into a new track", () => {
  const next = upsertKeyframe(createDefaultTimeline(), "obj_1", 1, V0, "kf_1");
  expect(next.tracks).toEqual([{ objectId: "obj_1", keyframes: [{ id: "kf_1", time: 1, value: V0 }] }]);
});

it("upserts by replacing an object keyframe at the same time (within tolerance)", () => {
  let timeline = upsertKeyframe(createDefaultTimeline(), "obj_1", 1, V0, "kf_1");
  timeline = upsertKeyframe(timeline, "obj_1", 1.0005, V1, "kf_2");
  expect(timeline.tracks[0].keyframes).toHaveLength(1);
  expect(timeline.tracks[0].keyframes[0].value).toEqual(V1);
});

it("clamps object keyframe time to [0, duration] on upsert", () => {
  const timeline = upsertKeyframe(createDefaultTimeline(), "obj_1", 999, V0, "kf_1");
  expect(timeline.tracks[0].keyframes[0].time).toBe(DEFAULT_TIMELINE_DURATION);
});

it("removes an object keyframe and drops the empty track", () => {
  let timeline = upsertKeyframe(createDefaultTimeline(), "obj_1", 1, V0, "kf_1");
  timeline = removeKeyframe(timeline, "obj_1", "kf_1");
  expect(timeline.tracks).toEqual([]);
});

it("updates an object keyframe time and re-sorts", () => {
  let timeline = upsertKeyframe(createDefaultTimeline(), "obj_1", 1, V0, "kf_1");
  timeline = upsertKeyframe(timeline, "obj_1", 2, V1, "kf_2");
  timeline = updateKeyframeTime(timeline, "obj_1", "kf_2", 0.5);
  expect(timeline.tracks[0].keyframes.map((k) => k.id)).toEqual(["kf_2", "kf_1"]);
});

it("updates an object keyframe value without changing time", () => {
  let timeline = upsertKeyframe(createDefaultTimeline(), "obj_1", 1, V0, "kf_1");
  timeline = updateKeyframeValue(timeline, "obj_1", "kf_1", V1);
  expect(timeline.tracks[0].keyframes[0].value).toEqual(V1);
  expect(timeline.tracks[0].keyframes[0].time).toBe(1);
});

// ---------- 相机增删改 ----------
it("upserts a camera keyframe into a new camera track", () => {
  const next = upsertCameraKeyframe(createDefaultTimeline(), "cam_1", 1, CAM_A, "ckf_1");
  expect(next.cameraTracks).toEqual([{ cameraId: "cam_1", keyframes: [{ id: "ckf_1", time: 1, value: CAM_A }] }]);
});

it("removes a camera keyframe and drops the empty camera track", () => {
  let timeline = upsertCameraKeyframe(createDefaultTimeline(), "cam_1", 1, CAM_A, "ckf_1");
  timeline = removeCameraKeyframe(timeline, "cam_1", "ckf_1");
  expect(timeline.cameraTracks).toEqual([]);
});

it("updates a camera keyframe fov via updateCameraKeyframeValue", () => {
  let timeline = upsertCameraKeyframe(createDefaultTimeline(), "cam_1", 1, CAM_A, "ckf_1");
  timeline = updateCameraKeyframeValue(timeline, "cam_1", "ckf_1", { ...CAM_A, fov: 80 });
  expect(timeline.cameraTracks[0].keyframes[0].value.fov).toBe(80);
});

it("clamps a camera keyframe time to duration", () => {
  const timeline = upsertCameraKeyframe(createDefaultTimeline(), "cam_1", 999, CAM_A, "ckf_1");
  expect(timeline.cameraTracks[0].keyframes[0].time).toBe(DEFAULT_TIMELINE_DURATION);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/editor/schema/timeline.test.ts`
Expected: FAIL，报错找不到 `./timeline` 模块。

- [ ] **Step 3: 写实现 `timeline.ts`**

```ts
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
function lerpTransformValue(a: KeyframeTransformValue, b: KeyframeTransformValue, t: number): KeyframeTransformValue {
  return {
    position: lerpTuple(a.position, b.position, t),
    rotation: lerpTuple(a.rotation, b.rotation, t),
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/editor/schema/timeline.test.ts`
Expected: PASS（全部用例）。

- [ ] **Step 5: 提交（按约定跳过 git）**

```bash
git add src/editor/schema/timeline.ts src/editor/schema/timeline.test.ts
git commit -m "feat(timeline): add timeline schema with object and camera tracks"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 2: DirectorProject schema 升级 + migration

**Files:**
- Modify: `src/editor/schema/directorProject.ts`
- Modify: `src/editor/store/directorStore.ts`（migration + 默认值 + shape 校验 + replaceProject 走 migrate）
- Test: `src/editor/store/directorStore.test.ts`

- [ ] **Step 1: 改 `directorProject.ts`——加 timeline 字段、version 升 2**

在文件顶部 import 区加：
```ts
import type { Timeline } from "./timeline";
```

把 `DirectorProject` 改成：
```ts
export interface DirectorProject {
  version: 2;
  scene: SceneSettings;
  assets: DirectorAssetRef[];
  objects: DirectorObject[];
  cameras: DirectorCameraShot[];
  activeCameraId: string | null;
  panoramaAssetId: string | null;
  timeline: Timeline;
}
```

- [ ] **Step 2: 改 `directorStore.ts`——import + 默认 timeline + migration + shape 校验**

顶部 import 替换/扩充为：
```ts
import {
  createDefaultTimeline,
  upsertKeyframe,
  removeKeyframe as removeTimelineKeyframe,
  updateKeyframeTime as updateTimelineKeyframeTime,
  updateKeyframeValue as updateTimelineKeyframeValue,
  upsertCameraKeyframe,
  removeCameraKeyframe as removeTimelineCameraKeyframe,
  updateCameraKeyframeTime as updateTimelineCameraKeyframeTime,
  updateCameraKeyframeValue as updateTimelineCameraKeyframeValue,
  createKeyframeId,
  type KeyframeTransformValue,
  type CameraKeyframeValue,
  type Timeline,
} from "../schema/timeline";
```

在 `migrateDirectorProject` 之前加辅助：
```ts
function withTimeline(project: DirectorProject): DirectorProject {
  const timeline = project.timeline ?? createDefaultTimeline();
  return {
    ...project,
    version: 2,
    timeline: {
      duration: timeline.duration,
      tracks: timeline.tracks ?? [],
      cameraTracks: timeline.cameraTracks ?? [],
    },
  };
}
```

把 `migrateDirectorProject` 改为先补 timeline 再做 ue4 迁移：
```ts
function migrateDirectorProject(project: DirectorProject): DirectorProject {
  const withTimelineProject = withTimeline(project);
  return {
    ...withTimelineProject,
    objects: withTimelineProject.objects.map((object) => {
      if (object.kind !== "character") return object;

      const rig = object.characterRig;
      if (rig?.rigType === "ue4-mannequin") return object;

      return {
        ...object,
        characterRig: {
          rigType: "ue4-mannequin",
          posePresetId: rig?.posePresetId ?? "stand",
          controls: rig?.controls ?? {},
        },
      };
    }),
  };
}
```

把 `isDirectorProjectShape` 改成兼容 v1/v2：
```ts
function isDirectorProjectShape(value: unknown): value is DirectorProject {
  if (!value || typeof value !== "object") return false;

  const project = value as Partial<DirectorProject>;
  return (
    (project.version === 1 || project.version === 2) &&
    Array.isArray(project.assets) &&
    Array.isArray(project.objects) &&
    Array.isArray(project.cameras) &&
    Boolean(project.scene) &&
    typeof project.scene?.backgroundColor === "string"
  );
}
```

把 `createDefaultDirectorProject` 的返回对象加上 `version: 2` 和 `timeline: createDefaultTimeline()`：
```ts
  return {
    version: 2,
    scene: DEFAULT_SCENE,
    assets: includePersistedLocalAssets ? readPersistedLocalModelAssets() : [],
    objects: [role, cameraObject],
    cameras: [camera],
    activeCameraId: camera.id,
    panoramaAssetId: null,
    timeline: createDefaultTimeline(),
  };
```

- [ ] **Step 3: 让 `replaceProject` 走 migrate（v1 旧工程导入也能补齐 timeline）**

把 `replaceProject` 改为：
```ts
    replaceProject: (project) =>
      commitMutation((state) => {
        const incoming = cloneJsonValue(project);
        const migrated = migrateDirectorProject(
          isDirectorProjectShape(incoming) ? incoming : createDefaultDirectorProject()
        );
        return {
          ...state,
          project: migrated,
          selectedObjectId: null,
          selectedObjectIds: [],
          selectedCrowdId: null,
          directorInspectorMode: "auto",
        };
      }),
```

- [ ] **Step 4: 写 migration 测试**

在 `src/editor/store/directorStore.test.ts` 追加（`useDirectorStore`、`createDefaultDirectorProject` 需要 import）：
```ts
it("createDefaultDirectorProject ships a default timeline and version 2", () => {
  const project = createDefaultDirectorProject();
  expect(project.version).toBe(2);
  expect(project.timeline).toEqual({ duration: 5, tracks: [], cameraTracks: [] });
});

it("replaceProject migrates a legacy v1 project into a v2 project with a timeline", () => {
  const legacyV1 = {
    version: 1,
    scene: { scale: 1, position: [0, 0, 0], rotation: [0, 0, 0], backgroundColor: "#000000", panoramaYaw: 0, panoramaRadius: 60, showLabels: true, snapToGrid: false, showGround: true, groundOpacity: 0.4, groundHeight: 0 },
    assets: [],
    objects: [],
    cameras: [],
    activeCameraId: null,
    panoramaAssetId: null,
  };

  useDirectorStore.getState().replaceProject(legacyV1 as never);

  const project = useDirectorStore.getState().project;
  expect(project.version).toBe(2);
  expect(project.timeline).toEqual({ duration: 5, tracks: [], cameraTracks: [] });
});
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- src/editor/store/directorStore.test.ts`
Expected: PASS（含新增 migration 用例 + 既有用例不被破坏）。

- [ ] **Step 6: 提交（按约定跳过 git）**

```bash
git add src/editor/schema/directorProject.ts src/editor/store/directorStore.ts src/editor/store/directorStore.test.ts
git commit -m "feat(timeline): add timeline field to DirectorProject with v1->v2 migration"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 3: directorStore 时间轴 actions（物体 + 相机）

**Files:**
- Modify: `src/editor/store/directorStore.ts`
- Test: `src/editor/store/directorStore.test.ts`

- [ ] **Step 1: 在 `DirectorActions` 接口加 action 签名**

在 `DirectorActions` 接口里（`updateCamera` 之后、`beginUndoBatch` 之前）加：
```ts
  // 物体关键帧
  addKeyframe: (objectId: string, time: number, value: KeyframeTransformValue) => string;
  removeKeyframe: (objectId: string, keyframeId: string) => void;
  updateKeyframeTime: (objectId: string, keyframeId: string, time: number) => void;
  updateKeyframeValue: (objectId: string, keyframeId: string, value: KeyframeTransformValue) => void;
  applyKeyframeToObjectTransform: (objectId: string, value: KeyframeTransformValue) => void;
  // 相机运镜关键帧
  addCameraKeyframe: (cameraId: string, time: number, value: CameraKeyframeValue) => string;
  removeCameraKeyframe: (cameraId: string, keyframeId: string) => void;
  updateCameraKeyframeTime: (cameraId: string, keyframeId: string, time: number) => void;
  updateCameraKeyframeValue: (cameraId: string, keyframeId: string, value: CameraKeyframeValue) => void;
  applyCameraKeyframeToShot: (cameraId: string, value: CameraKeyframeValue) => void;
  // 时长
  setTimelineDuration: (seconds: number) => void;
```
> `KeyframeTransformValue` / `CameraKeyframeValue` 已在 Task 2 的顶部 import 中引入。

- [ ] **Step 2: 写失败测试**

在 `directorStore.test.ts` 追加：
```ts
it("addKeyframe inserts a keyframe on the object's track and returns its id", () => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  const objectId = useDirectorStore.getState().project.objects[0].id;

  const kfId = useDirectorStore.getState().addKeyframe(objectId, 1, {
    position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1],
  });

  expect(typeof kfId).toBe("string");
  const track = useDirectorStore.getState().project.timeline.tracks.find((t) => t.objectId === objectId);
  expect(track?.keyframes).toHaveLength(1);
  expect(track?.keyframes[0].id).toBe(kfId);
});

it("applyKeyframeToObjectTransform writes the keyframe value onto the object transform", () => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  const objectId = useDirectorStore.getState().project.objects[0].id;

  useDirectorStore.getState().applyKeyframeToObjectTransform(objectId, {
    position: [5, 6, 7], rotation: [0.1, 0.2, 0.3], scale: [2, 2, 2],
  });

  const obj = useDirectorStore.getState().project.objects.find((o) => o.id === objectId);
  expect(obj?.transform.position).toEqual([5, 6, 7]);
  expect(obj?.transform.scale).toEqual([2, 2, 2]);
});

it("addCameraKeyframe inserts a keyframe on the camera's track", () => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  const cameraId = useDirectorStore.getState().project.cameras[0].id;

  const kfId = useDirectorStore.getState().addCameraKeyframe(cameraId, 1, {
    position: [3, 3, 3], target: [0, 1, 0], fov: 40,
  });

  expect(typeof kfId).toBe("string");
  const track = useDirectorStore.getState().project.timeline.cameraTracks.find((t) => t.cameraId === cameraId);
  expect(track?.keyframes).toHaveLength(1);
  expect(track?.keyframes[0].value.fov).toBe(40);
});

it("applyCameraKeyframeToShot writes position/target/fov onto the camera shot", () => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  const cameraId = useDirectorStore.getState().project.cameras[0].id;

  useDirectorStore.getState().applyCameraKeyframeToShot(cameraId, {
    position: [8, 2, 9], target: [1, 1, 1], fov: 33,
  });

  const shot = useDirectorStore.getState().project.cameras.find((c) => c.id === cameraId);
  expect(shot?.transform.position).toEqual([8, 2, 9]);
  expect(shot?.target).toEqual([1, 1, 1]);
  expect(shot?.fov).toBe(33);
});

it("removeCameraKeyframe drops the empty camera track", () => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  const cameraId = useDirectorStore.getState().project.cameras[0].id;
  const kfId = useDirectorStore.getState().addCameraKeyframe(cameraId, 1, {
    position: [0, 0, 0], target: [0, 0, 0], fov: 50,
  });

  useDirectorStore.getState().removeCameraKeyframe(cameraId, kfId);

  expect(useDirectorStore.getState().project.timeline.cameraTracks).toEqual([]);
});

it("setTimelineDuration updates the timeline duration", () => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  useDirectorStore.getState().setTimelineDuration(12);
  expect(useDirectorStore.getState().project.timeline.duration).toBe(12);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npm test -- src/editor/store/directorStore.test.ts`
Expected: FAIL（actions 未定义）。

- [ ] **Step 4: 实现 actions**

在 store 返回对象里（建议放在 `updateCamera` 之后）加：
```ts
    addKeyframe: (objectId, time, value) => {
      const keyframeId = createKeyframeId();
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: upsertKeyframe(state.project.timeline, objectId, time, value, keyframeId),
        },
      }));
      return keyframeId;
    },
    removeKeyframe: (objectId, keyframeId) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: removeTimelineKeyframe(state.project.timeline, objectId, keyframeId),
        },
      })),
    updateKeyframeTime: (objectId, keyframeId, time) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: updateTimelineKeyframeTime(state.project.timeline, objectId, keyframeId, time),
        },
      })),
    updateKeyframeValue: (objectId, keyframeId, value) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: updateTimelineKeyframeValue(state.project.timeline, objectId, keyframeId, value),
        },
      })),
    applyKeyframeToObjectTransform: (objectId, value) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          objects: updateObjectById(state.project.objects, objectId, (item) => ({
            ...item,
            transform: { position: value.position, rotation: value.rotation, scale: value.scale },
          })),
        },
      })),
    addCameraKeyframe: (cameraId, time, value) => {
      const keyframeId = createKeyframeId();
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: upsertCameraKeyframe(state.project.timeline, cameraId, time, value, keyframeId),
        },
      }));
      return keyframeId;
    },
    removeCameraKeyframe: (cameraId, keyframeId) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: removeTimelineCameraKeyframe(state.project.timeline, cameraId, keyframeId),
        },
      })),
    updateCameraKeyframeTime: (cameraId, keyframeId, time) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: updateTimelineCameraKeyframeTime(state.project.timeline, cameraId, keyframeId, time),
        },
      })),
    updateCameraKeyframeValue: (cameraId, keyframeId, value) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: updateTimelineCameraKeyframeValue(state.project.timeline, cameraId, keyframeId, value),
        },
      })),
    applyCameraKeyframeToShot: (cameraId, value) => {
      // 只改 position/target/fov，rotation/scale 保留 shot 原值（相机朝向由 target 决定）
      const camera = get().project.cameras.find((item) => item.id === cameraId);
      if (!camera) return;
      get().updateCamera(cameraId, {
        fov: value.fov,
        target: value.target,
        transform: { ...camera.transform, position: value.position },
      });
    },
    setTimelineDuration: (seconds) =>
      commitMutation((state) => ({
        ...state,
        project: {
          ...state.project,
          timeline: { ...state.project.timeline, duration: Math.max(0.1, seconds) },
        },
      })),
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- src/editor/store/directorStore.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交（按约定跳过 git）**

```bash
git add src/editor/store/directorStore.ts src/editor/store/directorStore.test.ts
git commit -m "feat(timeline): add object and camera keyframe actions to director store"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 4: playbackStore（播放状态）

**Files:**
- Create: `src/editor/runtime/playbackStore.ts`
- Test: `src/editor/runtime/playbackStore.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { usePlaybackStore } from "./playbackStore";

beforeEach(() => {
  usePlaybackStore.setState({ isPlaying: false, playhead: 0, duration: 5 });
});

it("togglePlaying flips isPlaying", () => {
  usePlaybackStore.getState().togglePlaying();
  expect(usePlaybackStore.getState().isPlaying).toBe(true);
});

it("setPlayhead clamps to [0, duration]", () => {
  usePlaybackStore.getState().setPlayhead(3);
  expect(usePlaybackStore.getState().playhead).toBe(3);
  usePlaybackStore.getState().setPlayhead(-1);
  expect(usePlaybackStore.getState().playhead).toBe(0);
  usePlaybackStore.getState().setPlayhead(99);
  expect(usePlaybackStore.getState().playhead).toBe(5);
});

it("advance does nothing when not playing", () => {
  usePlaybackStore.getState().advance(0.5);
  expect(usePlaybackStore.getState().playhead).toBe(0);
});

it("advance moves playhead forward and loops back to 0 at the end", () => {
  usePlaybackStore.getState().setPlaying(true);
  usePlaybackStore.getState().setPlayhead(4.8);
  usePlaybackStore.getState().advance(0.5);
  expect(usePlaybackStore.getState().playhead).toBe(0);
});

it("setDuration keeps a positive minimum", () => {
  usePlaybackStore.getState().setDuration(0);
  expect(usePlaybackStore.getState().duration).toBeGreaterThanOrEqual(0.1);
});
```

> 参考仓库现有 `.test.ts` 风格：不显式 import vitest 的 globals。若 `beforeEach` 报未定义，再加 `import { beforeEach, it, expect } from "vitest";`。

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/editor/runtime/playbackStore.test.ts`
Expected: FAIL（找不到模块）。

- [ ] **Step 3: 写实现**

```ts
import { create } from "zustand";
import { DEFAULT_TIMELINE_DURATION } from "../schema/timeline";

export interface PlaybackState {
  isPlaying: boolean;
  playhead: number; // 秒
  duration: number; // 秒，与 timeline.duration 保持同步
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setPlayhead: (time: number) => void;
  setDuration: (duration: number) => void;
  /** 供 useFrame 调用：推进 playhead，到末尾循环回 0；非播放态为空操作 */
  advance: (deltaSeconds: number) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  isPlaying: false,
  playhead: 0,
  duration: DEFAULT_TIMELINE_DURATION,
  setPlaying: (isPlaying) => set({ isPlaying }),
  togglePlaying: () => set((state) => ({ isPlaying: !state.isPlaying })),
  setPlayhead: (playhead) =>
    set((state) => ({ playhead: clamp(playhead, 0, state.duration) })),
  setDuration: (duration) => set({ duration: Math.max(0.1, duration) }),
  advance: (deltaSeconds) => {
    if (!get().isPlaying) return;
    set((state) => {
      const next = state.playhead + deltaSeconds;
      return { playhead: next >= state.duration ? 0 : next };
    });
  },
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- src/editor/runtime/playbackStore.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交（按约定跳过 git）**

```bash
git add src/editor/runtime/playbackStore.ts src/editor/runtime/playbackStore.test.ts
git commit -m "feat(timeline): add playback store for playhead and play state"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 5: 回放驱动 + 物体接入

> 核心逻辑（`evaluateTrackAtTime`）已在 Task 1 被单测覆盖。`useFrame` 集成在 R3F canvas 内运行、难以单测，本 task 不写组件单测，改在 Task 8 手测验证。

**Files:**
- Create: `src/editor/runtime/PlaybackFrameDriver.tsx`
- Modify: `src/editor/canvas/SceneRoot.tsx`（仅物体部分；相机线框在 Task 6）
- Modify: `src/editor/canvas/DirectorCanvas.tsx`（挂载驱动器）

- [ ] **Step 1: 写 `PlaybackFrameDriver.tsx`**

```tsx
import { useFrame } from "@react-three/fiber";
import { useEffect } from "react";
import { useDirectorStore } from "../store/directorStore";
import { DEFAULT_TIMELINE_DURATION } from "../schema/timeline";
import { usePlaybackStore } from "./playbackStore";

/**
 * 挂在 R3F <Canvas> 内部：
 * 1. 每帧推进 playhead（delta 是秒，钳制最大步长防止切 tab 后大跳）
 * 2. 把 directorStore 的 timeline.duration 同步到 playbackStore
 */
export function PlaybackFrameDriver() {
  const advance = usePlaybackStore((state) => state.advance);
  const timelineDuration = useDirectorStore(
    (state) => state.project.timeline?.duration ?? DEFAULT_TIMELINE_DURATION
  );
  const setDuration = usePlaybackStore((state) => state.setDuration);

  useEffect(() => {
    setDuration(timelineDuration);
  }, [timelineDuration, setDuration]);

  useFrame((_, delta) => {
    advance(Math.min(delta, 0.1));
  });

  return null;
}
```

- [ ] **Step 2: 改 `SceneRoot.tsx`——`ObjectSceneNode` 接入回放覆盖**

在 `SceneRoot.tsx` 顶部 import 区加：
```tsx
import { useFrame } from "@react-three/fiber";
import { evaluateTrackAtTime } from "../schema/timeline";
import { usePlaybackStore } from "../runtime/playbackStore";
```

在 `ObjectSceneNode` 组件内（`const updateObjectTransform = ...` 这一行之后）加：
```tsx
  const timeline = useDirectorStore((state) => state.project.timeline);
  const playhead = usePlaybackStore((state) => state.playhead);
  const isPlaying = usePlaybackStore((state) => state.isPlaying);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const track = timeline.tracks.find((t) => t.objectId === item.id);
    if (!track || track.keyframes.length === 0) return;
    const value = evaluateTrackAtTime(track, playhead);
    if (!value) return;
    group.position.set(value.position[0], value.position[1], value.position[2]);
    group.rotation.set(value.rotation[0], value.rotation[1], value.rotation[2]);
    group.scale.set(value.scale[0], value.scale[1], value.scale[2]);
  });
```

> 说明：`timeline` / `playhead` 来自 store 订阅，但 playhead 变化**不会**触发 React 重渲染（SceneRoot 订阅的是 directorStore；playbackStore 的变化只被 `useFrame` 读取）。播放时无 React 重渲染开销，每帧直接改 `group`。

- [ ] **Step 3: 播放时禁用物体 TransformControls**

把 `ObjectSceneNode` 末尾的：
```tsx
  if (!selected || !transformable) return node;

  return (
    <>
      {node}
      <ViewportTransformControls ... />
    </>
  );
```
改为：
```tsx
  const showGizmo = selected && transformable && !isPlaying;

  if (!showGizmo) return node;

  return (
    <>
      {node}
      <ViewportTransformControls
        mode={transformMode}
        object={groupRef}
        onObjectChange={commitTransformFromViewport}
        translationSnap={transformMode === "translate" ? translationSnap : null}
      />
    </>
  );
```

- [ ] **Step 4: 改 `DirectorCanvas.tsx`——挂载驱动器**

在 `DirectorCanvas.tsx` 顶部 import：
```tsx
import { PlaybackFrameDriver } from "../runtime/PlaybackFrameDriver";
```

在 `<Canvas>` 内部、`<CanvasCaptureBridge ... />` 之后加：
```tsx
          <PlaybackFrameDriver />
```

- [ ] **Step 5: 构建 + 类型检查**

Run: `npm run build`
Expected: 构建通过（tsc -b 无类型错误，vite build 成功）。

- [ ] **Step 6: 提交（按约定跳过 git）**

```bash
git add src/editor/runtime/PlaybackFrameDriver.tsx src/editor/canvas/SceneRoot.tsx src/editor/canvas/DirectorCanvas.tsx
git commit -m "feat(timeline): drive playback via useFrame and override object transforms"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 6: 相机运镜回放接入（导演视图线框 + 机位视图画面）

> 两条预览路径都用 `useFrame` 直接写 Three.js 对象，不写 store。无组件单测，靠 Task 8 手测验证。

**Files:**
- Create: `src/editor/runtime/ActiveCameraPlaybackSync.tsx`
- Modify: `src/editor/canvas/SceneRoot.tsx`（`ViewportCameraRig` 加线框覆盖）
- Modify: `src/editor/canvas/DirectorCanvas.tsx`（挂载 `ActiveCameraPlaybackSync`）

- [ ] **Step 1: 写 `ActiveCameraPlaybackSync.tsx`（机位视图运镜预览②）**

```tsx
import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera as ThreePerspectiveCamera } from "three";
import { useDirectorStore } from "../store/directorStore";
import { evaluateCameraTrackAtTime } from "../schema/timeline";
import { usePlaybackStore } from "./playbackStore";

/**
 * 机位视图下：若当前激活相机有运镜轨道，每帧用插值结果覆盖渲染相机的
 * position / lookAt(target) / fov，呈现真正的运镜画面。
 * 挂在 <Canvas> 内；非机位视图或相机无轨道时为空操作。
 */
export function ActiveCameraPlaybackSync({ activeCameraId }: { activeCameraId: string | null }) {
  const camera = useThree((state) => state.camera);
  const cameraTracks = useDirectorStore((state) => state.project.timeline.cameraTracks);
  const playhead = usePlaybackStore((state) => state.playhead);

  useFrame(() => {
    if (!activeCameraId) return;
    const track = cameraTracks.find((item) => item.cameraId === activeCameraId);
    if (!track || track.keyframes.length === 0) return;
    const value = evaluateCameraTrackAtTime(track, playhead);
    if (!value) return;

    const perspectiveCamera = camera as ThreePerspectiveCamera;
    perspectiveCamera.position.set(value.position[0], value.position[1], value.position[2]);
    perspectiveCamera.lookAt(value.target[0], value.target[1], value.target[2]);
    if (Math.abs(perspectiveCamera.fov - value.fov) > 0.001) {
      perspectiveCamera.fov = value.fov;
      perspectiveCamera.updateProjectionMatrix();
    }
  });

  return null;
}
```

> 时序说明：机位视图下场景里**没有** OrbitControls（`DirectorCanvas` 里 OrbitControls 仅在 `viewMode === "director"` 挂载），渲染相机由 drei `<PerspectiveCamera makeDefault>` 初始化。播放期间 directorStore 不变、组件不重渲，因此 `useFrame` 的覆盖不会被 React props 反复打断。fov 改动时需手动 `updateProjectionMatrix()`。

- [ ] **Step 2: 改 `SceneRoot.tsx`——`ViewportCameraRig` 加线框覆盖（导演视图运镜预览①）**

在 `SceneRoot.tsx` 顶部 import 区补：
```tsx
import { evaluateCameraTrackAtTime } from "../schema/timeline";
```
（`useFrame`、`usePlaybackStore` 已在 Task 5 Step 2 引入；若 Task 5 还没执行，则一并引入。）

在 `ViewportCameraRig` 组件内（`const selectObject = ...`、`const updateCamera = ...` 之后）加：
```tsx
  const cameraTracks = useDirectorStore((state) => state.project.timeline.cameraTracks);
  const playhead = usePlaybackStore((state) => state.playhead);

  useFrame(() => {
    const group = groupRef.current;
    if (!group) return;
    const track = cameraTracks.find((item) => item.cameraId === camera.id);
    if (!track || track.keyframes.length === 0) return;
    const value = evaluateCameraTrackAtTime(track, playhead);
    if (!value) return;
    group.position.set(value.position[0], value.position[1], value.position[2]);
    group.quaternion.copy(getViewportCameraQuaternion(value.position, value.target));
  });
```

> 导演视图的相机线框朝向由 `getViewportCameraQuaternion(position, target)` 决定，所以用插值后的 position/target 重算 quaternion。fov 不影响线框外观，不处理。

- [ ] **Step 3: 改 `DirectorCanvas.tsx`——挂载 `ActiveCameraPlaybackSync`**

顶部 import：
```tsx
import { ActiveCameraPlaybackSync } from "../runtime/ActiveCameraPlaybackSync";
```

在 `<Canvas>` 内、`<PlaybackFrameDriver />` 旁边加（`activeCamera` 已在组件里取到）：
```tsx
          <ActiveCameraPlaybackSync activeCameraId={activeCamera?.id ?? null} />
```

- [ ] **Step 4: 构建 + 类型检查**

Run: `npm run build`
Expected: 通过。

- [ ] **Step 5: 提交（按约定跳过 git）**

```bash
git add src/editor/runtime/ActiveCameraPlaybackSync.tsx src/editor/canvas/SceneRoot.tsx src/editor/canvas/DirectorCanvas.tsx
git commit -m "feat(timeline): add camera dolly playback in director and camera views"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 7: TimelinePanel UI（物体 + 相机轨道）

> UI 先做**功能可用版**（原生控件为主）。视觉还原（配色/间距/字号）后续按项目设计规范（`bms-design-spec` / `ui-design-spec`）单独过一遍，不在本计划范围。

**Files:**
- Create: `src/editor/panels/TimelinePanel.tsx`
- Test: `src/editor/panels/TimelinePanel.test.tsx`

### 关键帧编辑工作流（烘焙式，物体与相机一致）

为避免 `useFrame` 覆盖与 `TransformControls` 拖动冲突：

1. **打关键帧**：把对象/相机摆到目标状态 → 指针移到某时刻 → 点「打关键帧」→ 把当前静态值存为该时刻关键帧。
2. **改关键帧**：点轨道上的关键帧方块 → 自动把值写回对象/相机（视口显示该帧状态、暂停）→ 调整 → 点「更新选中关键帧」写回。
3. **删关键帧**：选中后点「删除选中关键帧」。

相机打帧约束：**只允许 `targetMode === "manual"` 的相机打运镜关键帧**（UI 禁用按钮 + 提示）。

- [ ] **Step 1: 写失败测试 `TimelinePanel.test.tsx`**

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { useDirectorStore, createDefaultDirectorProject } from "../store/directorStore";
import { usePlaybackStore } from "../runtime/playbackStore";
import { TimelinePanel } from "./TimelinePanel";

beforeEach(() => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  usePlaybackStore.setState({ isPlaying: false, playhead: 0, duration: 5 });
});

it("renders play button and time readout", () => {
  render(<TimelinePanel />);
  expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
  expect(screen.getByText(/0\.0s \/ 5\.0s/)).toBeInTheDocument();
});

it("toggles to pause when play button clicked", () => {
  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: "播放" }));
  expect(usePlaybackStore.getState().isPlaying).toBe(true);
  expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
});

it("disables add-keyframe button when no object is selected", () => {
  render(<TimelinePanel />);
  expect(screen.getByRole("button", { name: /在指针处打关键帧/ })).toBeDisabled();
});

it("adds an object keyframe for the selected object at the playhead", () => {
  const objectId = useDirectorStore.getState().project.objects[0].id;
  useDirectorStore.getState().selectObject(objectId);
  usePlaybackStore.getState().setPlayhead(2);

  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  const track = useDirectorStore.getState().project.timeline.tracks.find((t) => t.objectId === objectId);
  expect(track?.keyframes).toHaveLength(1);
  expect(track?.keyframes[0].time).toBe(2);
});

it("adds a camera keyframe when a manual camera is selected", () => {
  // 默认工程的相机是 manual
  const cameraObject = useDirectorStore.getState().project.objects.find((o) => o.kind === "camera")!;
  useDirectorStore.getState().selectObject(cameraObject.id);
  usePlaybackStore.getState().setPlayhead(1);

  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  const cameraId = cameraObject.linkedCameraId!;
  const track = useDirectorStore.getState().project.timeline.cameraTracks.find((t) => t.cameraId === cameraId);
  expect(track?.keyframes).toHaveLength(1);
});

it("deletes a selected keyframe", () => {
  const objectId = useDirectorStore.getState().project.objects[0].id;
  useDirectorStore.getState().selectObject(objectId);
  usePlaybackStore.getState().setPlayhead(1);
  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  fireEvent.click(screen.getByRole("button", { name: /关键帧/ }));
  fireEvent.click(screen.getByRole("button", { name: "删除选中关键帧" }));

  expect(useDirectorStore.getState().project.timeline.tracks).toEqual([]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- src/editor/panels/TimelinePanel.test.tsx`
Expected: FAIL（组件不存在）。

- [ ] **Step 3: 写实现 `TimelinePanel.tsx`**

```tsx
import { useState } from "react";
import type { CameraKeyframeValue, KeyframeTransformValue } from "../schema/timeline";
import { useDirectorStore } from "../store/directorStore";
import { usePlaybackStore } from "../runtime/playbackStore";

interface SelectedKeyframe {
  kind: "object" | "camera";
  targetId: string;
  keyframeId: string;
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

  const isPlaying = usePlaybackStore((state) => state.isPlaying);
  const playhead = usePlaybackStore((state) => state.playhead);
  const duration = usePlaybackStore((state) => state.duration);
  const togglePlaying = usePlaybackStore((state) => state.togglePlaying);
  const setPlaying = usePlaybackStore((state) => state.setPlaying);
  const setPlayhead = usePlaybackStore((state) => state.setPlayhead);

  const [selectedKeyframe, setSelectedKeyframe] = useState<SelectedKeyframe | null>(null);

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

  const addKeyframeDisabled = selectionIsManualCamera ? !canAddCameraKeyframe : !selectedObject;
  const addKeyframeTitle = selectionIsManualCamera
    ? canAddCameraKeyframe
      ? `把相机「${selectedShot?.name}」当前机位记录为 ${formatTime(playhead)} 处的运镜关键帧`
      : "锁定物体的相机（targetMode=object）不支持运镜关键帧"
    : selectedObject
      ? `把「${selectedObject.name}」当前位置记录为 ${formatTime(playhead)} 处的关键帧`
      : "请先选择一个对象或相机";

  return (
    <section className="panel-card timeline-panel" aria-label="时间轴">
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
                    <button
                      key={kf.id}
                      type="button"
                      className={`timeline-keyframe${isSelected ? " is-selected" : ""}`}
                      style={{ left: `${leftPercent}%` }}
                      aria-label={`关键帧 ${formatTime(kf.time)}`}
                      onClick={() => handleSelectObjectKeyframe(track.objectId, kf.id, kf.time, kf.value)}
                    />
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
                    <button
                      key={kf.id}
                      type="button"
                      className={`timeline-keyframe timeline-keyframe-camera${isSelected ? " is-selected" : ""}`}
                      style={{ left: `${leftPercent}%` }}
                      aria-label={`运镜关键帧 ${formatTime(kf.time)}`}
                      onClick={() => handleSelectCameraKeyframe(track.cameraId, kf.id, kf.time, kf.value)}
                    />
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
```

- [ ] **Step 4: 加最小样式（功能优先）**

定位全局样式入口（运行 `grep -rl "panel-card" src/styles` 找到文件），追加：
```css
.timeline-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px 12px; }
.timeline-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.timeline-toolbar input[type="range"] { flex: 1; min-width: 120px; }
.timeline-time-readout { font-variant-numeric: tabular-nums; min-width: 96px; }
.timeline-duration { display: inline-flex; align-items: center; gap: 4px; }
.timeline-duration input { width: 56px; }
.timeline-tracks { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; }
.timeline-track { display: flex; align-items: center; gap: 8px; }
.timeline-track-label { width: 110px; flex-shrink: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.timeline-track-lane { position: relative; flex: 1; height: 20px; background: rgba(127, 127, 127, 0.15); border-radius: 4px; }
.timeline-keyframe { position: absolute; top: 50%; width: 12px; height: 12px; transform: translate(-50%, -50%); background: #4F8EF7; border: none; border-radius: 2px; padding: 0; cursor: pointer; }
.timeline-keyframe-camera { background: #12B886; }
.timeline-keyframe.is-selected { background: #F2A900; outline: 1px solid #fff; }
.timeline-empty { opacity: 0.7; margin: 4px 0; }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npm test -- src/editor/panels/TimelinePanel.test.tsx`
Expected: PASS。

- [ ] **Step 6: 提交（按约定跳过 git）**

```bash
git add src/editor/panels/TimelinePanel.tsx src/editor/panels/TimelinePanel.test.tsx src/styles
git commit -m "feat(timeline): add timeline panel with object and camera keyframe editing"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Task 8: 接入布局 + 全量构建 + 手测

**Files:**
- Modify: `src/app/layout/DirectorDeskShell.tsx`

- [ ] **Step 1: 把 TimelinePanel 挂到视口列底部**

在 `DirectorDeskShell.tsx` 顶部 import：
```tsx
import { TimelinePanel } from "../../editor/panels/TimelinePanel";
```

把 `<section className="viewport-column">` 改为：
```tsx
      <section className="viewport-column" aria-label="3D视口">
        <div className="viewport-stack">
          {children}
          <TimelinePanel />
        </div>
      </section>
```

并在全局样式里补：
```css
.viewport-stack { display: flex; flex-direction: column; height: 100%; }
.viewport-stack > :first-child { flex: 1; min-height: 0; }
```

- [ ] **Step 2: 全量测试**

Run: `npm test`
Expected: PASS（含原有用例 + 新增用例）。原有 8 个失败用例（模型库面板/画幅命中区/个别姿势/样式断言）若仍失败，**保持原状不算回归**——记录一下新旧失败数即可。

- [ ] **Step 3: 生产构建**

Run: `npm run build`
Expected: 通过（tsc + vite build）。

- [ ] **Step 4: 手测清单（`npm run dev`，浏览器 `http://127.0.0.1:5173/`）**

**物体关键帧：**
1. 底部出现时间轴面板，显示「播放」按钮和 `0.0s / 5.0s`。
2. 选中默认角色 → 用 gizmo 挪到某位置 → 指针拖到 `1.0s` → 点「在指针处打关键帧」→ 轨道出现蓝色方块。
3. 指针拖到 `3.0s` → 把角色挪到另一位置 → 再打关键帧。
4. 点「播放」：角色在 0–3 秒线性移动，到末尾循环回起点；播放中 gizmo 消失。
5. 拖动指针 scrub：角色停在对应插值位置。
6. 点轨道某关键帧：角色跳到该帧姿态、暂停、方块变橙；gizmo 调整位置 → 「更新选中关键帧」→ 再播放验证已更新。
7. 「删除选中关键帧」：方块消失；轨道空了则整行消失。

**相机运镜：**
8. 选中相机（导演视图点相机线框）→ 指针到 `0.5s` → 点「打关键帧」→ 相机轨道出现绿色方块。
9. 指针到 `3.5s` → 用 gizmo 把相机挪到另一个机位/调整 target/fov → 再打关键帧。
10. 点「播放」：**导演视图**里相机线框沿轨迹平滑移动；切到**机位视图**，能看到真正的运镜画面（推/拉/摇/变焦）。
11. 在机位视图 scrub 指针：运镜画面随之停在对应时刻。
12. 点相机轨道某关键帧 → 相机回到该帧机位、暂停 → 调整 → 「更新选中关键帧」。

**持久化与导入导出：**
13. 刷新页面：场景、物体关键帧、相机运镜关键帧都还在。
14. 「导出工程 JSON」→「导入工程 JSON」：物体 + 相机关键帧数据完整保留。
15. 导入一个旧的 v1 工程（无 timeline）：能正常打开，timeline 自动补为空默认值，不报错。

- [ ] **Step 5: 提交（按约定跳过 git）**

```bash
git add src/app/layout/DirectorDeskShell.tsx src/styles
git commit -m "feat(timeline): mount timeline panel under the viewport"
```
> ⚠️ 跳过本步骤（本阶段不用 git）。

---

## Self-Review（计划自检）

**1. Spec coverage（范围覆盖）**
- 物体 position/rotation/scale 关键帧：Task 1 / 3 / 5 / 7。✅
- 相机运镜 position/target/fov 关键帧：Task 1（数据+插值）/ 3（actions）/ 6（两路径回放）/ 7（UI）。✅
- 两种运镜预览（导演视图线框 + 机位视图画面）：Task 6 Step 2 + Step 1。✅
- 线性插值：Task 1 `evaluateKeyframes` / `lerpTransformValue` / `lerpCameraValue`。✅
- 时间轴 UI（播放/指针/时长/打帧/选删改，物体+相机）：Task 7。✅
- 视口实时预览：Task 4 + 5 + 6。✅
- 仅 manual 相机支持运镜：Task 7 `canAddCameraKeyframe` + `addKeyframeDisabled`。✅
- 工程 JSON / localStorage 自动带 timeline：Task 2（schema+migration+replaceProject 走 migrate），复用现有持久化与 `serializeProject`。✅
- 排除项（姿势动画/视频导出/曲线编辑/四元数）：均未出现在任何 task。✅

**2. Placeholder scan**
- 所有步骤含完整代码或精确命令；样式文件路径用 `grep -rl "panel-card" src/styles` 定位，非占位。✅
- 无 TBD / "类似上面" / "补充错误处理"。✅

**3. Type consistency**
- `KeyframeTransformValue` / `CameraKeyframeValue` 在 Task 1 定义，Task 3 actions、Task 7 UI 均用同名类型。✅
- 纯函数名：`timeline.ts` 导出 `upsertKeyframe/removeKeyframe/updateKeyframeTime/updateKeyframeValue` 与 `upsertCameraKeyframe/removeCameraKeyframe/updateCameraKeyframeTime/updateCameraKeyframeValue`；store 内为避免与 action 同名，import 时分别别名成 `removeTimelineKeyframe/updateTimelineKeyframeTime/...` 与 `removeTimelineCameraKeyframe/updateTimelineCameraKeyframeTime/...`（Task 2 Step 2 已列全 import；Task 3 Step 4 使用别名一致）。`upsertKeyframe` / `upsertCameraKeyframe` 在 action（`addKeyframe` / `addCameraKeyframe`）里直接用，不冲突。✅
- `evaluateTrackAtTime(track, time)` / `evaluateCameraTrackAtTime(track, time)` 签名在 Task 1、Task 5、Task 6 调用一致。✅
- `usePlaybackStore` 的 `advance/setPlayhead/setDuration/togglePlaying/setPlaying` 在 Task 4 定义，Task 5/6/7 调用一致。✅
- `Timeline` 含 `tracks` + `cameraTracks`，Task 1 默认值、Task 2 migration（`withTimeline` 补 `cameraTracks: []`）、所有测试断言一致。✅
- `applyCameraKeyframeToShot` 内部复用现有 `updateCamera`（传 `fov/target/transform`），与 `updateCamera` 已有"同步相机 object transform"行为一致，无需额外处理 linked object。✅

---

## 备注 / 已知限制

- **物体旋转用欧拉线性插值**：超过 ±180° 会"走远路"。MVP 可接受；未来可改四元数 `slerp`。
- **相机朝向用 target 线性插值**：target 穿过相机位置附近时可能抖动，属正常 lookAt 行为，MVP 不处理。
- **群众阵列（crowd）**：成员是独立 `DirectorObject`，逐个打关键帧可行但繁琐；本计划不为 crowd 做整组轨道。
- **`useFrame` 集成无单测**：R3F canvas 内逐帧逻辑难以在 vitest 直接测，靠 Task 8 手测兜底；纯逻辑（物体/相机插值、增删改）已被 Task 1 / Task 3 覆盖。
- **`targetMode === "object"` 相机**：不支持运镜关键帧（UI 禁用）。如未来需要，可在回放时把"锁定物体"的 target 解析为物体当前位置再叠加，本计划不做。
- **持久化体积**：关键帧数据量小，不会触发现有 localStorage 的 quota 容错分支问题。
