/**
 * 泊车规划：一键自动泊入、一键倒出、NPC 进出营地路线。
 * 所有路径只由“≥ 最小转弯半径的圆弧 + 直线”组成，并逐点做车身碰撞检查：
 * 规划成功 ⇔ 存在一条玩家用同一套操控也能开出来的、不穿车不穿岛的路径（GPT 6612137921 D2-3）。
 */
import { GATE, loopLength, loopPose, nearestLoopS, parkedCenter, ROAD, WORLD, type Stall } from './camp';
import { dubinsAll, sampleDubins } from './dubins';
import { firstHit, type Shape } from './geom2d';
import { footprint, minRearAxleRadius, poseFromCenter, type Pose, type VehicleSpec } from './kinematics';

export interface PathPose extends Pose {
  /** +1 前进，−1 倒车 */
  dir: 1 | -1;
}

export interface PlanResult {
  ok: boolean;
  path: PathPose[];
  length: number;
  /** 失败原因（给玩家看的提示） */
  reason?: string;
}

const STEP = 0.25;
/** 碰撞检查时车身外扩 5 cm，规划出的路径对障碍物留有余量 */
const CLEAR_PAD = 0.05;
/** 规划用半径比满舵大 5%：自动泊入不贴着极限打方向 */
const R_MARGIN = 1.05;

/** 停好时的后轴位姿 */
export function parkedPose(s: VehicleSpec, stall: Stall): Pose {
  const [cx, cy] = parkedCenter(stall);
  return poseFromCenter(s, cx, cy, stall.yaw);
}

function back(p: Pose, d: number): Pose {
  return { x: p.x - d * Math.cos(p.yaw), y: p.y - d * Math.sin(p.yaw), yaw: p.yaw };
}

function straight(from: Pose, dist: number, dir: 1 | -1): PathPose[] {
  const n = Math.max(1, Math.ceil(Math.abs(dist) / STEP));
  const out: PathPose[] = [];
  for (let i = 0; i <= n; i++) {
    const d = (dist * i) / n;
    out.push({ x: from.x + d * Math.cos(from.yaw), y: from.y + d * Math.sin(from.yaw), yaw: from.yaw, dir });
  }
  return out;
}

export function pathCollides(s: VehicleSpec, path: Pose[], obstacles: Shape[]): Shape | null {
  for (const p of path) {
    const hit = firstHit(footprint(s, p, CLEAR_PAD), obstacles);
    if (hit) return hit;
  }
  return null;
}

/**
 * 半径倍数：先试接近满舵，碰撞再放大半径。
 * 原因：急转时车头外角半径 = √((Rr + W/2)² + (L + 前悬)²)，前悬长的房车外角会甩出车道；
 * 半径放大后外角相对车道中心线的外摆量变小（见 docs/SWEPT_PATH.md）。
 */
const R_MULTS = [R_MARGIN, 1.5, 2, 3];

/** 从起点用 Dubins 接到目标位姿；按半径从小到大、同半径内按长度从短到长尝试，返回第一条不碰撞的 */
function connect(s: VehicleSpec, from: Pose, to: Pose, obstacles: Shape[], maxLen = Infinity): PathPose[] | null {
  const r0 = minRearAxleRadius(s);
  for (const m of R_MULTS) {
    for (const d of dubinsAll(from, to, r0 * m)) {
      if (d.length > maxLen) break;
      const pts = sampleDubins(d, STEP).map((p) => ({ ...p, dir: 1 as const }));
      if (!pathCollides(s, pts, obstacles)) return pts;
    }
  }
  return null;
}

function pathLength(path: Pose[]): number {
  let l = 0;
  for (let i = 1; i < path.length; i++) l += Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
  return l;
}

/** 沿环路中心线从弧长 s0 前进 len 米的采样 */
export function loopSamples(s0: number, len: number): PathPose[] {
  const n = Math.max(1, Math.ceil(len / STEP));
  const out: PathPose[] = [];
  for (let i = 0; i <= n; i++) out.push({ ...loopPose(s0 + (len * i) / n), dir: 1 });
  return out;
}

/** 车位口在环路中心线上的投影弧长 */
function stallLoopS(stall: Stall): number {
  return nearestLoopS(stall.mouth[0], stall.mouth[1]);
}

/**
 * 车头入位：Dubins 接到“入位前位姿”（停好位姿沿轴线后退一个车长），再直线开进去。
 * 直接从当前位置规划不通时，再尝试先沿环路开到车位上游的若干分支点。
 */
