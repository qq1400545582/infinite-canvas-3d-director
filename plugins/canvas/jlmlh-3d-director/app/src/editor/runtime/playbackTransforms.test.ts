import { describe, it, expect } from "vitest";
import { Object3D, PerspectiveCamera, Vector3 } from "three";
import type { CameraTimelineTrack, TimelineTrack } from "../schema/timeline";
import { applyActiveCameraViewAtTime, applyTimelineTransformsAtTime } from "./playbackTransforms";
import { computeExportSize } from "../io/videoExport";
import { getViewportCameraQuaternion } from "../canvas/SceneRoot";

function makeObjectTrack(): TimelineTrack {
  return {
    objectId: "obj-1",
    keyframes: [
      {
        id: "kf-1",
        time: 0,
        value: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
      {
        id: "kf-2",
        time: 2,
        value: { position: [4, 6, 8], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    ],
  };
}

function makeCameraTrack(): CameraTimelineTrack {
  return {
    cameraId: "cam-1",
    keyframes: [
      { id: "ckf-1", time: 0, value: { position: [0, 1, 0], target: [0, 0, 0], fov: 50 } },
      { id: "ckf-2", time: 2, value: { position: [2, 1, 0], target: [0, 0, 0], fov: 60 } },
    ],
  };
}

it("applies interpolated object transform at the playhead", () => {
  const scene = new Object3D();
  const child = new Object3D();
  child.userData.directorObjectId = "obj-1";
  scene.add(child);

  applyTimelineTransformsAtTime(scene, [makeObjectTrack()], [], 1, null);

  expect(child.position.toArray()).toEqual([2, 3, 4]); // 中点插值
});

it("keeps editing object untouched (gizmo is dragging it)", () => {
  const scene = new Object3D();
  const child = new Object3D();
  child.position.set(9, 9, 9);
  child.userData.directorObjectId = "obj-1";
  scene.add(child);

  applyTimelineTransformsAtTime(scene, [makeObjectTrack()], [], 1, "obj-1");

  expect(child.position.toArray()).toEqual([9, 9, 9]);
});

it("applies camera wireframe position and orientation from the camera track", () => {
  const scene = new Object3D();
  const wire = new Object3D();
  wire.userData.directorCameraId = "cam-1";
  scene.add(wire);

  applyTimelineTransformsAtTime(scene, [], [makeCameraTrack()], 2, null);

  expect(wire.position.toArray()).toEqual([2, 1, 0]);
  // 朝向使用 SceneRoot 的 getViewportCameraQuaternion 约定（与预览线框一致）
  const expectedQuaternion = getViewportCameraQuaternion([2, 1, 0], [0, 0, 0]);
  expect(wire.quaternion.equals(expectedQuaternion)).toBe(true);
});

it("overrides the render camera in camera view mode", () => {
  const camera = new PerspectiveCamera(50, 16 / 9);
  camera.position.set(100, 100, 100);

  const applied = applyActiveCameraViewAtTime({
    camera,
    cameraTracks: [makeCameraTrack()],
    activeCameraId: "cam-1",
    playhead: 2,
    viewMode: "camera",
    editingObjectId: null,
  });

  expect(applied).toBe(true);
  expect(camera.position.toArray()).toEqual([2, 1, 0]);
  expect(camera.fov).toBe(60);
});

it("does not override the render camera in director view mode", () => {
  const camera = new PerspectiveCamera(50, 16 / 9);
  camera.position.set(100, 100, 100);

  const applied = applyActiveCameraViewAtTime({
    camera,
    cameraTracks: [makeCameraTrack()],
    activeCameraId: "cam-1",
    playhead: 2,
    viewMode: "director",
    editingObjectId: null,
  });

  expect(applied).toBe(false);
  expect(camera.position.x).toBe(100);
});

describe("computeExportSize", () => {
  it("uses 16:9 short-edge-720 for a 16:9 ratio", () => {
    expect(computeExportSize("16:9")).toEqual({ width: 1280, height: 720 });
  });

  it("uses portrait 720x1280 for 9:16", () => {
    expect(computeExportSize("9:16")).toEqual({ width: 720, height: 1280 });
  });

  it("falls back to a fixed 16:9 when ratio is auto — never the squashed viewport aspect", () => {
    // 时间轴拖高压扁视口（如 1200x400）时，auto 也固定导出 16:9，画面不会跟着变扁
    expect(computeExportSize("auto")).toEqual({ width: 1280, height: 720 });
  });

  it("keeps even dimensions for the encoder", () => {
    const { width, height } = computeExportSize("4:3");
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});
