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
