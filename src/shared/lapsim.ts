/**
 * 环路圈速仿真（issue #44 基线实测用）。与游戏用同一个 stepDrive / resolveDrive（同一套运动学、碰撞），
 * 由一个纯追踪（pure pursuit）驾驶员沿环路中心线逆时针开，油门踩到底，统计“越过起点线”的用时。
 * 这是对游戏物理本身的测量，不是真人手感实测；真人圈速只会更慢（会松油门、修方向）。
 */
import { loopLength, loopPose } from './camp';
import { resolveDrive } from './collision';
import type { Shape } from './geom2d';
import { clamp, minRearAxleRadius, stepDrive, wrapAngle, type DriveState, type VehicleSpec } from './kinematics';

export interface LapResult {
  /** 静止起步第一圈用时 s */
  standingS: number;
  /** 第二圈（飞驰圈）用时 s */
  flyingS: number;
  /** 全程最高速 m/s */
  maxSpeed: number;
  /** 全程与障碍物的接触次数（沿路开应为 0） */
  impacts: number;
}

/** 预瞄距离 m：越小越贴线，越大越平顺 */
const LOOKAHEAD_M = 5;

export function simulateLaps(spec: VehicleSpec, boost: boolean, obstacles: Shape[], dt = 1 / 60): LapResult {
  const L = loopLength();
  const kMax = 1 / minRearAxleRadius(spec);
  // 起点：下段中心线 s = 0，车头沿行驶方向（后轴中心在中心线上）
  let st: DriveState = { pose: loopPose(0), speed: 0, curvature: 0 };
  let s = 0; // 已走过的中心线弧长（累计，不取模）
  let t = 0;
  let maxSpeed = 0;
  let impacts = 0;
  const laps: number[] = [];
  while (laps.length < 2 && t < 600) {
    // 预瞄点：中心线上前方 LOOKAHEAD_M 处；纯追踪曲率 κ = 2 sin α / Ld
    const g = loopPose(s + LOOKAHEAD_M);
    const dx = g.x - st.pose.x;
    const dy = g.y - st.pose.y;
    const ld = Math.hypot(dx, dy);
    const alpha = wrapAngle(Math.atan2(dy, dx) - st.pose.yaw);
    const steer = clamp((2 * Math.sin(alpha)) / ld / kMax, -1, 1);
    const next = stepDrive(spec, st, { throttle: 1, steer, boost }, dt);
    const r = resolveDrive(spec, st, next, obstacles);
    if (r.impact) impacts++;
    st = r.state;
    t += dt;
    maxSpeed = Math.max(maxSpeed, st.speed);
    // 进度：在上一次弧长附近找中心线上最近的点（只向前搜，步长 1 cm）
    let best = s;
    let bd = Infinity;
    for (let q = s; q <= s + 1; q += 0.01) {
      const p = loopPose(q);
      const d = (p.x - st.pose.x) ** 2 + (p.y - st.pose.y) ** 2;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    s = best;
    if (s >= L * (laps.length + 1)) laps.push(t);
  }
  return { standingS: laps[0] ?? Infinity, flyingS: (laps[1] ?? Infinity) - (laps[0] ?? 0), maxSpeed, impacts };
}

/** 恒速理论圈时：中心线长 / 速度 */
export function idealLapS(speed: number): number {
  return loopLength() / speed;
}
