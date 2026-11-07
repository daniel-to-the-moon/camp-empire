/**
 * 解析期望（更新回报定理）与待收取池的展示数据。推演表脚本（scripts/economy-table.ts）与界面共用同一份公式。
 *
 * 每车位长期每分钟收入 = 每次停靠期望收入 / 期望循环长度；
 * 每车位 金/天 = 1440 × 平均停靠分钟 / (平均停靠分钟 + 平均等待分钟) × 每分钟费率。
 */
import { RENTAL_SPOTS } from './camp';
import { NPC, PENDING } from './config';
import { pendingCapCents, type Cents, type PendingPool } from './ledger';

export const PRIVATE_SPOTS = RENTAL_SPOTS.filter((s) => s.kind === 'private').length;
/** 均匀整数分钟 [min, cap] 的均值 */
export const MEAN_STAY_MINUTES = (NPC.minStayMinutes + NPC.capMinutes) / 2;

export function expectedParking(awningOut: boolean) {
  const gap = NPC.meanGapMinutes * (awningOut ? NPC.awningGapFactor : 1);
  const cycle = MEAN_STAY_MINUTES + gap;
  const occupancy = MEAN_STAY_MINUTES / cycle;
  const perSpotGoldPerDay = ((1440 * MEAN_STAY_MINUTES) / cycle) * (NPC.rateCentsPerHour / 100 / 60);
  return { gap, cycle, occupancy, perSpotGoldPerDay, goldPerDay: perSpotGoldPerDay * PRIVATE_SPOTS };
}

/** 按 PENDING.capHours 的期望停车收入推出的上限（金，向下取整）；用于校验 PENDING.capGold 与推演一致 */
export function derivedPendingCapGold(): number {
  return Math.floor((expectedParking(true).goldPerDay * PENDING.capHours) / 24);
}

export interface PendingView {
  /** 待收取（分，毛额） */
  pending: Cents;
  cap: Cents;
  stays: number;
  full: boolean;
  /** 自上次收取以来未累积的部分（分）与笔数 */
  lost: Cents;
  lostStays: number;
  /** 按当前环境的期望停车收入估算，还要多少小时到上限；已满为 0 */
  hoursToFull: number;
}

export function pendingView(p: PendingPool, awningOut: boolean): PendingView {
  const cap = pendingCapCents();
  const left = Math.max(0, cap - p.gross);
  const centsPerHour = (expectedParking(awningOut).goldPerDay * 100) / 24;
  return {
    pending: p.gross,
    cap,
    stays: p.stays,
    full: left === 0,
    lost: p.lost,
    lostStays: p.lostStays,
    hoursToFull: left / centsPerHour,
  };
}
