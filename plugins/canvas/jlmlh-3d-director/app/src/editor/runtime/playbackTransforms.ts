import type { Object3D, PerspectiveCamera } from "three";
import { evaluateCameraTrackAtTime, evaluateTrackAtTime } from "../schema/timeline";
import type { CameraTimelineTrack, TimelineTrack } from "../schema/timeline";
import { getViewportCameraQuaternion } from "../canvas/SceneRoot";

/**
 * 按 playhead 把物体 / 相机线框的关键帧插值结果直接写到场景中的 Three.js 对象。
 * SceneRoot 的 group 通过 userData 标记身份：
 *   - directorObjectId  → 物体（覆盖 position/rotation/scale）
 *   - directorCameraId  → 导演视图相机线框（覆盖 position + 朝向 target）
 * 正在被 gizmo 拖拽的对象（editingObjectId）会被跳过，避免覆盖编辑中的值。
 * 预览（PlaybackTransformSync 的 useFrame）与视频导出（逐帧离线渲染）共用此逻辑，
 * 保证「所见即所得」。
 */
export function applyTimelineTransformsAtTime(
  scene: Object3D,
  tracks: TimelineTrack[],
  cameraTracks: CameraTimelineTrack[],
  playhead: number,
  editingObjectId: string | null
) {
  if (tracks.length === 0 && cameraTracks.length === 0) return;

  const trackMap = new Map(tracks.map((track) => [track.objectId, track]));
  const cameraTrackMap = new Map(cameraTracks.map((track) => [track.cameraId, track]));

  scene.traverse((object) => {
    const objectId = object.userData?.directorObjectId;
    if (objectId && objectId !== editingObjectId) {
      const track = trackMap.get(objectId);
      if (track && track.keyframes.length > 0) {
        const value = evaluateTrackAtTime(track, playhead);
        if (value) {
          object.position.set(value.position[0], value.position[1], value.position[2]);
          object.rotation.set(value.rotation[0], value.rotation[1], value.rotation[2]);
          object.scale.set(value.scale[0], value.scale[1], value.scale[2]);
        }
      }
    }

    const cameraId = object.userData?.directorCameraId;
    if (cameraId && cameraId !== editingObjectId) {
      const track = cameraTrackMap.get(cameraId);
      if (track && track.keyframes.length > 0) {
        const value = evaluateCameraTrackAtTime(track, playhead);
        if (value) {
          object.position.set(value.position[0], value.position[1], value.position[2]);
          object.quaternion.copy(getViewportCameraQuaternion(value.position, value.target));
        }
      }
    }
  });
}

/**
 * 机位视图下：若当前激活相机有运镜轨道，用插值结果覆盖渲染相机的
 * position / lookAt(target) / fov，呈现真正的运镜画面。
 * 返回是否覆盖了相机（导演视角或无轨道时不动）。
 * 预览（ActiveCameraPlaybackSync 的 useFrame）与视频导出共用此逻辑。
 */
export function applyActiveCameraViewAtTime({
  camera,
  cameraTracks,
  activeCameraId,
  playhead,
  viewMode,
  editingObjectId,
}: {
  camera: PerspectiveCamera;
  cameraTracks: CameraTimelineTrack[];
  activeCameraId: string | null;
  playhead: number;
  viewMode: "director" | "camera";
  editingObjectId: string | null;
}): boolean {
  // 导演视角不覆盖，避免抢走 OrbitControls 控制的导演相机；
  // 正在通过 gizmo / CameraPanel 编辑该相机时也不覆盖。
  if (viewMode !== "camera") return false;
  if (!activeCameraId) return false;
  if (editingObjectId === activeCameraId) return false;
  const track = cameraTracks.find((item) => item.cameraId === activeCameraId);
  if (!track || track.keyframes.length === 0) return false;
  const value = evaluateCameraTrackAtTime(track, playhead);
  if (!value) return false;

  camera.position.set(value.position[0], value.position[1], value.position[2]);
  camera.lookAt(value.target[0], value.target[1], value.target[2]);
  if (Math.abs(camera.fov - value.fov) > 0.001) {
    camera.fov = value.fov;
    camera.updateProjectionMatrix();
  }
  return true;
}
