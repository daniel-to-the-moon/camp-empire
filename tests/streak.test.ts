/**
 * 连续登录 7 日梯度（issue #29，来源提案 #23）：连续 7 天、循环、断签、跨日、时钟回拨、存档迁移、界面公示。
 */
import { describe, expect, it } from 'vitest';
import { DAILY_GIFT } from '../src/shared/config';
import { auditBalance, dayKey } from '../src/shared/ledger';
import { claimDailyGift, giftStreakView, loadSave, newGame, type GameState } from '../src/shared/state';
import { cycleDay, giftGoldForStreak, LADDER, ladderMeanGold, nextStreak, streakView } from '../src/shared/streak';

const H = 3600_000;
/** 2026-11-dd hh:00 上海时间（日期可超过 30，Date.UTC 会顺延到 12 月） */
const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);
const reload = (s: GameState) => loadSave(JSON.stringify(s))!;
const giftsOf = (s: GameState) => s.ledger.entries.filter((e) => e.kind === 'daily_gift');

describe('梯度表', () => {
  it('7 档固定金额 30…120，合计 450，日均 450/7', () => {
    expect([...DAILY_GIFT.ladderGold]).toEqual([30, 40, 50, 60, 70, 80, 120]);
    expect(LADDER.reduce((a, b) => a + b, 0)).toBe(450);
    expect(ladderMeanGold()).toBeCloseTo(64.2857, 4);
  });

  it('第 8 天起循环', () => {
    expect([1, 2, 7, 8, 14, 15].map(cycleDay)).toEqual([1, 2, 7, 1, 7, 1]);
    expect([1, 7, 8, 15].map(giftGoldForStreak)).toEqual([30, 120, 30, 30]);
  });

  it('nextStreak：昨天领过 +1，否则回到 1', () => {
    expect(nextStreak(null, 100)).toBe(1);
    expect(nextStreak({ day: 99, n: 5 }, 100)).toBe(6);
    expect(nextStreak({ day: 98, n: 5 }, 100)).toBe(1);
  });
});

