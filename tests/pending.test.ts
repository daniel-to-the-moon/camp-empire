/**
 * 待收取池（issue #28，来源提案 #22）：离开进池不改余额、收取入账、48 h 封顶、跨日软上限口径、旧存档迁移。
 */
import { describe, expect, it } from 'vitest';
import { ECONOMY, PENDING } from '../src/shared/config';
import { derivedPendingCapGold, expectedParking, pendingView } from '../src/shared/economy';
import { auditBalance, collect, credit, dayKey, deposit, issuedUpTo, newLedger, pendingCapCents } from '../src/shared/ledger';
import { claimDailyGift, collectPending, loadSave, newGame, SAVE_VERSION, tick, type GameState } from '../src/shared/state';

/** 2026-11-dd hh:00 上海时间 */
const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);
const cap = pendingCapCents();

describe('上限推演（提案值）', () => {
  it('期望停车收入：无侧边帐 630 金/天，侧边帐展开 650.3 金/天（与 ECONOMY_M1.md 一致）', () => {
    expect(expectedParking(false).goldPerDay).toBeCloseTo(630, 6);
    expect(expectedParking(true).goldPerDay).toBeCloseTo(650.32, 2);
  });
  it('PENDING.capGold = floor(48 h × 侧边帐展开的期望停车收入) = 1300', () => {
    expect(PENDING.capHours).toBe(48);
    expect(PENDING.capGold).toBe(derivedPendingCapGold());
    expect(PENDING.capGold).toBe(1300);
  });
  it('空池按期望收入到满：展开约 48 h，不展开约 49.5 h', () => {
    const empty = newLedger(nov(5)).pending;
    expect(pendingView(empty, true).hoursToFull).toBeCloseTo(47.98, 1);
    expect(pendingView(empty, false).hoursToFull).toBeCloseTo(49.52, 1);
  });
});

describe('账本：存入与收取', () => {
  it('存入不改余额；收取后余额与流水正确，auditBalance 成立', () => {
    const l = newLedger(nov(5));
    const b0 = l.balance;
    expect(deposit(l, { key: 'p1#0', gross: 5_000 })).toEqual({ pooled: 5_000, lost: 0 });
    expect(deposit(l, { key: 'p2#0', gross: 7_000 })).toEqual({ pooled: 7_000, lost: 0 });
    expect(l.balance).toBe(b0);
    expect(l.entries).toHaveLength(1); // 只有开局
    expect(l.pending).toMatchObject({ gross: 12_000, stays: 2, lost: 0 });

    const r = collect(l, nov(5, 12))!;
    expect(r).toEqual({ gross: 12_000, amount: 12_000, stays: 2 });
    expect(l.balance).toBe(b0 + 12_000);
    const e = l.entries.at(-1)!;
    expect(e).toMatchObject({ key: 'collect:0', kind: 'parking_collect', gross: 12_000, amount: 12_000, atMs: nov(5, 12) });
    expect(l.pending).toEqual({ gross: 0, stays: 0, lost: 0, lostStays: 0, collections: 1 });
    expect(auditBalance(l)).toBe(true);
    // 空池收取：不改账
    expect(collect(l, nov(5, 13))).toBeNull();
    expect(l.entries).toHaveLength(2);
  });

  it('幂等：同一 parking_id 只存一次', () => {
    const l = newLedger(nov(5));
    deposit(l, { key: 'p1#0', gross: 5_000 });
    expect(deposit(l, { key: 'p1#0', gross: 5_000 })).toEqual({ pooled: 0, lost: 0 });
    expect(l.pending.gross).toBe(5_000);
  });

  it('封顶：超出上限的部分不累积，单独记为未累积；不扣余额；收取后重新累积', () => {
    const l = newLedger(nov(5));
    const b0 = l.balance;
    deposit(l, { key: 'a', gross: cap - 3_000 });
    expect(deposit(l, { key: 'b', gross: 5_000 })).toEqual({ pooled: 3_000, lost: 2_000 }); // 部分累积
    expect(deposit(l, { key: 'c', gross: 4_000 })).toEqual({ pooled: 0, lost: 4_000 }); // 完全未累积
    expect(l.pending).toMatchObject({ gross: cap, stays: 2, lost: 6_000, lostStays: 2 });
    expect(l.balance).toBe(b0);
    expect(pendingView(l.pending, false)).toMatchObject({ full: true, hoursToFull: 0, pending: cap, lost: 6_000 });

    expect(collect(l, nov(5, 12))!.amount).toBe(cap);
    expect(l.balance).toBe(b0 + cap);
    expect(l.pending).toMatchObject({ gross: 0, lost: 0, lostStays: 0 });
    expect(deposit(l, { key: 'd', gross: 1_000 })).toEqual({ pooled: 1_000, lost: 0 });
    expect(auditBalance(l)).toBe(true);
  });

  it('跨日软上限口径：按收取时刻所在的上海日计入，不回溯到停靠离开那天', () => {
    const l = newLedger(nov(5));
    deposit(l, { key: 'a', gross: 50_000 }); // 5 日离开的停车费
    credit(l, { key: 'g5', atMs: nov(5, 20), kind: 'daily_gift', gross: 3_000, note: '' });
    collect(l, nov(6, 9)); // 6 日收取
    const e = l.entries.at(-1)!;
    expect(e.day).toBe(dayKey(nov(6, 9)));
    expect(l.today).toEqual({ day: dayKey(nov(6)), gross: 50_000, issued: 50_000 });
  });

  it('同一天多次收取超过软上限阈值：超出部分按 50% 发放，毛额与实得分开记账', () => {
    const l = newLedger(nov(5));
    const b0 = l.balance;
    deposit(l, { key: 'a', gross: cap });
    collect(l, nov(5, 1));
    deposit(l, { key: 'b', gross: cap });
    const r = collect(l, nov(5, 23))!;
    const t = ECONOMY.softCapThresholdGold * 100;
    expect(r.gross).toBe(cap);
    expect(r.amount).toBe(issuedUpTo(2 * cap) - cap); // 1300 金后再收 1300：300 全额 + 1000 × 50% = 800 金
    expect(r.amount).toBe(t - cap + (2 * cap - t) / 2);
    expect(l.balance - b0).toBe(issuedUpTo(2 * cap));
    expect(auditBalance(l)).toBe(true);
  });
});

