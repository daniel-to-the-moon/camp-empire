/**
 * 自家营地布局（M1 有界连续区域）。单位米，数学平面系（x 东、y 北）。
 *
 *   ┌─────────── 围栏 ───────────┐
 *   │   [p1][p2][p3][爱心]        │  ← 斜 45° 车头入位，位于环路外侧（右侧通行的右手边）
 *   │  ←←←←←←← 环路上段 ←←←←←←←  │
 *   │ ↓      ( 篝火岛 )        ↑  │  ← 单向逆时针环路，车不需要掉头（#1 D2）
 *   │  →→→ 环路下段 →→→→→→→→→→  │
 *   │     ‖大门        [家位]     │  ← 家位：玩家自己的车，不出租（#1 E4 建议）；宽度够展开侧边帐
 *   └─────‖──────────────────────┘
 *
 * 尺寸来源：
 * - 车位 2.943 × 7.005 m：#1 讨论中 GPT 复算通过（主角车 2.343 宽每侧 0.3 m、6.005 长纵向余 1.0 m）；
 * - 家位宽 5.44 m：#1 讨论“营地位宽 ≈ 2.343 + 2.5 + 0.6”【假设】；
 * - 环路半径、路宽：【提案】，由 tests/camp.test.ts 用全部 25 个变体的扫掠包络与入位路径验证。
 */
import { SIDE_AWNING } from './config';
import { rect, type Pt, type Shape } from './geom2d';
import type { Pose } from './kinematics';
import type { SpotKind } from './npc';

export const ROAD = {
  /** 直线段半长 */
  halfStraight: 15,
  /** 环路中心线半径（两端半圆） */
  centerR: 9,
  width: 5.6,
} as const;

export const STALL = { length: 7.005, width: 2.943 } as const;
export const HOME = { length: 8.0, width: 5.44 } as const;

export const WORLD = { minX: -34, maxX: 34, minY: -40, maxY: 26 } as const;

/** 大门道路：从南边界向北接入环路下段 */
export const GATE = { x: -8, width: 5.6 } as const;

export interface Stall {
  id: string;
  label: string;
  kind: SpotKind | 'home';
  /** 车位矩形中心与车头朝向（车头朝里） */
  cx: number;
  cy: number;
  yaw: number;
  length: number;
  width: number;
  /** 停好时车身中心相对车位中心的横向偏移（家位：车靠左，右侧留给侧边帐） */
  carLateral: number;
  /** 车位口外 0.5 m、对准车位轴线的“入口位姿”所在点（车身前端到此即开始直线入位） */
  mouth: Pt;
  /** 对应环路直线段的行驶朝向（入位前的来车方向） */
  approachYaw: number;
  /** 车位口所在的路缘 y */
  edgeY: number;
}

const innerEdge = ROAD.centerR - ROAD.width / 2;
const outerEdge = ROAD.centerR + ROAD.width / 2;

function makeStall(
  id: string,
  label: string,
  kind: Stall['kind'],
  mouthX: number,
  top: boolean,
  size: { length: number; width: number },
  carLateral: number,
): Stall {
  // 上段来车朝 −x（yaw = π），右手边是 +y；下段来车朝 +x（yaw = 0），右手边是 −y
  const approachYaw = top ? Math.PI : 0;
  // 车位轴线 = 来车方向向右偏 45°（车头入位时只需右转 45°）
  const yaw = approachYaw - Math.PI / 4;
  const ax = Math.cos(yaw);
  const ay = Math.sin(yaw);
  const edgeY = top ? outerEdge : -outerEdge;
  // 车位口中点：让靠近路面的那个口角正好落在路缘上
  const halfMouthDy = (size.width / 2) * Math.abs(Math.cos(yaw));
  const my = edgeY + (top ? halfMouthDy : -halfMouthDy);
  const mouth: Pt = [mouthX, my];
  return {
    id,
    label,
    kind,
    cx: mouthX + ax * (size.length / 2),
    cy: my + ay * (size.length / 2),
    yaw,
    length: size.length,
    width: size.width,
    carLateral,
    mouth,
    approachYaw,
    edgeY,
  };
}

/** 上段 4 个车位，沿路缘间距 = 车位宽 / sin45° ≈ 4.162 m，互不重叠 */
const pitchX = STALL.width / Math.sin(Math.PI / 4);
/**
 * 家位里车身靠左停，右侧（滑门侧）留给侧边帐。以最宽车 2.343 m 计，横向偏移 L 需满足：
 * 帐篷外沿 L − 1.1715 − 2.5 ≥ −2.72（不出家位）且车左沿 L + 1.1715 ≤ 2.72 − 0.3（左侧留 0.3 m）
 * → 0.95 ≤ L ≤ 1.25，取 1.1。
 */
const MAX_CAR_W = 2.343;
const homeLateral = 1.1;
if (homeLateral - MAX_CAR_W / 2 - SIDE_AWNING.depthM < -HOME.width / 2 || homeLateral + MAX_CAR_W / 2 > HOME.width / 2 - 0.3) {
  throw new Error('家位宽度不足以容纳最宽车 + 侧边帐');
}

