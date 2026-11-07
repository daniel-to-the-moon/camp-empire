/** 玩家碰撞障碍物（显示层辅助，纯逻辑在 src/shared；路径动画 PathRunner 已移到 src/shared/traffic.ts）。 */
import { GATE, STALLS, stallRect, staticShapes, WORLD } from '../shared/camp';
import { rect, type Shape } from '../shared/geom2d';

export { PathRunner } from '../shared/traffic';

/**
 * 玩家手动驾驶的障碍物：静态障碍 + 出租车位（留给露营者，玩家车不能开进去）+ 大门外的拦车杆。
 * 家位不是障碍，玩家可以手动开进去。
 */
export function playerObstacles(): Shape[] {
  const stalls: Shape[] = STALLS.filter((s) => s.kind !== 'home').map((s) => ({ type: 'poly', pts: stallRect(s), tag: s.id }));
  const gateBar: Shape = { type: 'poly', pts: rect(GATE.x, WORLD.minY - 1, 0, GATE.width + 2, 1), tag: 'gate' };
  return [...staticShapes(), ...stalls, gateBar];
}