describe('状态动作：collectPending 与开发快进', () => {
  it('快进 12 小时：停车费进池、余额只多了礼物；收取入账', () => {
    const s = newGame(nov(5, 8), 17);
    claimDailyGift(s, nov(5, 8));
    const b0 = s.ledger.balance;
    const ev = claimDailyGift(s, nov(5, 20)).events; // ?dev +12 小时 = 以 now + 12 h 回放（同一天，无新礼物）
    const departs = ev.filter((e) => e.type === 'depart' && e.gross > 0);
    expect(departs.length).toBeGreaterThan(0);
    expect(s.ledger.balance).toBe(b0);
    expect(s.ledger.pending.gross).toBe(departs.reduce((x, e) => x + (e.type === 'depart' ? e.pooled : 0), 0));
    expect(s.ledger.pending.gross).toBeGreaterThan(0);

    const pending = s.ledger.pending.gross;
    const r = collectPending(s, nov(5, 20));
    expect(r.ok).toBe(true);
    expect(r.collected!.gross).toBe(pending);
    expect(s.ledger.balance).toBe(b0 + r.collected!.amount);
    expect(s.ledger.pending.gross).toBe(0);
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('快进 3 天：待收取封顶在上限，超出部分记为未累积，余额不受影响', () => {
    const s = newGame(nov(5, 8), 17);
    claimDailyGift(s, nov(5, 8));
    const b0 = s.ledger.balance;
    const ev = claimDailyGift(s, nov(8, 8)).events; // ?dev +3 天
    const gift8 = s.ledger.entries.find((e) => e.key === `gift:${dayKey(nov(8, 8))}`)!.amount;
    const gross = ev.reduce((x, e) => x + (e.type === 'depart' ? e.gross : 0), 0);
    expect(gross).toBeGreaterThan(cap);
    expect(s.ledger.pending.gross).toBe(cap);
    expect(s.ledger.pending.lost).toBe(gross - cap);
    expect(s.ledger.balance - b0).toBe(gift8); // 停车费一分没进余额，只多了 8 日礼物
    const r = collectPending(s, nov(8, 8));
    expect(r.collected!.amount).toBe(cap);
    expect(s.ledger.pending).toMatchObject({ gross: 0, lost: 0 });
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('收取前先回放：此刻之前离开的露营者也一起收；事件返回给调用方', () => {
    const s = newGame(nov(5, 8), 3);
    const r = collectPending(s, nov(5, 20));
    expect(r.events.some((e) => e.type === 'depart')).toBe(true);
    expect(r.ok).toBe(true);
    expect(tick(s, nov(5, 20))).toEqual([]);
  });

  it('空池收取：不改账，返回提示', () => {
    const s = newGame(nov(5, 8), 3);
    const n = s.ledger.entries.length;
    const r = collectPending(s, nov(5, 8));
    expect(r).toMatchObject({ ok: false, collected: null });
    expect(s.ledger.entries).toHaveLength(n);
  });

  it('时钟回拨后收取：按有效时间入账，不抛异常', () => {
    const s = newGame(nov(5, 8), 3);
    claimDailyGift(s, nov(7));
    expect(() => collectPending(s, nov(6))).not.toThrow();
    const e = s.ledger.entries.at(-1)!;
    expect(e.kind).toBe('parking_collect');
    expect(e.atMs).toBe(nov(7));
    expect(auditBalance(s.ledger)).toBe(true);
  });
});

describe('存档兼容', () => {
  /** 造一份 v2 存档：v2 的停车费离开即入账（流水 kind = npc_parking），账本没有 pending */
  function v2Save(): { json: string; balance: number; entries: number } {
    const s = newGame(nov(5, 8), 11) as GameState & { version: number };
    claimDailyGift(s, nov(5, 8));
    credit(s.ledger, { key: 'p1#0', atMs: nov(5, 12), kind: 'npc_parking', gross: 4_200, note: '露营者停靠 252 分钟' });
    const raw = JSON.parse(JSON.stringify(s));
    delete raw.ledger.pending;
    raw.version = 2;
    return { json: JSON.stringify(raw), balance: s.ledger.balance, entries: s.ledger.entries.length };
  }

  it('v2 → v3：已入账金额与流水不丢，待收取为空；之后的停车费进池', () => {
    const { json, balance, entries } = v2Save();
    const s = loadSave(json)!;
    expect(s).not.toBeNull();
    expect(s.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(3);
    expect(s.ledger.balance).toBe(balance);
    expect(s.ledger.entries).toHaveLength(entries);
    expect(s.ledger.entries.some((e) => e.kind === 'npc_parking' && e.amount === 4_200)).toBe(true);
    expect(s.ledger.pending).toEqual({ gross: 0, stays: 0, lost: 0, lostStays: 0, collections: 0 });
    expect(auditBalance(s.ledger)).toBe(true);

    claimDailyGift(s, nov(6, 8));
    const gifts = s.ledger.entries.filter((e) => e.kind === 'daily_gift').reduce((x, e) => x + e.amount, 0);
    expect(s.ledger.pending.gross).toBeGreaterThan(0);
    expect(s.ledger.balance).toBe(ECONOMY.startingGold * 100 + gifts + 4_200);
    expect(auditBalance(s.ledger)).toBe(true);
  });

  it('v3 存档往返不变；待收取字段损坏时拒绝（调用方新开一局）', () => {
    const s = newGame(nov(5, 8), 11);
    claimDailyGift(s, nov(6, 8));
    const json = JSON.stringify(s);
    expect(JSON.stringify(loadSave(json))).toBe(json);
    const bad = JSON.parse(json);
    bad.ledger.pending.gross = -1;
    expect(loadSave(JSON.stringify(bad))).toBeNull();
    delete bad.ledger.pending;
    expect(loadSave(JSON.stringify(bad))).toBeNull();
    expect(loadSave(JSON.stringify({ ...JSON.parse(json), version: 1 }))).toBeNull();
  });

  /** 一份收取过一次、又积了一池待收取的正常存档（GPT 审核 #32 第 2 条的复现前提） */
  function collectedThenRefilled(): GameState {
    const s = newGame(nov(5, 8), 11);
    claimDailyGift(s, nov(5, 20));
    expect(collectPending(s, nov(5, 20)).ok).toBe(true);
    claimDailyGift(s, nov(6, 20));
    expect(s.ledger.pending.gross).toBeGreaterThan(0);
    expect(s.ledger.pending.collections).toBe(1);
    return s;
  }
  const corrupt = (s: GameState, f: (raw: GameState) => void) => {
    const raw = JSON.parse(JSON.stringify(s)) as GameState;
    f(raw);
    return loadSave(JSON.stringify(raw));
  };

  it('正常存档（收取过、又积累了）能加载', () => {
    const s = collectedThenRefilled();
    expect(JSON.stringify(loadSave(JSON.stringify(s)))).toBe(JSON.stringify(s));
  });

  it('收取序号回退（collections 与已有 collect 流水不一致）：拒绝加载', () => {
    const s = collectedThenRefilled();
    expect(corrupt(s, (r) => (r.ledger.pending.collections = 0))).toBeNull();
    expect(corrupt(s, (r) => (r.ledger.pending.collections = 2))).toBeNull(); // 超前也不对：流水只有 collect:0
    expect(corrupt(s, (r) => (r.ledger.entries.find((e) => e.key === 'collect:0')!.key = 'collect:7'))).toBeNull();
    expect(corrupt(s, (r) => delete r.ledger.seen['collect:0'])).toBeNull();
    expect(corrupt(s, (r) => (r.ledger.seen['collect:1'] = true))).toBeNull(); // 下一个收取键已被占用
  });

  it('待收取毛额超过池上限：拒绝加载', () => {
    const s = collectedThenRefilled();
    expect(corrupt(s, (r) => (r.ledger.pending.gross = cap + 1))).toBeNull();
    expect(corrupt(s, (r) => (r.ledger.pending.gross = cap))).not.toBeNull(); // 恰好满额是合法状态
  });

  it('笔数与金额不一致：拒绝加载', () => {
    const s = collectedThenRefilled();
    expect(corrupt(s, (r) => (r.ledger.pending.stays = 0))).toBeNull();
    expect(corrupt(s, (r) => (r.ledger.pending.lost = 100))).toBeNull(); // 有未累积金额却没有笔数
    expect(corrupt(s, (r) => (r.ledger.pending.lostStays = 1))).toBeNull();
  });

  it('收取遇到序号冲突：抛异常，不清空待收取池、不改余额', () => {
    const s = collectedThenRefilled();
    s.ledger.pending.collections = 0; // 绕过加载校验，直接在内存里制造冲突
    const before = JSON.stringify(s.ledger);
    expect(() => collect(s.ledger, nov(6, 20))).toThrow('收取序号');
    expect(JSON.stringify(s.ledger)).toBe(before);
  });
});