export const STALLS: Stall[] = [
  makeStall('p1', '1 号私家车位', 'private', 10, true, STALL, 0),
  makeStall('p2', '2 号私家车位', 'private', 10 - pitchX, true, STALL, 0),
  makeStall('p3', '3 号私家车位', 'private', 10 - 2 * pitchX, true, STALL, 0),
  makeStall('love', '爱心车位', 'love', 10 - 3 * pitchX, true, STALL, 0),
  makeStall('home', '家位', 'home', 5, false, HOME, homeLateral),
];

export const RENTAL_SPOTS = STALLS.filter((s) => s.kind !== 'home').map((s) => ({ id: s.id, kind: s.kind as SpotKind }));

export function stallById(id: string): Stall {
  const s = STALLS.find((x) => x.id === id);
  if (!s) throw new Error(`no stall ${id}`);
  return s;
}

export function stallRect(s: Stall): Pt[] {
  return rect(s.cx, s.cy, s.yaw, s.length, s.width);
}

/** 停好时车身中心（世界坐标）：车位中心 + 横向偏移（左为正） */
export function parkedCenter(s: Stall): Pt {
  return [s.cx - Math.sin(s.yaw) * s.carLateral, s.cy + Math.cos(s.yaw) * s.carLateral];
}

/** 环路中心线上的位姿（逆时针，s 为从下段 x = −halfStraight 起算的弧长） */
export function loopLength(): number {
  return 4 * ROAD.halfStraight + 2 * Math.PI * ROAD.centerR;
}

export function loopPose(s: number): Pose {
  const A = ROAD.halfStraight;
  const R = ROAD.centerR;
  const L = loopLength();
  let t = ((s % L) + L) % L;
  if (t < 2 * A) return { x: -A + t, y: -R, yaw: 0 };
  t -= 2 * A;
  if (t < Math.PI * R) {
    const a = -Math.PI / 2 + t / R;
    return { x: A + R * Math.cos(a), y: R * Math.sin(a), yaw: a + Math.PI / 2 };
  }
  t -= Math.PI * R;
  if (t < 2 * A) return { x: A - t, y: R, yaw: Math.PI };
  t -= 2 * A;
  const a = Math.PI / 2 + t / R;
  return { x: -A + R * Math.cos(a), y: R * Math.sin(a), yaw: a + Math.PI / 2 };
}

/** 中心线上距离点 (x, y) 最近的弧长（粗搜 + 细化） */
export function nearestLoopS(x: number, y: number): number {
  const L = loopLength();
  let best = 0;
  let bd = Infinity;
  for (let s = 0; s < L; s += 0.5) {
    const p = loopPose(s);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bd) {
      bd = d;
      best = s;
    }
  }
  return best;
}

/** 篝火岛：环路内侧路缘以内（直线段矩形 + 两端半圆） */
export function islandShapes(): Shape[] {
  const A = ROAD.halfStraight;
  return [
    { type: 'poly', pts: rect(0, 0, 0, 2 * A, 2 * innerEdge), tag: 'island' },
    { type: 'circle', c: [A, 0], r: innerEdge, tag: 'island' },
    { type: 'circle', c: [-A, 0], r: innerEdge, tag: 'island' },
  ];
}

/** 围栏（四面墙，南墙在大门处断开） */
export function fenceShapes(): Shape[] {
  const t = 1;
  const { minX, maxX, minY, maxY } = WORLD;
  const w = maxX - minX;
  const h = maxY - minY;
  const gl = GATE.x - GATE.width / 2 - minX;
  const gr = maxX - (GATE.x + GATE.width / 2);
  return [
    { type: 'poly', pts: rect((minX + maxX) / 2, maxY + t / 2, 0, w + 2 * t, t), tag: 'fence' },
    { type: 'poly', pts: rect(minX - t / 2, (minY + maxY) / 2, 0, t, h), tag: 'fence' },
    { type: 'poly', pts: rect(maxX + t / 2, (minY + maxY) / 2, 0, t, h), tag: 'fence' },
    { type: 'poly', pts: rect(minX + gl / 2, minY - t / 2, 0, gl, t), tag: 'fence' },
    { type: 'poly', pts: rect(maxX - gr / 2, minY - t / 2, 0, gr, t), tag: 'fence' },
  ];
}

/** 装饰树（碰撞为圆），避开路面、车位与大门道路 */
export const TREES: Array<{ x: number; y: number; r: number }> = [
  { x: -28, y: 20, r: 1.2 },
  { x: -22, y: 21, r: 1.0 },
  { x: 26, y: 20, r: 1.3 },
  { x: 29, y: 8, r: 1.1 },
  { x: 29, y: -6, r: 1.2 },
  { x: -29, y: -4, r: 1.0 },
  { x: -29, y: -22, r: 1.3 },
  { x: 20, y: -32, r: 1.2 },
  { x: 28, y: -24, r: 1.0 },
  { x: -20, y: -34, r: 1.1 },
];

export function treeShapes(): Shape[] {
  return TREES.map((t) => ({ type: 'circle' as const, c: [t.x, t.y] as Pt, r: t.r, tag: 'tree' }));
}

/** 静态障碍物（不含停着的车） */
export function staticShapes(): Shape[] {
  return [...islandShapes(), ...fenceShapes(), ...treeShapes()];
}

/** 玩家出生位姿：大门道路内，车头朝北 */
export const SPAWN: Pose = { x: GATE.x, y: WORLD.minY + 8, yaw: Math.PI / 2 };
