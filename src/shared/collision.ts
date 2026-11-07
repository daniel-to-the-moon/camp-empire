/**
 * 碰撞响应（玩家手动驾驶）：不再“一碰速度归零”，而是
 * 1. 推出：沿接触法线把车推出穿透深度（反作用力的位移部分），擦边时车会贴着障碍物滑过去；
 * 2. 反弹：法向速度按恢复系数 e 反向，v' = v − (1 + e)(v·n)n，再投影回车头方向
 *   （车只能沿车头方向走）→ 正撞速度变为 −e·v，擦边几乎不减速；
 * 3. 摩擦：每次接触再按法向冲击比例刮掉一部分速度；
 * 4. 偏转：接触点不在车身中心线上时，给一个小的偏航扭转（撞车尾会把车尾甩开）。
 * 结果保证不与障碍物重叠：任何一步解不开就退回上一帧的位姿（速度仍按反弹计算，不归零）。
 * 参数是手感提案值，见 COLLISION。
 */
import { penetration, type Penetration, type Pt, type Shape } from './geom2d';
import { bodyCenter, footprint, type DriveState, type Pose, type VehicleSpec } from './kinematics';

export const COLLISION = {
  /** 恢复系数：正撞反弹速度 = e × 撞击速度 */
  restitution: 0.35,
  /** 摩擦：每单位法向冲击（相对撞击前速度）额外损失的速度比例 */
  scrub: 0.25,
  /** 偏航扭转系数（弧度 / (m/s · m)） */
  yawKick: 0.012,
  /** 推出时多推的间隙，避免下一帧又贴着 */
  skin: 0.01,
  /** 每帧最多迭代次数（同时碰到多个障碍物时逐个解） */
  iterations: 4,
} as const;

export interface Impact {
  /** 接触点（世界坐标，车身上最深入障碍物的角） */
  point: Pt;
  n: Pt;
  /** 法向撞击速度 m/s（≥ 0），用于烟尘量、震屏强度 */
  strength: number;
  tag: string;
}

function worst(poly: Pt[], obstacles: Shape[]): Penetration | null {
  let best: Penetration | null = null;
  for (const s of obstacles) {
    const p = penetration(poly, s);
    if (p && p.depth > 0 && (!best || p.depth > best.depth)) best = p;
  }
  return best;
}

function collides(s: VehicleSpec, p: Pose, obstacles: Shape[]): boolean {
  return worst(footprint(s, p), obstacles) !== null;
}

/** 车身上沿 −n 最突出的点（插入障碍物最深的角） */
function contactPoint(poly: Pt[], n: Pt): Pt {
  let best = poly[0];
  let lo = Infinity;
  for (const q of poly) {
    const d = q[0] * n[0] + q[1] * n[1];
    if (d < lo) {
      lo = d;
      best = q;
    }
  }
  return best;
}

/**
 * prev：上一帧（无碰撞）状态；next：本帧积分结果。返回解算后的状态与撞击信息（没碰撞时 impact 为 null）。
 */
export function resolveDrive(
  s: VehicleSpec,
  prev: DriveState,
  next: DriveState,
  obstacles: Shape[],
): { state: DriveState; impact: Impact | null } {
  let pose = next.pose;
  let speed = next.speed;
  let impact: Impact | null = null;
  for (let i = 0; i < COLLISION.iterations; i++) {
    const poly = footprint(s, pose);
    const pen = worst(poly, obstacles);
    if (!pen) return { state: { pose, speed, curvature: next.curvature }, impact };
    const [nx, ny] = pen.n;
    const hx = Math.cos(pose.yaw);
    const hy = Math.sin(pose.yaw);
    const hn = hx * nx + hy * ny;
    const vn = speed * hn; // 法向速度（< 0 = 正在撞进去）
    const point = contactPoint(poly, pen.n);
    if (vn < 0) {
      const before = Math.abs(speed);
      // 反弹：投影回车头方向
      speed = speed * (1 - (1 + COLLISION.restitution) * hn * hn);
      // 摩擦刮擦
      const scrub = Math.min(1, COLLISION.scrub * (-vn / Math.max(before, 1e-6)));
      speed *= 1 - scrub;
      if (!impact || -vn > impact.strength) impact = { point, n: pen.n, strength: -vn, tag: pen.shape.tag };
    }
    // 推出 + 偏转：接触点相对车身中心的力臂 × 法线 → 扭矩
    const [cx, cy] = bodyCenter(s, pose);
    const rx = point[0] - cx;
    const ry = point[1] - cy;
    const torque = rx * ny - ry * nx;
    const kick = COLLISION.yawKick * torque * Math.max(0, -vn);
    const push = pen.depth + COLLISION.skin;
    const pushed: Pose = { x: pose.x + nx * push, y: pose.y + ny * push, yaw: pose.yaw + kick };
    pose = collides(s, pushed, obstacles) && kick !== 0 ? { ...pushed, yaw: pose.yaw } : pushed;
  }
  // 解不开（夹在多个障碍物之间）：退回上一帧位置，保留反弹后的速度
  if (collides(s, pose, obstacles)) pose = prev.pose;
  return { state: { pose, speed, curvature: next.curvature }, impact };
}
