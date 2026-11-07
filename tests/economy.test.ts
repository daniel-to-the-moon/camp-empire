import { describe, expect, it } from 'vitest';
import { RENTAL_SPOTS } from '../src/shared/camp';
import { ECONOMY, NPC } from '../src/shared/config';
import { auditBalance, credit, dayKey, issuedUpTo, newLedger, spend } from '../src/shared/ledger';
import { advanceCamp, feeCents, newCampSim } from '../src/shared/npc';

const T0 = Date.UTC(2026, 10, 5, 0, 0); // 上海 08:00
const H = 3600_000;
const cap = ECONOMY.softCapThresholdGold * 100;

describe('账本', () => {
  it('日界：上海 00:00 切日（UTC 16:00）', () => {
    expect(dayKey(Date.UTC(2026, 10, 5, 15, 59))).toBe(dayKey(Date.UTC(2026, 10, 5, 0, 0)));
    expect(dayKey(Date.UTC(2026, 10, 5, 16, 0))).toBe(dayKey(Date.UTC(2026, 10, 5, 0, 0)) + 1);
  });
  it('软上限：阈值内全额，超出部分 50%', () => {
    expect(issuedUpTo(cap)).toBe(cap);
    expect(issuedUpTo(cap + 1000)).toBe(cap + 500);
    expect(issuedUpTo(cap + 1)).toBe(cap);
  });
  it('拆分不变性：同一日毛收入不论怎么拆，实得之和 = floor(g(总额))', () => {
    const total = cap + 12_345;
    for (const pieces of [1, 2, 7, 333]) {
      const l = newLedger(T0);
      const start = l.balance;
      let left = total;
      for (let i = 0; i < pieces; i++) {
        const a = i === pieces - 1 ? left : Math.floor(total / pieces);
        left -= a;
        credit(l, { key: `k${i}`, atMs: T0 + i, kind: 'npc_parking', gross: a, note: '' });
      }
      expect(l.balance - start).toBe(issuedUpTo(total));
      expect(auditBalance(l)).toBe(true);
    }
  });
  it('两笔 0.01 金跨阈值不会都被取整成 0（GPT 指出的拆单问题）', () => {
    const l = newLedger(T0);
    credit(l, { key: 'a', atMs: T0, kind: 'npc_parking', gross: cap, note: '' });
    const b0 = l.balance;
    credit(l, { key: 'b', atMs: T0, kind: 'npc_parking', gross: 1, note: '' });
    credit(l, { key: 'c', atMs: T0, kind: 'npc_parking', gross: 1, note: '' });
    expect(l.balance - b0).toBe(1);
  });
  it('幂等：同一键只入账一次；跨日重置软上限累计', () => {
    const l = newLedger(T0);
    expect(credit(l, { key: 'x', atMs: T0, kind: 'npc_parking', gross: 500, note: '' })).toBe(500);
    expect(credit(l, { key: 'x', atMs: T0, kind: 'npc_parking', gross: 500, note: '' })).toBe(0);
    credit(l, { key: 'y', atMs: T0, kind: 'npc_parking', gross: cap * 2, note: '' });
    expect(credit(l, { key: 'z', atMs: T0 + 24 * H, kind: 'npc_parking', gross: 100, note: '' })).toBe(100);
  });
  it('消费：余额不足不扣款；非整数金额拒绝', () => {
    const l = newLedger(T0);
    expect(spend(l, { key: 'buy', atMs: T0, cost: l.balance + 1, note: '' })).toBe(false);
    expect(spend(l, { key: 'buy', atMs: T0, cost: 100, note: '' })).toBe(true);
    expect(() => spend(l, { key: 'buy2', atMs: T0, cost: 0.5, note: '' })).toThrow();
    expect(auditBalance(l)).toBe(true);
  });
});

describe('NPC 停车', () => {
  it('停靠时长在 [最短, 12 h] 内；爱心车位不付费；费用 = floor(分钟 × 费率 / 60)', () => {
    const l = newLedger(T0);
    const sim = newCampSim(42, T0, RENTAL_SPOTS);
    const ev = advanceCamp(sim, l, T0 + 30 * 24 * H, { awningOut: false });
    const departs = ev.filter((e) => e.type === 'depart');
    expect(departs.length).toBeGreaterThan(100);
    for (const d of departs) {
      if (d.type !== 'depart') continue;
      expect(d.minutes).toBeGreaterThanOrEqual(NPC.minStayMinutes);
      expect(d.minutes).toBeLessThanOrEqual(NPC.capMinutes);
      expect(d.gross).toBe(d.spotId === 'love' ? 0 : feeCents(d.minutes));
      expect(d.pooled + d.lost).toBe(d.gross);
    }
    expect(auditBalance(l)).toBe(true);
  });
  it('回放确定性：一次回放 30 天 = 每 7 分钟回放一次', () => {
    const end = T0 + 30 * 24 * H;
    const a = newLedger(T0);
    const sa = newCampSim(7, T0, RENTAL_SPOTS);
    advanceCamp(sa, a, end, { awningOut: false });
    const b = newLedger(T0);
    const sb = newCampSim(7, T0, RENTAL_SPOTS);
    for (let t = T0; t <= end; t += 7 * 60_000) advanceCamp(sb, b, t, { awningOut: false });
    advanceCamp(sb, b, end, { awningOut: false });
    expect(b.balance).toBe(a.balance);
    expect(b.pending).toEqual(a.pending);
    expect(Object.keys(b.seen).sort()).toEqual(Object.keys(a.seen).sort());
  });
  it('时钟回拨：不倒退、不重复入账', () => {
    const l = newLedger(T0);
    const sim = newCampSim(1, T0, RENTAL_SPOTS);
    advanceCamp(sim, l, T0 + 48 * H, { awningOut: false });
    const bal = l.balance;
    const pending = { ...l.pending };
    expect(advanceCamp(sim, l, T0 + 10 * H, { awningOut: false })).toEqual([]);
    expect(l.balance).toBe(bal);
    expect(l.pending).toEqual(pending);
  });
  it('侧边帐展开时 NPC 来得更勤（同种子 60 天停车费毛额更高）', () => {
    const run = (awningOut: boolean) =>
      advanceCamp(newCampSim(9, T0, RENTAL_SPOTS), newLedger(T0), T0 + 60 * 24 * H, { awningOut }).reduce((s, e) => s + (e.type === 'depart' ? e.gross : 0), 0);
    expect(run(true)).toBeGreaterThan(run(false));
  });
});
