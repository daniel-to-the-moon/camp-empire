/**
 * 出库（倒出家位）作为一个存档动作：路线在事务内按事务里的最新状态规划（issue #12）。
 *
 * 以前出库路线在存档队列之外、按画面当前车型规划：换车事务还没提交时按 O，换车先提交，
 * 出库却仍用旧车型的路线（SH5043 → SH6601A4DB 复现约 0.24 m 跳位）。
 * 现在规划放进事务：排在换车之后执行的出库，读到的就是换车后的车型；其他标签页改过存档时同理。
 */
import type { Stall } from './camp';
import type { Shape } from './geom2d';
import { specOf } from './kinematics';
import { planReverseOut, type PathPose } from './parking';
import { currentVariant, leaveHome, tick, type ActionResult, type GameState } from './state';

export interface DepartResult extends ActionResult {
  /** 出库路线（ok 时非空）：按 variantId 车型规划 */
  path: PathPose[];
  /** 规划所用车型（事务里的最新车型），客户端据此确认画面车型一致 */
  variantId: string;
}

/**
 * 在传入状态上规划倒出路线并离开家位。
 * obstacles 在事务执行时才取（停好的 NPC 车身），保证与动作同一时刻；它只读画面、不改状态。
 */
export function departHome(s: GameState, nowMs: number, stall: Stall, obstacles: () => Shape[]): DepartResult {
  const variantId = s.variantId;
  if (!s.player.parkedHome) return { ok: false, error: '车已不在家位', events: tick(s, nowMs), path: [], variantId };
  const plan = planReverseOut(specOf(currentVariant(s)), stall, obstacles());
  if (!plan.ok) return { ok: false, error: plan.reason, events: tick(s, nowMs), path: [], variantId };
  const end = plan.path[plan.path.length - 1];
  const r = leaveHome(s, nowMs, { x: end.x, y: end.y, yaw: end.yaw });
  return { ...r, path: plan.path, variantId };
}
