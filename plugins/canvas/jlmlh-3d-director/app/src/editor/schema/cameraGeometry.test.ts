import { createDefaultDirectorProject } from "../store/directorStore";
import {
  VIEWPORT_CAMERA_FRUSTUM_DEPTH,
  VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH,
  VIEWPORT_CAMERA_VISUAL_SCALE,
  getCameraRigPositionFromViewSnapshot,
  getCameraViewSnapshotFromShot,
} from "./cameraGeometry";

it("places the camera viewing point at the rig position", () => {
  const camera = createDefaultDirectorProject().cameras[0];
  const viewSnapshot = getCameraViewSnapshotFromShot(camera);

  expect(viewSnapshot.position).toEqual(camera.transform.position);
  expect(viewSnapshot.target).toEqual(camera.target);
  expect(viewSnapshot.fov).toBe(camera.fov);
});

it("returns the rig position from a saved viewport snapshot", () => {
  const snapshot = {
    fov: 50,
    position: [0, 1.62, 3.8] as [number, number, number],
    target: [0, 1.2, 0] as [number, number, number],
  };
  const rigPosition = getCameraRigPositionFromViewSnapshot(snapshot);

  expect(rigPosition).toEqual(snapshot.position);
});

it("scales the viewport camera viewfinder from one visual scale", () => {
  expect(VIEWPORT_CAMERA_VISUAL_SCALE).toBeCloseTo(0.8);
  expect(VIEWPORT_CAMERA_FRUSTUM_DEPTH).toBeCloseTo(5.2 * VIEWPORT_CAMERA_VISUAL_SCALE);
  expect(VIEWPORT_CAMERA_FRUSTUM_FRAME_WIDTH).toBeCloseTo(3.2 * VIEWPORT_CAMERA_VISUAL_SCALE);
});