export function planParkIn(s: VehicleSpec, from: Pose, stall: Stall, obstacles: Shape[]): PlanResult {
  const goal = parkedPose(s, stall);
  const pre = back(goal, s.lengthM);
  const tail = straight(pre, s.lengthM, 1);
  if (pathCollides(s, tail, obstacles)) {
    return { ok: false, path: [], length: 0, reason: `${stall.label}被占用或有障碍` };
  }
  const sMouth = stallLoopS(stall);
  const L = loopLength();
  // 分支点 → 入位前位姿：与起点无关，先算好
  const branches: Array<{ sBranch: number; c: PathPose[] }> = [];
  for (const off of [6, 9, 12, 16]) {
    const c = connect(s, loopPose(sMouth - off), pre, obstacles, 40);
    if (c) branches.push({ sBranch: sMouth - off, c });
  }

  /** 从 start 出发：直接接入位前位姿；或接上环路中心线 → 沿环路 → 分支点 → 入位前位姿 */
  const fromPose = (start: Pose): PathPose[] | null => {
    const direct = connect(s, start, pre, obstacles, 60);
    if (direct) return direct;
    const sFrom = nearestLoopS(start.x, start.y);
    for (const joinOff of [4, 8, 12]) {
      const sJoin = sFrom + joinOff;
      const a = connect(s, start, loopPose(sJoin), obstacles, 40);
      if (!a) continue;
      for (const { sBranch, c } of branches) {
        let along = (((sBranch - sJoin) % L) + L) % L;
        if (along < 1) along += L; // 已经过了分支点就再绕一圈
        const b = loopSamples(sJoin, along);
        if (!pathCollides(s, b, obstacles)) return [...a, ...b, ...c];
      }
    }
    return null;
  };

  // 起点不顺（贴着路缘、朝向偏）时，先直线倒车 3 / 6 m 再规划
  for (const rev of [0, 3, 6]) {
    let prefix: PathPose[] = [];
    let start: Pose = from;
    if (rev > 0) {
      prefix = straight(from, -rev, -1);
      if (pathCollides(s, prefix, obstacles)) break;
      const e = prefix[prefix.length - 1];
      start = { x: e.x, y: e.y, yaw: e.yaw };
    }
    const p = fromPose(start);
    if (p) {
      const path = [...prefix, ...p, ...tail];
      return { ok: true, path, length: pathLength(path) };
    }
  }
  if (againstLoop(from)) {
    return { ok: false, path: [], length: 0, reason: '车头和单行环路方向相反，自动泊车只会顺行：请先掉头（倒车 + 打方向）再试' };
  }
  return { ok: false, path: [], length: 0, reason: '附近没有可行路线，请沿环路开到车位前方再试' };
}

/** 车头是否与最近处的环路行驶方向相反（夹角 > 107°） */
export function againstLoop(p: Pose): boolean {
  const lp = loopPose(nearestLoopS(p.x, p.y));
  return Math.cos(p.yaw - lp.yaw) < -0.3;
}

/** 倒出：沿车位轴线直线倒车，直到车头离开车位口 0.3 m */
export function planReverseOut(s: VehicleSpec, stall: Stall, obstacles: Shape[]): PlanResult {
  const goal = parkedPose(s, stall);
  const d = stall.length / 2 + s.lengthM / 2 + 0.3;
  const path = straight(goal, -d, -1);
  const hit = pathCollides(s, path, obstacles);
  if (hit) return { ok: false, path: [], length: 0, reason: '车后方有障碍，无法倒出' };
  return { ok: true, path, length: d };
}

/** 大门位姿：入场（车头朝北）与离场（车头朝南） */
export const GATE_IN: Pose = { x: GATE.x, y: WORLD.minY + 2, yaw: Math.PI / 2 };
export const GATE_OUT: Pose = { x: GATE.x, y: WORLD.minY + 2, yaw: -Math.PI / 2 };

/** NPC 入场：大门 → 并入环路下段 → 逆时针绕到车位上游 → 入位 */
export function planNpcArrival(s: VehicleSpec, stall: Stall, obstacles: Shape[]): PlanResult {
  const sJoin = GATE.x + 8 + ROAD.halfStraight; // 下段 x = GATE.x + 8
  const a = connect(s, GATE_IN, loopPose(sJoin), obstacles);
  if (!a) return { ok: false, path: [], length: 0, reason: 'NPC 无法从大门并入环路' };
  const L = loopLength();
  const sMouth = stallLoopS(stall);
  const goal = parkedPose(s, stall);
  const pre = back(goal, s.lengthM);
  const tail = straight(pre, s.lengthM, 1);
  if (pathCollides(s, tail, obstacles)) return { ok: false, path: [], length: 0, reason: 'NPC 目标车位被占用或有障碍' };
  for (const off of [6, 9, 12, 16]) {
    const sBranch = sMouth - off;
    const along = (((sBranch - sJoin) % L) + L) % L;
    const b = loopSamples(sJoin, along);
    if (pathCollides(s, b, obstacles)) continue; // 环路段同样要查
    const c = connect(s, loopPose(sBranch), pre, obstacles, 40);
    if (!c) continue;
    const path = [...a, ...b, ...c, ...tail];
    // 成功前对完整拼接路径再查一遍：返回 ok ⇒ 全程无碰撞
    if (!pathCollides(s, path, obstacles)) return { ok: true, path, length: pathLength(path) };
  }
  return { ok: false, path: [], length: 0, reason: 'NPC 无可行入位路线' };
}

/** NPC 离场：倒出 → 并入环路 → 沿环路开到大门西侧 → 右转出大门 */
export function planNpcDeparture(s: VehicleSpec, stall: Stall, obstacles: Shape[]): PlanResult {
  const out = planReverseOut(s, stall, obstacles);
  if (!out.ok) return out;
  const last = out.path[out.path.length - 1];
  const L = loopLength();
  const sOut = nearestLoopS(last.x, last.y) + 8;
  const join = connect(s, { x: last.x, y: last.y, yaw: last.yaw }, loopPose(sOut), obstacles);
  if (!join) return { ok: false, path: [], length: 0, reason: 'NPC 倒出后无法并回环路' };
  const sExit = GATE.x - 10 + ROAD.halfStraight; // 下段 x = GATE.x − 10
  const along = (((sExit - sOut) % L) + L) % L;
  const b = loopSamples(sOut, along);
  if (pathCollides(s, b, obstacles)) return { ok: false, path: [], length: 0, reason: 'NPC 离场环路上有障碍' };
  const c = connect(s, loopPose(sExit), GATE_OUT, obstacles);
  if (!c) return { ok: false, path: [], length: 0, reason: 'NPC 无法驶出大门' };
  const path = [...out.path, ...join, ...b, ...c];
  if (pathCollides(s, path, obstacles)) return { ok: false, path: [], length: 0, reason: 'NPC 离场路线有障碍' };
  return { ok: true, path, length: pathLength(path) };
}
