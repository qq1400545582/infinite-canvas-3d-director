import { beforeEach, describe, expect, it } from "vitest";
import { createInitialDirectorState, useDirectorStore } from "./directorStore";

function getCharacter(id: string) {
  return useDirectorStore.getState().project.objects.find((item) => item.id === id);
}

beforeEach(() => {
  useDirectorStore.setState({
    ...useDirectorStore.getState(),
    ...createInitialDirectorState(),
  });
});

describe("姿势与动作互斥", () => {
  it("从「无」切到走路：姿势重置为站立基础态", () => {
    // 先摆一个非站立姿势
    useDirectorStore.getState().applyPosePreset("char_default_a", "sit");
    expect(getCharacter("char_default_a")?.characterRig?.posePresetId).toBe("sit");

    useDirectorStore.getState().setMotion("char_default_a", "walk");

    const rig = getCharacter("char_default_a")?.characterRig;
    expect(rig?.posePresetId).toBe("stand");
    expect(rig?.controls).toEqual({});
    expect(rig?.motion?.kind).toBe("walk");
  });

  it("应用姿势预设：动作自动关闭，但保留速度/幅度调参", () => {
    useDirectorStore.getState().setMotion("char_default_a", "walk");
    useDirectorStore.getState().setMotionSpeed("char_default_a", 1.8);
    useDirectorStore.getState().setMotionAmplitude("char_default_a", 1.3);

    useDirectorStore.getState().applyPosePreset("char_default_a", "t-pose");

    const rig = getCharacter("char_default_a")?.characterRig;
    expect(rig?.motion?.kind).toBe("none");
    expect(rig?.motion?.speed).toBe(1.8);
    expect(rig?.motion?.amplitude).toBe(1.3);
    expect(rig?.posePresetId).toBe("t-pose");
  });

  it("动作之间切换（walk→run）：姿势数据整体重置，微调不残留", () => {
    useDirectorStore.getState().setMotion("char_default_a", "walk");
    useDirectorStore.getState().updatePoseControl("char_default_a", "head.yaw", 30);

    useDirectorStore.getState().setMotion("char_default_a", "run");

    const rig = getCharacter("char_default_a")?.characterRig;
    expect(rig?.motion?.kind).toBe("run");
    expect(rig?.posePresetId).toBe("stand");
    expect(rig?.controls).toEqual({});
  });

  it("切回「无」：姿势同样重置为站立", () => {
    useDirectorStore.getState().setMotion("char_default_a", "walk");
    useDirectorStore.getState().updatePoseControl("char_default_a", "head.yaw", 15);

    useDirectorStore.getState().setMotion("char_default_a", "none");

    const rig = getCharacter("char_default_a")?.characterRig;
    expect(rig?.motion?.kind).toBe("none");
    expect(rig?.posePresetId).toBe("stand");
    expect(rig?.controls).toEqual({});
  });

  it("重复选择同一动作：不触发重置", () => {
    useDirectorStore.getState().setMotion("char_default_a", "walk");
    useDirectorStore.getState().updatePoseControl("char_default_a", "head.yaw", 20);

    useDirectorStore.getState().setMotion("char_default_a", "walk");

    const rig = getCharacter("char_default_a")?.characterRig;
    expect(rig?.controls["head.yaw"]).toBe(20);
  });

  it("群众：整组切动作重置为站立；整组摆姿势关动作", () => {
    useDirectorStore.getState().addCrowdCharacters({ rows: 1, columns: 2, spacing: 1 });
    useDirectorStore.getState().selectCrowd("crowd_1");
    useDirectorStore.getState().applyCrowdPosePreset("crowd_1", "sit");

    useDirectorStore.getState().setCrowdMotion("crowd_1", "walk");

    const members = useDirectorStore
      .getState()
      .project.objects.filter((item) => item.kind === "character" && item.crowdId === "crowd_1");
    expect(members).toHaveLength(2);
    for (const member of members) {
      expect(member.characterRig?.posePresetId).toBe("stand");
      expect(member.characterRig?.motion?.kind).toBe("walk");
    }

    useDirectorStore.getState().applyCrowdPosePreset("crowd_1", "t-pose");
    const after = useDirectorStore
      .getState()
      .project.objects.filter((item) => item.kind === "character" && item.crowdId === "crowd_1");
    for (const member of after) {
      expect(member.characterRig?.motion?.kind).toBe("none");
      expect(member.characterRig?.posePresetId).toBe("t-pose");
    }
  });
});