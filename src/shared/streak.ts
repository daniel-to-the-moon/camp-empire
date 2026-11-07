/**
 * 连续登录 7 日梯度（issue #29，来源提案 #23）。纯函数，不依赖状态与时间源。
 *
 * - 连续天数 n：按上海日序号（ledger.dayKey）计。昨天领过 → n + 1；否则（断签或首次）→ 1。
 * - 当天领取金额 = ladderGold[(n − 1) mod 7]：第 8 天回到第 1 档，循环。
 * - 断签只把 n 重置为 1，不扣任何已得金币、不改余额。
 */
import { DAILY_GIFT } from './config';

export const LADDER: readonly number[] = DAILY_GIFT.ladderGold;
export const LADDER_DAYS = LADDER.length;

/** 上次领取：上海日序号与当时的连续天数 */
export interface GiftStreak {
  day: number;
  n: number;
}

/** 连续第 n 天（n ≥ 1）处在 7 日循环的第几天（1…7） */
export function cycleDay(n: number): number {
  return ((n - 1) % LADDER_DAYS) + 1;
}

/** 连续第 n 天领取的金币 */
export function giftGoldForStreak(n: number): number {
  return LADDER[cycleDay(n) - 1];
}

/** 在 day 这天领取时的连续天数：上次领取恰为昨天则 +1，否则从 1 重新开始 */
export function nextStreak(last: GiftStreak | null, day: number): number {
  return last && last.day === day - 1 ? last.n + 1 : 1;
}

/** 7 日梯度表平均每天的金币（连续登录时）：450 / 7 */
export function ladderMeanGold(): number {
  return LADDER.reduce((s, g) => s + g, 0) / LADDER_DAYS;
}

export interface StreakView {
  /** 今天是连续第几天（今天未领时按“现在领取”计算） */
  streak: number;
  /** 今天处在 7 日循环的第几天（1…7） */
  today: number;
  todayGold: number;
  claimedToday: boolean;
  /** 明天继续登录能领多少 */
  tomorrowGold: number;
}

/** 界面公示用：今天第几天、明天能领多少 */
export function streakView(last: GiftStreak | null, day: number): StreakView {
  const claimedToday = !!last && last.day >= day;
  const streak = claimedToday ? last!.n : nextStreak(last, day);
  return {
    streak,
    today: cycleDay(streak),
    todayGold: giftGoldForStreak(streak),
    claimedToday,
    tomorrowGold: giftGoldForStreak(streak + 1),
  };
}

/** 存档里的连续记录是否合法 */
export function validStreak(x: unknown): x is GiftStreak {
  const g = x as GiftStreak;
  return !!g && typeof g === 'object' && Number.isSafeInteger(g.day) && Number.isSafeInteger(g.n) && g.n >= 1;
}
