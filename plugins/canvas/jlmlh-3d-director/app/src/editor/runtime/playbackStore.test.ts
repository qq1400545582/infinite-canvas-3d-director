import { beforeEach, it, expect } from "vitest";
import { usePlaybackStore } from "./playbackStore";

beforeEach(() => {
  usePlaybackStore.setState({ isPlaying: false, playhead: 0, duration: 5, editingObjectId: null, stopAtEnd: false });
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

it("advance stops at the end (no loop) when stopAtEnd is true", () => {
  usePlaybackStore.getState().setStopAtEnd(true);
  usePlaybackStore.getState().setPlaying(true);
  usePlaybackStore.getState().setPlayhead(4.8);
  usePlaybackStore.getState().advance(0.5);

  const state = usePlaybackStore.getState();
  expect(state.playhead).toBe(5);
  expect(state.isPlaying).toBe(false);
});

it("setDuration keeps a positive minimum", () => {
  usePlaybackStore.getState().setDuration(0);
  expect(usePlaybackStore.getState().duration).toBeGreaterThanOrEqual(0.1);
});
