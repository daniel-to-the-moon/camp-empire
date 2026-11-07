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

/**
 * 收取后 hours 小时内，待收取池最多能进多少（分）。确定性上界，不是期望值（GPT 审核 #32 第 2 轮）：
 * 这段时间里离开的露营者，停靠区间都落在 (收取时刻 − 单次停靠上限, 收取时刻 + hours] 内；
 * 同一车位的停靠互不重叠，所以每车位计费分钟 ≤ hours × 60 + capMinutes，停靠费 = floor(分钟 × 费率 / 60) ≤ 分钟 × 费率 / 60。
 * 侧边帐只缩短等待，不改变这个上界。
 */
export function maxPooledCentsWithin(hours: number): Cents {
  return Math.floor((PRIVATE_SPOTS * (hours * 60 + NPC.capMinutes) * NPC.rateCentsPerHour) / 60);
}

/** 收取后至少要过多少小时池才可能满（由 maxPooledCentsWithin 反解）；收取间隔短于它时一定碰不到上限 */
export function minHoursToFull(): number {
  return pendingCapCents() / (PRIVATE_SPOTS * NPC.rateCentsPerHour) - NPC.capMinutes / 60;
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
