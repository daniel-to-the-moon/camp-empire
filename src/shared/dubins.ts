/**
 * Dubins 曲线：只前进、曲率不超过 1/r 的最短路径（圆弧 + 直线 + 圆弧）。
 * 用于自动泊入与 NPC 入位：路径上任意一点的转弯半径 ≥ r，与玩家手动满舵能做到的一致。
 */
import type { Pose } from './kinematics';
import { wrapAngle } from './kinematics';

export type SegType = 'L' | 'S' | 'R';
export type Word = [SegType, SegType, SegType];

export interface DubinsPath {
  start: Pose;
  r: number;
  word: Word;
  /** 三段长度（米） */
  lens: [number, number, number];
  length: number;
}

const TAU = Math.PI * 2;
const mod2pi = (a: number) => ((a % TAU) + TAU) % TAU;

type Solver = (a: number, b: number, d: number) => [number, number, number] | null;

// 归一化参数 (alpha, beta, d) 下的六种解（LaValle《Planning Algorithms》15.3 节公式）
const SOLVERS: Record<string, Solver> = {
  LSL(a, b, d) {
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b));
    if (p2 < 0) return null;
    const tmp = Math.atan2(Math.cos(b) - Math.cos(a), d + Math.sin(a) - Math.sin(b));
    return [mod2pi(-a + tmp), Math.sqrt(p2), mod2pi(b - tmp)];
  },
  RSR(a, b, d) {
    const p2 = 2 + d * d - 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a));
    if (p2 < 0) return null;
    const tmp = Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b));
    return [mod2pi(a - tmp), Math.sqrt(p2), mod2pi(-b + tmp)];
  },
  LSR(a, b, d) {
    const p2 = -2 + d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) + Math.sin(b));
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const tmp = Math.atan2(-Math.cos(a) - Math.cos(b), d + Math.sin(a) + Math.sin(b)) - Math.atan2(-2, p);
    return [mod2pi(-a + tmp), p, mod2pi(-mod2pi(b) + tmp)];
  },
  RSL(a, b, d) {
    const p2 = d * d - 2 + 2 * Math.cos(a - b) - 2 * d * (Math.sin(a) + Math.sin(b));
    if (p2 < 0) return null;
    const p = Math.sqrt(p2);
    const tmp = Math.atan2(Math.cos(a) + Math.cos(b), d - Math.sin(a) - Math.sin(b)) - Math.atan2(2, p);
    return [mod2pi(a - tmp), p, mod2pi(b - tmp)];
  },
  RLR(a, b, d) {
    const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(a) - Math.sin(b))) / 8;
    if (Math.abs(tmp) > 1) return null;
    const p = mod2pi(TAU - Math.acos(tmp));
    const t = mod2pi(a - Math.atan2(Math.cos(a) - Math.cos(b), d - Math.sin(a) + Math.sin(b)) + p / 2);
    return [t, p, mod2pi(a - b - t + p)];
  },
  LRL(a, b, d) {
    const tmp = (6 - d * d + 2 * Math.cos(a - b) + 2 * d * (Math.sin(b) - Math.sin(a))) / 8;
    if (Math.abs(tmp) > 1) return null;
    const p = mod2pi(TAU - Math.acos(tmp));
    const t = mod2pi(-a - Math.atan2(Math.cos(a) - Math.cos(b), d + Math.sin(a) - Math.sin(b)) + p / 2);
    return [t, p, mod2pi(mod2pi(b) - a - t + p)];
  },
};

/** 全部可行解，按长度升序（规划器可在最短解碰撞时退而求其次） */
export function dubinsAll(q0: Pose, q1: Pose, r: number): DubinsPath[] {
  const dx = q1.x - q0.x;
  const dy = q1.y - q0.y;
  const d = Math.hypot(dx, dy) / r;
  const th = mod2pi(Math.atan2(dy, dx));
  const a = mod2pi(q0.yaw - th);
  const b = mod2pi(q1.yaw - th);
  const out: DubinsPath[] = [];
  for (const [name, fn] of Object.entries(SOLVERS)) {
    const sol = fn(a, b, d);
    if (!sol) continue;
    const lens = sol.map((v) => v * r) as [number, number, number];
    out.push({ start: q0, r, word: name.split('') as Word, lens, length: lens[0] + lens[1] + lens[2] });
  }
  return out.sort((p, q) => p.length - q.length);
}

function advance(p: Pose, t: SegType, s: number, r: number): Pose {
  if (t === 'S') return { x: p.x + s * Math.cos(p.yaw), y: p.y + s * Math.sin(p.yaw), yaw: p.yaw };
  const sign = t === 'L' ? 1 : -1;
  const dyaw = (sign * s) / r;
  const cx = p.x - sign * r * Math.sin(p.yaw);
  const cy = p.y + sign * r * Math.cos(p.yaw);
  const yaw = p.yaw + dyaw;
  return { x: cx + sign * r * Math.sin(yaw), y: cy - sign * r * Math.cos(yaw), yaw: wrapAngle(yaw) };
}

/** 路径上弧长 s 处的位姿 */
export function dubinsAt(path: DubinsPath, s: number): Pose {
  let p = path.start;
  let rem = Math.max(0, Math.min(s, path.length));
  for (let i = 0; i < 3; i++) {
    const seg = Math.min(rem, path.lens[i]);
    p = advance(p, path.word[i], seg, path.r);
    rem -= seg;
    if (rem <= 0) break;
  }
  return p;
}

/** 按步长采样 */
export function sampleDubins(path: DubinsPath, step: number): Pose[] {
  const n = Math.max(1, Math.ceil(path.length / step));
  const out: Pose[] = [];
  for (let i = 0; i <= n; i++) out.push(dubinsAt(path, (path.length * i) / n));
  return out;
}

/** 该路径每段的曲率（L = +1/r，R = −1/r，S = 0），用于测试“不超过满舵” */
export function segCurvatures(path: DubinsPath): number[] {
  return path.word.map((w) => (w === 'S' ? 0 : (w === 'L' ? 1 : -1) / path.r));
}
