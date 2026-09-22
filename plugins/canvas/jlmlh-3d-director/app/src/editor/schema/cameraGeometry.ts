import type { DirectorCameraShot } from "./directorProject";

export interface CameraViewSnapshot {
  fov: number;
  position: [number, number, number];
  target: [number, number, number];
}

export const VIEWPORT_CAMERA_ASPECT = 16 / 9;
export const VIEWPORT_CAMERA_VISUAL_SCALE = 0.35;
export const VIEWPORT_CAMERA_FRUSTUM_DEPTH = 5.2 * VIEWPORT_CAMERA_VISUAL_SCALE;
export const VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH = 3.2 * VIEWPORT_CAMERA_VISUAL_SCALE;

export const DEFAULT_DIRECTOR_CAMERA_VIEW_SNAPSHOT: CameraViewSnapshot = {
  fov: 50,
  position: [0, 1.55, 5.4],
  target: [0, 1.05, 0],
};

export function getCameraViewSnapshotFromShot(camera: DirectorCameraShot): CameraViewSnapshot {
  return {
    fov: camera.fov,
    position: [...camera.transform.position],
    target: camera.target,
  };
}

export function getCameraRigPositionFromViewSnapshot(snapshot: CameraViewSnapshot): [number, number, number] {
  return [...snapshot.position];
}