describe('领取', () => {
  it('连续 7 天依次领 30/40/50/60/70/80/120，第 8 天回到 30', () => {
    const s = newGame(nov(1), 7);
    const got: number[] = [];
    for (let d = 1; d <= 8; d++) {
      const r = claimDailyGift(s, nov(d));
      got.push(r.gift!.gold);
      expect(r.gift!.streak).toBe(d);
      expect(r.gift!.day).toBe(cycleDay(d));
    }
    expect(got).toEqual([30, 40, 50, 60, 70, 80, 120, 30]);
    expect(giftsOf(s).map((e) => e.gross)).toEqual(got.map((g) => g * 100));
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('断签回到第 1 天：不扣钱、不清零，已得礼物原样保留', () => {
    const s = newGame(nov(1), 7);
    for (let d = 1; d <= 4; d++) claimDailyGift(s, nov(d));
    const before = s.ledger.balance;
    const kept = giftsOf(s).map((e) => e.amount);
    // 5 日没上线，6 日回来
    const r = claimDailyGift(s, nov(6));
    expect(r.gift).toMatchObject({ gold: 30, streak: 1, day: 1 });
    expect(s.ledger.balance).toBe(before + r.gift!.amount); // 只多不少
    expect(giftsOf(s).slice(0, 4).map((e) => e.amount)).toEqual(kept);
    expect(s.ledger.entries.every((e) => e.amount >= 0 || e.kind === 'purchase')).toBe(true);
    // 断签后重新连续
    expect(claimDailyGift(s, nov(7)).gift).toMatchObject({ gold: 40, streak: 2 });
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('同一上海日只领一次；跨上海 0 点算新的一天（上海 23:59 与次日 00:00）', () => {
    const s = newGame(nov(1, 0), 7);
    expect(claimDailyGift(s, nov(1, 0)).gift!.gold).toBe(30);
    expect(claimDailyGift(s, nov(1, 12)).gift).toBeNull();
    expect(claimDailyGift(s, nov(2, 0) - 60_000).gift).toBeNull(); // 上海 1 日 23:59
    expect(claimDailyGift(s, nov(2, 0)).gift!.gold).toBe(40); // 上海 2 日 00:00（UTC 1 日 16:00）
    expect(giftsOf(s)).toHaveLength(2);
  });

  it('时钟回拨不重复发放，也不打断连续', () => {
    const s = newGame(nov(1), 7);
    claimDailyGift(s, nov(1));
    claimDailyGift(s, nov(2));
    const balance = s.ledger.balance;
    // 回拨到 1 日：有效时间停在 2 日，不发
    expect(claimDailyGift(s, nov(1, 15)).gift).toBeNull();
    expect(claimDailyGift(s, nov(1, 23)).gift).toBeNull();
    expect(s.ledger.balance).toBe(balance);
    expect(s.giftStreak).toEqual({ day: dayKey(nov(2)), n: 2 });
    // 本机时间恢复后：3 日仍是连续第 3 天
    expect(claimDailyGift(s, nov(3)).gift).toMatchObject({ gold: 50, streak: 3 });
    expect(giftsOf(s)).toHaveLength(3);
  });

  it('重载存档后连续天数保留', () => {
    let s = newGame(nov(1), 7);
    claimDailyGift(s, nov(1));
    claimDailyGift(s, nov(2));
    s = reload(s);
    expect(claimDailyGift(s, nov(3)).gift).toMatchObject({ gold: 50, streak: 3 });
  });
});

describe('存档迁移', () => {
  it('没有 giftStreak 的旧存档：以 lastGiftDay 为第 1 天接上，余额与流水不变', () => {
    const s = newGame(nov(1), 7);
    claimDailyGift(s, nov(1));
    const legacy = JSON.parse(JSON.stringify(s));
    delete legacy.giftStreak;
    const m = loadSave(JSON.stringify(legacy))!;
    expect(m).not.toBeNull();
    expect(m.giftStreak).toEqual({ day: dayKey(nov(1)), n: 1 });
    expect(m.ledger.balance).toBe(s.ledger.balance);
    expect(m.ledger.entries).toEqual(s.ledger.entries);
    expect(claimDailyGift(m, nov(2)).gift).toMatchObject({ gold: 40, streak: 2 });
  });

  it('从未领过礼物的旧存档：giftStreak 为 null，首次领取第 1 天', () => {
    const legacy = JSON.parse(JSON.stringify(newGame(nov(1), 7)));
    delete legacy.giftStreak;
    const m = loadSave(JSON.stringify(legacy))!;
    expect(m.giftStreak).toBeNull();
    expect(claimDailyGift(m, nov(1)).gift).toMatchObject({ gold: 30, streak: 1 });
  });

  it('旧版本标签页按旧规则领过礼物（lastGiftDay 前进、giftStreak 未动）：当天算第 1 天', () => {
    const s = newGame(nov(1), 7);
    claimDailyGift(s, nov(1));
    claimDailyGift(s, nov(2));
    s.lastGiftDay = dayKey(nov(4)); // 旧代码 4 日领过，只改了 lastGiftDay
    const m = reload(s);
    expect(m.giftStreak).toEqual({ day: dayKey(nov(4)), n: 1 });
    expect(claimDailyGift(m, nov(4, 20)).gift).toBeNull(); // 4 日不再发
    expect(claimDailyGift(m, nov(5)).gift).toMatchObject({ gold: 40, streak: 2 });
  });

  it('giftStreak 结构损坏：按 lastGiftDay 补齐而不是丢弃存档', () => {
    const s = newGame(nov(1), 7);
    claimDailyGift(s, nov(1));
    const bad = { ...JSON.parse(JSON.stringify(s)), giftStreak: { day: 'x', n: 0 } };
    expect(loadSave(JSON.stringify(bad))!.giftStreak).toEqual({ day: dayKey(nov(1)), n: 1 });
  });
});

describe('界面公示', () => {
  it('今天第几天、明天能领多少（今天未领 / 已领）', () => {
    const s = newGame(nov(1), 7);
    expect(giftStreakView(s, nov(1))).toEqual({ streak: 1, today: 1, todayGold: 30, claimedToday: false, tomorrowGold: 40 });
    for (let d = 1; d <= 7; d++) claimDailyGift(s, nov(d));
    expect(giftStreakView(s, nov(7, 20))).toEqual({ streak: 7, today: 7, todayGold: 120, claimedToday: true, tomorrowGold: 30 });
    // 8 日还没领：按现在领取计算
    expect(giftStreakView(s, nov(8))).toMatchObject({ streak: 8, today: 1, todayGold: 30, claimedToday: false });
    // 断签一天后再看：第 1 天
    expect(giftStreakView(s, nov(9))).toMatchObject({ streak: 1, today: 1, claimedToday: false, tomorrowGold: 40 });
  });

  it('streakView 不依赖时间源，回拨期间按有效时间展示', () => {
    expect(streakView({ day: 10, n: 3 }, 10)).toMatchObject({ claimedToday: true, today: 3, tomorrowGold: 60 });
    const s = newGame(nov(1), 7);
    claimDailyGift(s, nov(1));
    claimDailyGift(s, nov(2, 20));
    expect(giftStreakView(s, nov(1) - 5 * H)).toMatchObject({ claimedToday: true, streak: 2 });
  });
});
