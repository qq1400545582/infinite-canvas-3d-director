import { useFrame, useThree } from "@react-three/fiber";
import { PerspectiveCamera as ThreePerspectiveCamera } from "three";
import { useDirectorStore } from "../store/directorStore";
import { usePlaybackStore } from "./playbackStore";
import { applyActiveCameraViewAtTime } from "./playbackTransforms";

/**
 * 机位视图下：若当前激活相机有运镜轨道，每帧用插值结果覆盖渲染相机的
 * position / lookAt(target) / fov，呈现真正的运镜画面（逻辑在 playbackTransforms.ts，
 * 与视频导出共用）。挂在 <Canvas> 内；非机位视图或相机无轨道时为空操作。
 */
export function ActiveCameraPlaybackSync({ activeCameraId }: { activeCameraId: string | null }) {
  const camera = useThree((state) => state.camera);
  const cameraTracks = useDirectorStore((state) => state.project.timeline.cameraTracks);
  const viewMode = useDirectorStore((state) => state.viewMode);
  const playhead = usePlaybackStore((state) => state.playhead);
  const editingObjectId = usePlaybackStore((state) => state.editingObjectId);

  useFrame(() => {
    // 机位视角下覆盖渲染相机（播放 + scrub 均生效），导演视角 / 编辑中不覆盖
    applyActiveCameraViewAtTime({
      camera: camera as ThreePerspectiveCamera,
      cameraTracks,
      activeCameraId,
      playhead,
      viewMode,
      editingObjectId,
    });
  });

  return null;
}
