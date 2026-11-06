/** 路径动画与玩家碰撞障碍物（显示层辅助，纯逻辑在 src/shared）。 */
import { GATE, STALLS, stallRect, staticShapes, WORLD } from '../shared/camp';
import { rect, type Shape } from '../shared/geom2d';
import type { PathPose } from '../shared/parking';

export class PathRunner {
  private cum: number[] = [0];
  private s = 0;
  readonly total: number;
  constructor(
    readonly path: PathPose[],
    private speed = 4,
  ) {
    for (let i = 1; i < path.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    }
    this.total = this.cum[this.cum.length - 1];
  }
  get done(): boolean {
    return this.s >= this.total;
  }
  /** 前进 dt，返回当前位姿（倒车段速度减半） */
  step(dt: number): PathPose {
    const cur = this.at(this.s);
    this.s = Math.min(this.total, this.s + dt * this.speed * (cur.dir < 0 ? 0.5 : 1));
    return this.at(this.s);
  }
  private at(s: number): PathPose {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.path[lo];
    const b = this.path[hi];
    const seg = this.cum[hi] - this.cum[lo];
    const t = seg > 0 ? (s - this.cum[lo]) / seg : 0;
    const dy = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, yaw: a.yaw + dy * t, dir: b.dir };
  }
}

/**
 * 玩家手动驾驶的障碍物：静态障碍 + 出租车位（留给露营者，玩家车不能开进去）+ 大门外的拦车杆。
 * 家位不是障碍，玩家可以手动开进去。
 */
export function playerObstacles(): Shape[] {
  const stalls: Shape[] = STALLS.filter((s) => s.kind !== 'home').map((s) => ({ type: 'poly', pts: stallRect(s), tag: s.id }));
  const gateBar: Shape = { type: 'poly', pts: rect(GATE.x, WORLD.minY - 1, 0, GATE.width + 2, 1), tag: 'gate' };
  return [...staticShapes(), ...stalls, gateBar];
}

