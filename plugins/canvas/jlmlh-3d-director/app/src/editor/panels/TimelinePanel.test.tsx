import { beforeEach, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { useDirectorStore, createDefaultDirectorProject } from "../store/directorStore";
import { usePlaybackStore } from "../runtime/playbackStore";
import { TimelinePanel } from "./TimelinePanel";

beforeEach(() => {
  useDirectorStore.getState().replaceProject(createDefaultDirectorProject() as never);
  usePlaybackStore.setState({ isPlaying: false, playhead: 0, duration: 5 });
});

it("renders play button and time readout", () => {
  render(<TimelinePanel />);
  expect(screen.getByRole("button", { name: "播放" })).toBeInTheDocument();
  expect(screen.getByText(/0\.0s \/ 5\.0s/)).toBeInTheDocument();
});

it("toggles to pause when play button clicked", () => {
  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: "播放" }));
  expect(usePlaybackStore.getState().isPlaying).toBe(true);
  expect(screen.getByRole("button", { name: "暂停" })).toBeInTheDocument();
});

it("disables add-keyframe button when no object is selected", () => {
  render(<TimelinePanel />);
  expect(screen.getByRole("button", { name: /在指针处打关键帧/ })).toBeDisabled();
});

it("adds an object keyframe for the selected object at the playhead", () => {
  const objectId = useDirectorStore.getState().project.objects[0].id;
  useDirectorStore.getState().selectObject(objectId);
  usePlaybackStore.getState().setPlayhead(2);

  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  const track = useDirectorStore.getState().project.timeline.tracks.find((t) => t.objectId === objectId);
  expect(track?.keyframes).toHaveLength(1);
  expect(track?.keyframes[0].time).toBe(2);
});

it("adds a camera keyframe when a manual camera is selected", () => {
  // 默认工程的相机是 manual
  const cameraObject = useDirectorStore.getState().project.objects.find((o) => o.kind === "camera")!;
  useDirectorStore.getState().selectObject(cameraObject.id);
  usePlaybackStore.getState().setPlayhead(1);

  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  const cameraId = cameraObject.linkedCameraId!;
  const track = useDirectorStore.getState().project.timeline.cameraTracks.find((t) => t.cameraId === cameraId);
  expect(track?.keyframes).toHaveLength(1);
});

it("deletes a selected keyframe", () => {
  const objectId = useDirectorStore.getState().project.objects[0].id;
  useDirectorStore.getState().selectObject(objectId);
  usePlaybackStore.getState().setPlayhead(1);
  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  // 关键帧方块的 aria-label 是 "关键帧 1.0s"，用精确 name 定位避免和"打关键帧"等按钮冲突
  fireEvent.click(screen.getByRole("button", { name: "关键帧 1.0s" }));
  fireEvent.click(screen.getByRole("button", { name: "删除选中关键帧" }));

  expect(useDirectorStore.getState().project.timeline.tracks).toEqual([]);
});

it("deletes a keyframe via the per-keyframe × button", () => {
  const objectId = useDirectorStore.getState().project.objects[0].id;
  useDirectorStore.getState().selectObject(objectId);
  usePlaybackStore.getState().setPlayhead(1);
  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  fireEvent.click(screen.getByRole("button", { name: "删除关键帧 1.0s" }));

  expect(useDirectorStore.getState().project.timeline.tracks).toEqual([]);
});

it("clears all keyframes via the clear-all button", () => {
  const objectId = useDirectorStore.getState().project.objects[0].id;
  useDirectorStore.getState().selectObject(objectId);
  render(<TimelinePanel />);
  fireEvent.click(screen.getByRole("button", { name: /在指针处打关键帧/ }));

  vi.spyOn(window, "confirm").mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "清空全部" }));

  expect(useDirectorStore.getState().project.timeline.tracks).toEqual([]);
});

it("grows the timeline panel when dragging the top resizer upward", () => {
  const { container } = render(<TimelinePanel />);
  const panel = container.querySelector<HTMLElement>(".timeline-panel")!;
  expect(panel.style.height).toBe("300px");

  const resizer = screen.getByRole("separator", { name: "拖动调整时间轴高度" });
  fireEvent.pointerDown(resizer, { clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(resizer, { clientY: 440, pointerId: 1 }); // 向上拖 60px
  fireEvent.pointerUp(resizer, { clientY: 440, pointerId: 1 });

  expect(panel.style.height).toBe("360px");
});

it("clamps the timeline height to a minimum when dragging downward far", () => {
  const { container } = render(<TimelinePanel />);
  const panel = container.querySelector<HTMLElement>(".timeline-panel")!;

  const resizer = screen.getByRole("separator", { name: "拖动调整时间轴高度" });
  fireEvent.pointerDown(resizer, { clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(resizer, { clientY: 900, pointerId: 1 }); // 向下拖 400px
  fireEvent.pointerUp(resizer, { clientY: 900, pointerId: 1 });

  expect(panel.style.height).toBe("160px");
});

it("clamps the timeline height to the fixed 420px maximum when dragging upward far", () => {
  const { container } = render(<TimelinePanel />);
  const panel = container.querySelector<HTMLElement>(".timeline-panel")!;

  const resizer = screen.getByRole("separator", { name: "拖动调整时间轴高度" });
  fireEvent.pointerDown(resizer, { clientY: 500, pointerId: 1 });
  fireEvent.pointerMove(resizer, { clientY: 100, pointerId: 1 }); // 向上拖 400px → 700 超上限
  fireEvent.pointerUp(resizer, { clientY: 100, pointerId: 1 });

  expect(panel.style.height).toBe("420px");
});
