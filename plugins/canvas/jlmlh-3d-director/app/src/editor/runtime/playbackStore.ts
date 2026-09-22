import { create } from "zustand";
import { DEFAULT_TIMELINE_DURATION } from "../schema/timeline";

export interface PlaybackState {
  isPlaying: boolean;
  playhead: number; // 秒
  duration: number; // 秒，与 timeline.duration 保持同步
  /** 正在被 gizmo 拖拽的对象 id（DirectorObject.id 或 DirectorCameraShot.id）。
   *  PlaybackTransformSync 会跳过它，避免把 gizmo 改的值立刻覆盖回去。 */
  editingObjectId: string | null;
  /** 录制视频时置 true：播放到末尾就停住（不循环回 0），便于 MediaRecorder 干净收尾。 */
  stopAtEnd: boolean;
  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setPlayhead: (time: number) => void;
  setDuration: (duration: number) => void;
  setEditingObjectId: (id: string | null) => void;
  setStopAtEnd: (stop: boolean) => void;
  /** 供 useFrame 调用：推进 playhead；到末尾时按 stopAtEnd 决定停止还是循环 */
  advance: (deltaSeconds: number) => void;
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

export const usePlaybackStore = create<PlaybackState>((set, get) => ({
  isPlaying: false,
  playhead: 0,
  duration: DEFAULT_TIMELINE_DURATION,
  editingObjectId: null,
  stopAtEnd: false,
  setPlaying: (isPlaying) => set({ isPlaying }),
  togglePlaying: () => set((state) => ({ isPlaying: !state.isPlaying })),
  // scrub 指针 = 退出单对象编辑态，清掉 editingObjectId，让所有对象回到 playhead 插值
  setPlayhead: (playhead) =>
    set((state) => ({ playhead: clamp(playhead, 0, state.duration), editingObjectId: null })),
  setDuration: (duration) => set({ duration: Math.max(0.1, duration) }),
  setEditingObjectId: (editingObjectId) => set({ editingObjectId }),
  setStopAtEnd: (stopAtEnd) => set({ stopAtEnd }),
  advance: (deltaSeconds) => {
    if (!get().isPlaying) return;
    set((state) => {
      const next = state.playhead + deltaSeconds;
      if (next >= state.duration) {
        return state.stopAtEnd
          ? { playhead: state.duration, isPlaying: false }
          : { playhead: 0 };
      }
      return { playhead: next };
    });
  },
}));
