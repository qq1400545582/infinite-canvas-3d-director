import type { CharacterMotionState, MotionKind } from "../../schema/directorProject";

/**
 * 基础动作关节驱动
 *
 * 接受 motion 配置 + 时间 t（秒）+ character id，返回一组「关节角覆盖」。
 * 返回的对象只包含被动作驱动的键；调用方应当把它放在 rigState.controls **之上**进行合并。
 *
 * 设计要点：
 * - 纯函数：可在测试里直接断言 t=0 / π/2 / π 时的输出
 * - phase 偏移：根据 characterId 哈希成 0 – 2π 的常数偏移，让群体里不同个体不齐刷刷
 * - 不直接依赖 store / playbackStore / R3F，方便单测
 */

export type MotionOverride = Partial<Record<string, number>>;

export interface MotionParams {
  motion: CharacterMotionState | null | undefined;
  /** 全局时间（秒），通常 = playbackStore.playhead */
  time: number;
  /** 用于产生 phase 偏移的稳定 id（一般是 directorObject.id） */
  characterId: string;
}

const DEFAULT_MOTION: CharacterMotionState = {
  kind: "none",
  speed: 1,
  amplitude: 1,
  enabled: true,
};

function normalizeMotion(motion: CharacterMotionState | null | undefined): CharacterMotionState {
  if (!motion) return DEFAULT_MOTION;
  return {
    kind: motion.kind ?? "none",
    speed: typeof motion.speed === "number" ? motion.speed : 1,
    amplitude: typeof motion.amplitude === "number" ? motion.amplitude : 1,
    enabled: motion.enabled !== false,
  };
}

/** 把任意 string hash 成 [0, 2π) 的浮点。FNV-1a 足够稳定。 */
export function hashIdToPhase(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  // 映射到 [0, 2π)
  return ((hash >>> 0) / 0xffffffff) * Math.PI * 2;
}

