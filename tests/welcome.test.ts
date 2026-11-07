/**
 * 回访面板与待收取区文案（issue #28）：礼物与收取同一个面板；满额时“待收取”与“未累积”分开，明说不是扣钱。
 */
import { describe, expect, it } from 'vitest';
import { closeWelcomeAfterCollect, departToast, fmtHours, offlineSummary, pendingLines, returnPanel } from '../src/client/welcome';
import { awningOut, claimDailyGift, collectPending, newGame } from '../src/shared/state';
import { pendingView } from '../src/shared/economy';
import { emptyPending, pendingCapCents, type PendingPool } from '../src/shared/ledger';
import type { CampEvent, NpcStay } from '../src/shared/npc';

const stay: NpcStay = { parkingId: 'p1#0', variantId: 'x', arriveMs: 0, departMs: 1 };
const dep = (gross: number, pooled: number, spotId = 'p1'): Extract<CampEvent, { type: 'depart' }> => ({
  type: 'depart',
  atMs: 1,
  spotId,
  stay,
  gross,
  pooled,
  lost: gross - pooled,
  minutes: 300,
});
const pool = (p: Partial<PendingPool>): PendingPool => ({ ...emptyPending(), ...p });
const cap = pendingCapCents();

describe('回访面板', () => {
  it('礼物与待收取在同一个面板里，有收取按钮', () => {
    const p = returnPanel([dep(5_000, 5_000)], { gold: 50, day: 3, streak: 3 }, pendingView(pool({ gross: 5_000, stays: 1 }), false))!;
    expect(p.lines.join('\n')).toContain('1 位露营者停完离开，50 金进入待收取');
    expect(p.lines.join('\n')).toContain('连续登录第 3 天：营地管理员巡视送来 50 金（已入账）。明天继续登录可领 60 金。');
    expect(p.lines.join('\n')).toContain('待收取 50 金');
    expect(p.collect).toBe('收取 50 金');
  });

  it('池满：待收取与未累积分开显示，并说明不是扣钱', () => {
    const v = pendingView(pool({ gross: cap, stays: 9, lost: 12_300, lostStays: 3 }), true);
    const p = returnPanel([dep(20_000, 7_700)], null, v)!;
    const text = p.lines.join('\n');
    expect(text).toContain('待收取 1,300 金（已满，上限 1,300 金）');
    expect(text).toContain('未累积 123 金（3 位露营者');
    expect(text).toContain('不是扣钱');
    expect(text).toContain('待收取已满，123 金未累积');
    expect(p.collect).toBe('收取 1,300 金');
  });

  it('只有礼物、没有待收取：无收取按钮；什么都没有：不弹', () => {
    const empty = pendingView(emptyPending(), false);
    expect(returnPanel([], { gold: 120, day: 7, streak: 14 }, empty)).toEqual({
      lines: ['连续登录第 7 天：营地管理员巡视送来 120 金（已入账）。明天继续登录可领 30 金。'],
      collect: null,
    });
    expect(returnPanel([], null, empty)).toBeNull();
    expect(returnPanel([dep(0, 0, 'love')], null, empty)).toBeNull(); // 爱心车位不付费，不算
  });
});

describe('待收取区', () => {
  it('未满：显示距离上限的金额与预计时间', () => {
    const v = pendingView(pool({ gross: 30_000, stays: 4 }), false);
    const { status, lost } = pendingLines(v);
    expect(status).toContain('4 位露营者的停车费');
    expect(status).toContain('距上限 1,000 金');
    expect(status).toContain('约 38 小时 10 分后满'); // 1000 / 630 × 24 = 38.10 h
    expect(lost).toBeNull();
  });
  it('已满：明确提示新的停车费不再累积', () => {
    const { status } = pendingLines(pendingView(pool({ gross: cap, stays: 9 }), false));
    expect(status).toContain('已满');
    expect(status).toContain('新的停车费不再累积');
  });
  it('空池：显示上限与从零到满的时间', () => {
    expect(pendingLines(pendingView(emptyPending(), true)).status).toBe('暂无。上限 1,300 金，按期望收入约 48 小时后满');
  });
  it('fmtHours', () => {
    expect(fmtHours(0.001)).toBe('约 1 分钟');
    expect(fmtHours(1)).toBe('约 1 小时');
    expect(fmtHours(2.5)).toBe('约 2 小时 30 分');
    expect(fmtHours(47.98)).toBe('约 48 小时');
    expect(fmtHours(0.99)).toBe('约 60 分钟');
  });
});

describe('离开提示', () => {
  it('进池 / 部分进池 / 未累积 三种措辞；爱心车位无提示', () => {
    expect(departToast('1 号位', dep(5_000, 5_000), '5 小时')).toBe('1 号位的露营者停了 5 小时，50 金进入待收取');
    expect(departToast('1 号位', dep(5_000, 2_000), '5 小时')).toContain('30 金未累积');
    expect(departToast('1 号位', dep(5_000, 0), '5 小时')).toContain('待收取已满');
    expect(departToast('爱心车位', dep(0, 0, 'love'), '5 小时')).toBeNull();
    expect(offlineSummary([dep(0, 0, 'love')])).toBeNull();
  });
});

describe('收取后回访面板（GPT 审核 #32 第 2 轮）', () => {
  const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);

  it('面板打开时从侧栏收取成功：面板关闭；按收取后的账本重算已没有收取按钮', () => {
    const s = newGame(nov(5, 8), 17);
    claimDailyGift(s, nov(5, 8));
    const r0 = claimDailyGift(s, nov(5, 20));
    const panel = returnPanel(r0.events, r0.gift, pendingView(s.ledger.pending, awningOut(s)))!;
    expect(panel.collect).not.toBeNull(); // 面板打开，显示收取按钮

    const r = collectPending(s, nov(5, 20)); // 侧栏“收取”，没有 close 参数
    expect(r.collected).not.toBeNull();
    expect(closeWelcomeAfterCollect(false, r.collected !== null)).toBe(true);
    // 面板的快照已过时：按当前账本重算，不再有待收取与收取按钮
    expect(returnPanel([], null, pendingView(s.ledger.pending, awningOut(s)))).toBeNull();
  });

  it('侧栏收取失败（池为空）不动面板；从面板点的收取不论成败都关闭', () => {
    expect(closeWelcomeAfterCollect(false, false)).toBe(false);
    expect(closeWelcomeAfterCollect(true, false)).toBe(true);
    expect(closeWelcomeAfterCollect(true, true)).toBe(true);
  });
});
