import { describe, expect, it } from "vitest";
import {
  applyMotionOverrides,
  computeMotionOverrides,
  hashIdToPhase,
  MOTION_DRIVEN_CONTROL_KEYS,
  RUN_FREQUENCY_MULTIPLIER,
} from "./motion";
import type { CharacterMotionState } from "../../schema/directorProject";

const WALK: CharacterMotionState = { kind: "walk", speed: 1, amplitude: 1, enabled: true };
const RUN: CharacterMotionState = { kind: "run", speed: 1, amplitude: 1, enabled: true };

describe("computeMotionOverrides", () => {
  it("returns empty override when motion is null/undefined", () => {
    expect(computeMotionOverrides({ motion: null, time: 1, characterId: "x" })).toEqual({});
    expect(computeMotionOverrides({ motion: undefined, time: 1, characterId: "x" })).toEqual({});
  });

  it("returns empty override when kind is none", () => {
    expect(computeMotionOverrides({ motion: { ...WALK, kind: "none" }, time: 1, characterId: "x" })).toEqual({});
  });

  it("returns empty override when enabled=false", () => {
    expect(computeMotionOverrides({ motion: { ...WALK, enabled: false }, time: 1, characterId: "x" })).toEqual({});
  });

  it("returns empty override for idle (MVP placeholder)", () => {
    expect(
      computeMotionOverrides({ motion: { ...WALK, kind: "idle" }, time: 1, characterId: "x" })
    ).toEqual({});
  });

  /** 求使左肢相位 θL = target 的 time（speed=1，走路频率）。 */
  function timeForLeftPhase(target: number, characterId: string): number {
    const phase = hashIdToPhase(characterId);
    return (target - phase) / (Math.PI * 2);
  }

  /** 求使跑步左肢相位 θL = target 的 time（speed=1；跑步基础频率 ×1.5）。 */
  function timeForRunLeftPhase(target: number, characterId: string): number {
    const phase = hashIdToPhase(characterId);
    return (target - phase) / (RUN_FREQUENCY_MULTIPLIER * Math.PI * 2);
  }

  it("walk: 腿摆到最前（脚跟着地）时膝盖几乎伸直 —— 自然步态关键特征", () => {
    const t = timeForLeftPhase(Math.PI / 2, "x");
    const o = computeMotionOverrides({ motion: WALK, time: t, characterId: "x" });

    // 左髋前摆峰值 25°
    expect((o["leftHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(25);
    // 右髋后摆 -12°（不对称摆幅）
    expect((o["rightHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(-12);
    // 左膝着地瞬间伸直
    expect(o["leftKnee.bend"]).toBeCloseTo(0);
  });

  it("walk: 摆动中期膝峰 45°，对侧腿同时伸直", () => {
    const t = timeForLeftPhase(0, "x");
    const o = computeMotionOverrides({ motion: WALK, time: t, characterId: "x" });

    expect((o["leftKnee.bend"] as number) * 180 / Math.PI).toBeCloseTo(45);
    expect(o["rightKnee.bend"]).toBeCloseTo(0);
  });

  it("walk: 肘部微屈并随摆臂开合（前摆收紧、后摆打开）", () => {
    const t = timeForLeftPhase(Math.PI / 2, "x");
    const o = computeMotionOverrides({ motion: WALK, time: t, characterId: "x" });

    // θL=π/2：左臂后摆（肘打开 6°），右臂前摆（肘收紧 18°）；中心 12° ± 6°
    expect((o["leftElbow.bend"] as number) * 180 / Math.PI).toBeCloseTo(6);
    expect((o["rightElbow.bend"] as number) * 180 / Math.PI).toBeCloseTo(18);
    expect(o).toHaveProperty("torso.yaw");
  });

  it("walk: 臂与对侧腿同相（正值=前摆；左臂随右腿，不顺拐）", () => {
    const t = timeForLeftPhase(Math.PI / 2, "x");
    const o = computeMotionOverrides({ motion: WALK, time: t, characterId: "x" });

    // 左腿前摆（+25）→ 左臂后摆（-16）、右臂前摆（+24），对侧摆动
    expect((o["leftShoulder.pitch"] as number) * 180 / Math.PI).toBeCloseTo(-16);
    expect((o["rightShoulder.pitch"] as number) * 180 / Math.PI).toBeCloseTo(24);
  });

  it("run: 前倾 -11°、肩对称摆 ±36°+微内旋 8°+贴身外展、屈肘明显", () => {
    const t = timeForRunLeftPhase(0, "x");
    const o = computeMotionOverrides({ motion: RUN, time: t, characterId: "x" });

    // 摆动中期（θarm 中点）肘角 55°（区间中点）
    expect((o["leftElbow.bend"] as number) * 180 / Math.PI).toBeCloseTo(55);
    // 肩部：对称摆幅 ±36°，中心 0（此刻两臂都过中点）
    expect((o["leftShoulder.pitch"] as number) * 180 / Math.PI).toBeCloseTo(0);
    // 上臂微内旋 8°
    expect((o["leftShoulder.twist"] as number) * 180 / Math.PI).toBeCloseTo(8);
    expect((o["rightShoulder.twist"] as number) * 180 / Math.PI).toBeCloseTo(8);
    // 双臂贴身：微外展 8°（左右符号镜像）
    expect((o["leftShoulder.spread"] as number) * 180 / Math.PI).toBeCloseTo(-8);
    expect((o["rightShoulder.spread"] as number) * 180 / Math.PI).toBeCloseTo(8);
    // 身体前倾为负值方向，中心 -14° ± 2° 起伏
    const bodyPitchDeg = (o["body.pitch"] as number) * 180 / Math.PI;
    expect(bodyPitchDeg).toBeLessThan(-12);
    expect(bodyPitchDeg).toBeGreaterThan(-16);
    // 腕部微屈（握拳近似）
    expect((o["leftHand.pitch"] as number) * 180 / Math.PI).toBeCloseTo(12);
    // 摆动中期膝峰 90°（跑步小腿折叠）
    expect((o["leftKnee.bend"] as number) * 180 / Math.PI).toBeCloseTo(90);
  });

  it("run: 肘部在 48°~62° 区间开合（前摆收紧、后摆稍开），肩前 +36 后 -36", () => {
    // θL=π/2：左腿前摆 → 左臂后摆（肘 48），右臂前摆（肘收紧 62）
    const t = timeForRunLeftPhase(Math.PI / 2, "x");
    const o = computeMotionOverrides({ motion: RUN, time: t, characterId: "x" });

    expect((o["leftElbow.bend"] as number) * 180 / Math.PI).toBeCloseTo(48);
    expect((o["rightElbow.bend"] as number) * 180 / Math.PI).toBeCloseTo(62);
    // 肩摆（正=前摆）：右臂随左腿对侧前摆到 +36，左臂后摆到 -36 —— 对侧，不顺拐
    expect((o["rightShoulder.pitch"] as number) * 180 / Math.PI).toBeCloseTo(36);
    expect((o["leftShoulder.pitch"] as number) * 180 / Math.PI).toBeCloseTo(-36);
    // 腿摆幅加大：左髋前摆峰值 52°，右髋同时后摆 -26°
    expect((o["leftHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(52);
    expect((o["rightHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(-26);
    // 跑姿前摆腿保持屈膝：腿到最前时膝 55°（不是走路的伸直 0°）
    expect((o["leftKnee.bend"] as number) * 180 / Math.PI).toBeCloseTo(55);
  });

  it("walk respects amplitude multiplier", () => {
    const strong: CharacterMotionState = { ...WALK, amplitude: 1.5 };
    const mild = computeMotionOverrides({ motion: WALK, time: 0.25, characterId: "x" });
    const big = computeMotionOverrides({ motion: strong, time: 0.25, characterId: "x" });
    // amplitude 是纯乘子
    expect((big["leftHip.pitch"] as number) / (mild["leftHip.pitch"] as number)).toBeCloseTo(1.5);
  });

  it("walk respects speed multiplier", () => {
    const fast: CharacterMotionState = { ...WALK, speed: 2 };
    const slow = computeMotionOverrides({ motion: WALK, time: 0.25, characterId: "x" });
    const quick = computeMotionOverrides({ motion: fast, time: 0.125, characterId: "x" });
    // speed=2, t=0.125 等价于 speed=1, t=0.25
    expect(quick["leftHip.pitch"] as number).toBeCloseTo(slow["leftHip.pitch"] as number);
  });

  it("walk covers expected joint keys", () => {
    const overrides = computeMotionOverrides({ motion: WALK, time: 0.5, characterId: "char_42" });
    const keys = new Set(Object.keys(overrides));
    for (const expected of [
      "leftHip.pitch",
      "rightHip.pitch",
      "leftKnee.bend",
      "rightKnee.bend",
      "leftShoulder.pitch",
      "rightShoulder.pitch",
      "leftElbow.bend",
      "rightElbow.bend",
      "torso.yaw",
    ]) {
      expect(keys).toContain(expected);
    }
    // 所有覆盖的键必须在 MOTION_DRIVEN_CONTROL_KEYS 中
    for (const k of keys) {
      expect(MOTION_DRIVEN_CONTROL_KEYS.has(k)).toBe(true);
    }
  });

  it("left and right hips are 180° out of phase (asymmetric swing: forward 25° / backward 12°)", () => {
    // θL=π/2：左髋前摆峰值 25°，右髋（θR=θL+π）同时到达后摆峰值 -12°
    const t = timeForLeftPhase(Math.PI / 2, "char_42");
    const o = computeMotionOverrides({ motion: WALK, time: t, characterId: "char_42" });
    expect((o["leftHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(25);
    expect((o["rightHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(-12);

    // 半周期后左右互换（真正的 180° 反相验证）
    const tHalf = timeForLeftPhase(Math.PI / 2 + Math.PI, "char_42");
    const oHalf = computeMotionOverrides({ motion: WALK, time: tHalf, characterId: "char_42" });
    expect((oHalf["leftHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(-12);
    expect((oHalf["rightHip.pitch"] as number) * 180 / Math.PI).toBeCloseTo(25);
  });

  it("different character ids produce different phase offsets", () => {
    const a = computeMotionOverrides({ motion: WALK, time: 0.3, characterId: "char_a" });
    const b = computeMotionOverrides({ motion: WALK, time: 0.3, characterId: "char_b" });
    // 群体里不同个体不应齐刷刷
    expect(a["leftHip.pitch"]).not.toBeCloseTo(b["leftHip.pitch"] as number);
  });

  it("returns empty override for non-finite time", () => {
    expect(computeMotionOverrides({ motion: WALK, time: Number.NaN, characterId: "x" })).toEqual({});
    expect(computeMotionOverrides({ motion: WALK, time: Number.POSITIVE_INFINITY, characterId: "x" })).toEqual({});
  });
});

describe("applyMotionOverrides", () => {
  it("returns the same controls reference when nothing is overridden", () => {
    const controls = { "head.yaw": 5 };
    expect(
      applyMotionOverrides(controls, { motion: null, time: 1, characterId: "x" })
    ).toBe(controls);
    expect(
      applyMotionOverrides(controls, { motion: { ...WALK, kind: "none" }, time: 1, characterId: "x" })
    ).toBe(controls);
  });

  it("分层合并：动作角度 + controls 偏移（度数域）", () => {
    const controls = { "head.yaw": 5, "leftHip.pitch": 3 };
    const merged = applyMotionOverrides(controls, { motion: WALK, time: 0.25, characterId: "x" });
    const expected = computeMotionOverrides({ motion: WALK, time: 0.25, characterId: "x" });

    expect(merged).not.toBe(controls);
    expect(merged["head.yaw"]).toBe(5); // 动作未驱动的关节原样保留
    // 动作驱动的关节 = 动作角度 + controls 偏移
    expect(merged["leftHip.pitch"]).toBeCloseTo(3 + ((expected["leftHip.pitch"] as number) * 180) / Math.PI);
  });

  it("偏移微调示例：髋 +10° 偏移叠加在动作循环之上", () => {
    const base = computeMotionOverrides({ motion: WALK, time: 0.25, characterId: "x" });
    const offsetDeg = 10;
    const merged = applyMotionOverrides(
      { "leftHip.pitch": offsetDeg },
      { motion: WALK, time: 0.25, characterId: "x" }
    );

    expect(merged["leftHip.pitch"]).toBeCloseTo(offsetDeg + ((base["leftHip.pitch"] as number) * 180) / Math.PI);
  });
});

describe("hashIdToPhase", () => {
  it("produces a value in [0, 2π)", () => {
    for (const id of ["a", "char_1", "long-character-id-123", "中文-id-也-ok"]) {
      const p = hashIdToPhase(id);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThan(Math.PI * 2);
    }
  });

  it("is deterministic", () => {
    expect(hashIdToPhase("foo")).toBe(hashIdToPhase("foo"));
  });

  it("different ids yield different phases in general", () => {
    const phases = new Set(["a", "b", "c", "d", "e", "f"].map(hashIdToPhase));
    expect(phases.size).toBeGreaterThan(4);
  });
});