function degreesToRadians(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 跑步相对走路的基础频率倍数：真人跑步步频更快（周期 ≈ 0.67s @speed=1，走路 1s）。 */
export const RUN_FREQUENCY_MULTIPLIER = 1.5;

/** 单腿/单臂的相位：左 0、右 π（与左反相）。 */
function leftPhase(omegaT: number): number {
  return omegaT;
}
function rightPhase(omegaT: number): number {
  return omegaT + Math.PI;
}

/**
 * 腿/臂的相位语义（θ 为该肢相位）：
 * - 髋 hip = f(sin θ)：θ=π/2 腿摆到最前（脚跟着地），θ=3π/2 最后（蹬离）
 * - 膝 knee ∝ max(0, cos θ)：cos>0 = 摆动期（腿从后往前扫），θ=0 为摆动中期膝峰；
 *   θ=π/2 着地时 cos=0 → 膝伸直 —— 这是自然步态与"正步走"的关键区别
 * - 摆幅不对称：前摆大、后摆小（真人步态如此）
 */
function swingHip(forwardDeg: number, backDeg: number, amp: number, theta: number): number {
  const s = Math.sin(theta);
  return (s >= 0 ? forwardDeg * s : backDeg * s) * amp;
}

function swingKnee(peakDeg: number, amp: number, theta: number): number {
  return peakDeg * amp * Math.max(0, Math.cos(theta));
}

/** 跑步膝部曲线（与走路不同：跑姿全程屈膝，不伸直锁死）：
 *  - 基础 baseDeg：支撑期也保持微弯（吸收冲击）
 *  - 前摆加弯 frontDeg：腿摆到最前（θ=π/2）= base+front（脚掌着地屈膝）
 *  - 折叠 foldDeg：摆动中期（θ=0）小腿收起达折叠峰 */
function runKnee(baseDeg: number, frontDeg: number, foldDeg: number, amp: number, theta: number): number {
  const front = Math.max(0, Math.sin(theta)) * frontDeg;
  const fold = Math.max(0, Math.cos(theta)) * foldDeg;
  return (baseDeg + front + fold) * amp;
}

function swingShoulder(forwardDeg: number, backDeg: number, amp: number, theta: number): number {
  const s = Math.sin(theta);
  return (s >= 0 ? forwardDeg * s : backDeg * s) * amp;
}

/** 计算 idle / walk / run 的关节覆盖；none / 禁用 / 异常输入返回空对象。 */
export function computeMotionOverrides({ motion, time, characterId }: MotionParams): MotionOverride {
  const m = normalizeMotion(motion);
  if (!m.enabled) return {};
  if (m.kind === "none") return {};
  if (!Number.isFinite(time)) return {};

  const phase = hashIdToPhase(characterId);
  const omegaT = time * m.speed * Math.PI * 2 + phase;
  const L = leftPhase(omegaT);
  const R = rightPhase(omegaT);

  if (m.kind === "idle") {
    // 当前 MVP 只保留接口：闲置无明显关节驱动。
    // 后续阶段会接入轻微呼吸/眨眼。
    return {};
  }

  if (m.kind === "walk") {
    const amp = m.amplitude;
    return {
      // 髋：前摆 25° / 后摆 12°（正常步幅），左右反相
      "leftHip.pitch": degreesToRadians(swingHip(25, 12, amp, L)),
      "rightHip.pitch": degreesToRadians(swingHip(25, 12, amp, R)),
      // 膝：摆动中期峰 45°，着地/支撑期伸直
      "leftKnee.bend": degreesToRadians(swingKnee(45, amp, L)),
      "rightKnee.bend": degreesToRadians(swingKnee(45, amp, R)),
      // 臂与对侧腿同相（肩 pitch 正值=前摆，与髋同号；左臂随右腿）：前摆 24°、后摆 16°
      "leftShoulder.pitch": degreesToRadians(swingShoulder(24, 16, amp, R)),
      "rightShoulder.pitch": degreesToRadians(swingShoulder(24, 16, amp, L)),
      // 肘微屈并随摆臂开合：中心 12° ± 6°（前摆收紧 18°、后摆打开 6°）
      "leftElbow.bend": degreesToRadians((12 + 6 * Math.sin(R)) * amp),
      "rightElbow.bend": degreesToRadians((12 + 6 * Math.sin(L)) * amp),
      // 躯干与肩线反向微扭，让上半身有跟随感
      "torso.yaw": degreesToRadians(4 * amp * Math.sin(L)),
    };
  }

  if (m.kind === "run") {
    const amp = m.amplitude;
    // 跑步步频更快：独立相位（基础频率 × 1.5），speed 仍作乘数
    const runL = leftPhase(time * m.speed * RUN_FREQUENCY_MULTIPLIER * Math.PI * 2 + phase);
    const runR = rightPhase(runL);
    return {
      // 髋：跑步前摆更大 52° / 后摆 26°
      "leftHip.pitch": degreesToRadians(swingHip(52, 26, amp, runL)),
      "rightHip.pitch": degreesToRadians(swingHip(52, 26, amp, runR)),
      // 膝：跑姿全程屈膝 —— 基础 30°（支撑吸震）、前摆至最前 55°（脚掌着地屈膝）、摆动中期折叠峰 90°
      "leftKnee.bend": degreesToRadians(runKnee(30, 25, 60, amp, runL)),
      "rightKnee.bend": degreesToRadians(runKnee(30, 25, 60, amp, runR)),
      // 臂与对侧腿同相（肩 pitch 正值=前摆）：对称摆幅 ±36°（参考校准姿态：左 -36 / 右 +36 交替）
      "leftShoulder.pitch": degreesToRadians((36 * Math.sin(runR)) * amp),
      "rightShoulder.pitch": degreesToRadians((36 * Math.sin(runL)) * amp),
      // 上臂微内旋（前臂朝前）+ 微外展贴身，双臂不张开
      "leftShoulder.twist": degreesToRadians(8 * amp),
      "rightShoulder.twist": degreesToRadians(8 * amp),
      "leftShoulder.spread": degreesToRadians(-8 * amp),
      "rightShoulder.spread": degreesToRadians(8 * amp),
      // 肘部跑姿屈肘明显：中心 55° ± 7°（前摆收紧 62°、后摆打开 48°）
      "leftElbow.bend": degreesToRadians((55 + 7 * Math.sin(runR)) * amp),
      "rightElbow.bend": degreesToRadians((55 + 7 * Math.sin(runL)) * amp),
      // 腕部微屈内收：rig 无手指骨骼，用腕部张力近似"握拳"姿态
      "leftHand.pitch": degreesToRadians(12 * amp),
      "rightHand.pitch": degreesToRadians(12 * amp),
      // 躯干反扭更明显
      "torso.yaw": degreesToRadians(7 * amp * Math.sin(runL)),
      // 前倾 -14°（快跑水平）+ 步频两倍的上下起伏
      "body.pitch": degreesToRadians((-14 + 2 * Math.sin(runL * 2)) * amp),
    };
  }

  return {};
}

/** 把动作叠加进 controls（度数域，分层模型）。
 *  动作是基础层（优先级最高）；controls 里的值作为叠加偏移（微调层）：
 *  最终角度 = 动作角度 + controls[key]。动作未驱动的关节仍直接用 controls[key]。
 *  进动作时 controls 已被重置为站立（{}），因此偏移从干净状态开始累积。
 *  computeMotionOverrides 返回弧度；controls 全库统一用度数，这里做换算后相加。
 *  不做 clamp —— 两条渲染路径（ProceduralMannequin / UE4 rig）各自有关节限位逻辑。
 *  返回原对象引用当且仅当没有任何覆盖（便于跳过无谓重算）。 */
export function applyMotionOverrides(
  controls: Record<string, number>,
  params: MotionParams
): Record<string, number> {
  const overrides = computeMotionOverrides(params);
  if (Object.keys(overrides).length === 0) return controls;

  const next: Record<string, number> = { ...controls };
  for (const [key, radians] of Object.entries(overrides)) {
    if (typeof radians !== "number" || !Number.isFinite(radians)) continue;
    next[key] = (next[key] ?? 0) + (radians * 180) / Math.PI;
  }
  return next;
}

/** 给 UI 用的枚举列表（与 MotionKind 一一对应）。 */
export const MOTION_OPTIONS: { value: MotionKind; label: string }[] = [
  { value: "none", label: "无" },
  { value: "idle", label: "闲置" },
  { value: "walk", label: "走路" },
  { value: "run", label: "跑步" },
];

/** 走路/跑步驱动的关节键集合（文档性质：这些键的动作值会被 controls 偏移叠加）。 */
export const MOTION_DRIVEN_CONTROL_KEYS = new Set<string>([
  "leftHip.pitch",
  "rightHip.pitch",
  "leftKnee.bend",
  "rightKnee.bend",
  "leftShoulder.pitch",
  "rightShoulder.pitch",
  "leftShoulder.twist",
  "rightShoulder.twist",
  "leftShoulder.spread",
  "rightShoulder.spread",
  "leftElbow.bend",
  "rightElbow.bend",
  "leftHand.pitch",
  "rightHand.pitch",
  "torso.yaw",
  "body.pitch",
]);