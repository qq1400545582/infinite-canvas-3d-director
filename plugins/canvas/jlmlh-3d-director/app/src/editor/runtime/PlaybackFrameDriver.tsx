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
