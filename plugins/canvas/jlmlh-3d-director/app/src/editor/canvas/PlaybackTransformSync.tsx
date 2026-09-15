import { useFrame, useThree } from "@react-three/fiber";
import { useDirectorStore } from "../store/directorStore";
import { usePlaybackStore } from "../runtime/playbackStore";
import { applyTimelineTransformsAtTime } from "../runtime/playbackTransforms";

/**
 * 挂在 <Canvas> 内：每帧根据 playhead 把物体/相机线框的插值结果直接写到
 * 对应的 Three.js 对象（逻辑在 playbackTransforms.ts，与视频导出共用）。
 * 无轨道或无关键帧的对象保持静态，不被触碰。
 */
export function PlaybackTransformSync() {
  const scene = useThree((state) => state.scene);
  const tracks = useDirectorStore((state) => state.project.timeline.tracks);
  const cameraTracks = useDirectorStore((state) => state.project.timeline.cameraTracks);
  const playhead = usePlaybackStore((state) => state.playhead);
  const editingObjectId = usePlaybackStore((state) => state.editingObjectId);

  useFrame(() => {
    // 播放、scrub 时都按 playhead 插值覆盖；editingObjectId 的跳过逻辑在共享函数里
    applyTimelineTransformsAtTime(scene, tracks, cameraTracks, playhead, editingObjectId);
  });

  return null;
}
