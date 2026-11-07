/**
 * 状态动作：时钟回拨（GPT 审核 #4 第 2 条）与动作事件不丢失（第 5 条）。
 */
import { describe, expect, it } from 'vitest';
import { auditBalance, dayKey } from '../src/shared/ledger';
import {
  arriveHome,
  buyAwning,
  claimDailyGift,
  effectiveNow,
  leaveHome,
  loadSave,
  newGame,
  recordPose,
  selectVariant,
  setAwningWanted,
  tick,
  type GameState,
} from '../src/shared/state';

const H = 3600_000;
/** 2026-11-dd 10:00 上海时间 */
const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);
const reload = (s: GameState) => loadSave(JSON.stringify(s))!;

describe('时钟回拨', () => {
  it('跨未登录日期回拨：不抛异常、不向历史账日发礼物、领取日期不倒退', () => {
    const s = newGame(nov(5), 17);
    expect(claimDailyGift(s, nov(5)).gift).not.toBeNull();
    // 推进到 11 月 8 日（6、7 日未登录），结算并领礼物
    expect(claimDailyGift(s, nov(8)).gift).not.toBeNull();
    const day8 = dayKey(nov(8));
    expect(s.lastGiftDay).toBe(day8);
    const entries = s.ledger.entries.length;
    const balance = s.ledger.balance;

    // 回拨到从未领取过的 11 月 7 日：原实现在这里 credit 抛“入账时间早于当前账日”
    expect(() => claimDailyGift(s, nov(7))).not.toThrow();
    expect(claimDailyGift(s, nov(7)).gift).toBeNull();
    expect(s.lastGiftDay).toBe(day8);
    expect(s.ledger.entries.some((e) => e.key === `gift:${dayKey(nov(7))}`)).toBe(false);
    expect(s.ledger.entries.length).toBe(entries);
    expect(s.ledger.balance).toBe(balance);
    expect(effectiveNow(s, nov(7))).toBe(nov(8));

    // 回拨期间的其他动作也按有效时间记账，不抛异常
    expect(() => {
      setAwningWanted(s, nov(7), false);
      selectVariant(s, nov(7, 11), s.variantId);
      leaveHome(s, nov(7, 12), { x: 0, y: 0, yaw: 0 });
      recordPose(s, nov(7, 13), { x: 1, y: 0, yaw: 0 });
      arriveHome(s, nov(7, 14));
      tick(s, nov(6));
    }).not.toThrow();
    expect(buyAwning(s, nov(7)).ok).toBe(true);
    const buy = s.ledger.entries.find((e) => e.key === 'buy:side_awning')!;
    expect(buy.atMs).toBe(nov(8)); // 有效时间，不是回拨后的本机时间
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('回拨状态下存档重载，然后恢复正常时间', () => {
    let s = newGame(nov(5), 3);
    claimDailyGift(s, nov(5));
    claimDailyGift(s, nov(8));
    s = reload(s);
    // 重载后仍在回拨中
    expect(claimDailyGift(s, nov(7)).gift).toBeNull();
    s = reload(s);
    expect(() => claimDailyGift(s, nov(6))).not.toThrow();
    // 本机时间追上：同一天（8 日）不重复发
    expect(claimDailyGift(s, nov(8, 23)).gift).toBeNull();
    // 下一天正常发放，NPC 也正常回放
    const r = claimDailyGift(s, nov(9));
    expect(r.gift).not.toBeNull();
    expect(s.lastGiftDay).toBe(dayKey(nov(9)));
    expect(s.camp.lastMs).toBe(nov(9));
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('不变量：账本当前账日不晚于回放时刻所在的日', () => {
    const s = newGame(nov(1), 9);
    const times = [nov(1), nov(3), nov(2), nov(4, 23), nov(4, 1), nov(6), nov(5), nov(7)];
    for (const t of times) {
      claimDailyGift(s, t);
      expect(s.ledger.today.day).toBeLessThanOrEqual(dayKey(s.camp.lastMs));
    }
    expect(auditBalance(s.ledger)).toBe(true);
  });
});

describe('动作返回 NPC 事件（不被吞掉）', () => {
  const firstArrival = (s: GameState) => Math.min(...s.camp.spots.map((sp) => sp.nextArrivalMs ?? Infinity));

  it('购买恰好发生在 NPC 到达时刻：购买返回 arrive 事件，之后的定时 tick 为空', () => {
    const s = newGame(nov(5), 17);
    const t = firstArrival(s);
    const r = buyAwning(s, t);
    expect(r.ok).toBe(true);
    expect(r.events.some((e) => e.type === 'arrive' && e.atMs === t)).toBe(true);
    // 事件已被动作消费：客户端若丢弃 r.events，这辆车就永远不会生成——所以必须分发
    expect(tick(s, t)).toEqual([]);
  });

  it('离家恰好发生在 NPC 离开时刻：离家返回 depart 事件', () => {
    const s = newGame(nov(5), 17);
    const arrive = buyAwning(s, firstArrival(s)).events.find((e) => e.type === 'arrive')!;
    const departMs = arrive.stay.departMs;
    const r = leaveHome(s, departMs, { x: 0, y: 0, yaw: 0 });
    expect(r.events.some((e) => e.type === 'depart' && e.stay.parkingId === arrive.stay.parkingId)).toBe(true);
    expect(tick(s, departMs)).toEqual([]);
  });

  it.each([
    ['setAwningWanted', (s: GameState, t: number) => setAwningWanted(s, t, false).events],
    ['selectVariant', (s: GameState, t: number) => selectVariant(s, t, s.variantId).events],
    ['selectVariant（失败也返回事件）', (s: GameState, t: number) => selectVariant(s, t, 'no-such-car').events],
    ['leaveHome', (s: GameState, t: number) => leaveHome(s, t, { x: 0, y: 0, yaw: 0 }).events],
    ['arriveHome', (s: GameState, t: number) => arriveHome(s, t).events],
    ['recordPose', (s: GameState, t: number) => recordPose(s, t, { x: 0, y: 0, yaw: 0 }).events],
    ['claimDailyGift', (s: GameState, t: number) => claimDailyGift(s, t).events],
    ['buyAwning（余额不足也返回事件）', (s: GameState, t: number) => {
      s.ledger.balance = 0;
      s.ledger.entries = [];
      return buyAwning(s, t).events;
    }],
  ])('%s', (_name, run) => {
    const s = newGame(nov(5), 17);
    const t = firstArrival(s) + 13 * H; // 期间至少有到达，通常也有离开
    const events = run(s, t);
    expect(events.length).toBeGreaterThan(0);
    expect(tick(s, t)).toEqual([]);
  });
});
