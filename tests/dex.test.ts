/**
 * 车型图鉴（issue #31）：25 个收集位与完成度、入场即点亮、累计次数与首次日期、自己选用也点亮、
 * 离线回放期间的到访、幂等（重做 / 重复加载不重复计）、存档迁移回填。
 */
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS, CATALOG } from '../src/data/models';
import { DEX_TOTAL, DEX_UNLOCK_HINT, dexView, emptyDex, reconcileDex, recordVisit, validDex } from '../src/shared/dex';
import { dexHtml } from '../src/client/dex';
import { dayKey, dayLabel } from '../src/shared/ledger';
import { variantForCycle, type CampEvent } from '../src/shared/npc';
import { DEFAULT_VARIANT, loadSave, newGame, selectVariant, tick, type GameState } from '../src/shared/state';

const H = 3600_000;
const T0 = Date.UTC(2026, 10, 1, 2); // 2026-11-01 10:00 上海
const reload = (s: GameState) => loadSave(JSON.stringify(s))!;
const arrivals = (ev: CampEvent[]) => ev.filter((e): e is Extract<CampEvent, { type: 'arrive' }> => e.type === 'arrive');
const totalVisits = (s: GameState) => Object.values(s.dex.entries).reduce((n, e) => n + e.visits, 0);
/** 到访次数应等于各车位已开始的露营者数：已结束循环 + 正在停靠 */
const startedStays = (s: GameState) => s.camp.spots.reduce((n, sp) => n + sp.cycle + (sp.stay ? 1 : 0), 0);

describe('收集位', () => {
  it('25 个收集位（9 款 × 各自高度，合计 25），按 9 款分组', () => {
    expect(DEX_TOTAL).toBe(25);
    const v = dexView(emptyDex());
    expect(v.total).toBe(25);
    expect(v.groups.map((g) => g.model)).toEqual(CATALOG.map((m) => m.model));
    expect(v.groups).toHaveLength(9);
    expect(v.groups.flatMap((g) => g.slots.map((x) => x.id))).toEqual(ALL_VARIANTS.map((x) => x.id));
    expect(v.lit).toBe(0);
  });

  it('新局：默认车算“开过”，完成度 1 / 25，到访 0', () => {
    const s = newGame(T0, 1);
    const v = dexView(s.dex);
    expect(v.lit).toBe(1);
    const slot = v.groups.flatMap((g) => g.slots).find((x) => x.id === DEFAULT_VARIANT)!;
    expect(slot).toMatchObject({ lit: true, driven: true, visits: 0, firstVisit: null });
  });
});

describe('点亮与计数', () => {
  it('入场即点亮：到达事件发生时就计次，不等离开；首次日期为到达那天（上海日）', () => {
    const s = newGame(T0, 7);
    let first: ReturnType<typeof arrivals>[number] | null = null;
    for (let t = T0; !first; t += 10 * 60_000) first = arrivals(tick(s, t))[0] ?? null;
    const e = s.dex.entries[first.stay.variantId];
    expect(e.visits).toBeGreaterThanOrEqual(1);
    expect(e.firstVisitMs).not.toBeNull();
    // 这位露营者还停着（入场即算）
    expect(s.camp.spots.find((sp) => sp.id === first!.spotId)!.stay!.parkingId).toBe(first.stay.parkingId);
    const slot = dexView(s.dex).groups.flatMap((g) => g.slots).find((x) => x.id === first!.stay.variantId)!;
    expect(slot.firstVisit).toBe(dayLabel(dayKey(e.firstVisitMs!)));
  });

  it('累计次数 = 全部到达事件按车型计数；首次日期 = 该车型最早的到达时刻', () => {
    const s = newGame(T0, 42);
    const all: ReturnType<typeof arrivals> = [];
    for (let t = T0; t <= T0 + 20 * 24 * H; t += 3 * H) all.push(...arrivals(tick(s, t)));
    expect(all.length).toBeGreaterThan(100);
    const want = new Map<string, { n: number; first: number }>();
    for (const e of all) {
      const w = want.get(e.stay.variantId) ?? { n: 0, first: e.atMs };
      want.set(e.stay.variantId, { n: w.n + 1, first: Math.min(w.first, e.atMs) });
    }
    for (const [id, w] of want) expect(s.dex.entries[id]).toMatchObject({ visits: w.n, firstVisitMs: w.first });
    expect(totalVisits(s)).toBe(all.length);
    expect(totalVisits(s)).toBe(startedStays(s));
  });

  it('离线回放：一次跳过 10 天，期间每位到访的露营者都计入，与逐步回放结果相同', () => {
    const a = newGame(T0, 99);
    const b = newGame(T0, 99);
    const ev = tick(a, T0 + 10 * 24 * H); // 离线 10 天后上线，一次回放
    for (let t = T0; t <= T0 + 10 * 24 * H; t += H) tick(b, t);
    expect(arrivals(ev).length).toBeGreaterThan(50);
    expect(a.dex).toEqual(b.dex);
    expect(totalVisits(a)).toBe(arrivals(ev).length);
  });

  it('25 款全部点亮后完成度 25 / 25（足够长的回放）', () => {
    const s = newGame(T0, 3);
    tick(s, T0 + 120 * 24 * H);
    expect(dexView(s.dex).lit).toBe(25);
  });

  it('玩家换车点亮该变体，只记“开过”，不算到访', () => {
    const s = newGame(T0, 1);
    const id = ALL_VARIANTS.find((x) => x.id !== DEFAULT_VARIANT)!.id;
    const before = s.dex.entries[id]?.visits ?? 0;
    expect(selectVariant(s, T0, id).ok).toBe(true);
    expect(s.dex.entries[id]).toMatchObject({ driven: true, visits: before });
  });

  it('换车失败（不在家位、未知车型）不点亮', () => {
    const s = newGame(T0, 1);
    const id = ALL_VARIANTS[5].id;
    s.player = { parkedHome: false, pose: { x: 0, y: 0, yaw: 0 } };
    expect(selectVariant(s, T0, id).ok).toBe(false);
    expect(selectVariant(s, T0, 'nope').ok).toBe(false);
    expect(s.dex.entries[id]?.driven ?? false).toBe(false);
    expect(s.dex.entries.nope).toBeUndefined();
  });
});

describe('幂等', () => {
  it('同一位露营者（同车位同循环）重复记录只计一次', () => {
    const d = emptyDex();
    const id = ALL_VARIANTS[0].id;
    expect(recordVisit(d, 'p1', 0, id, T0)).toBe(true);
    expect(recordVisit(d, 'p1', 0, id, T0)).toBe(false);
    expect(d.entries[id].visits).toBe(1);
    expect(recordVisit(d, 'p2', 0, id, T0 + H)).toBe(true);
    expect(d.entries[id]).toMatchObject({ visits: 2, firstVisitMs: T0 });
  });

  it('反复存取档不改变图鉴', () => {
    const s = newGame(T0, 5);
    tick(s, T0 + 5 * 24 * H);
    const once = reload(s);
    expect(once.dex).toEqual(s.dex);
    expect(reload(reload(once)).dex).toEqual(s.dex);
  });
});

describe('存档迁移', () => {
  /** 模拟图鉴加入前的存档：去掉 dex 字段 */
  function legacy(s: GameState): string {
    const o = JSON.parse(JSON.stringify(s));
    delete o.dex;
    return JSON.stringify(o);
  }

  it('旧存档（无 dex）不报错；按种子回填已离开露营者的车型与次数，日期记为未记录；正在停靠的按实际到达时刻', () => {
    const s = newGame(T0, 11);
    tick(s, T0 + 6 * 24 * H);
    const truth = s.dex;
    const m = loadSave(legacy(s))!;
    expect(m).not.toBeNull();
    expect(validDex(m.dex)).toBe(true);
    // 次数逐车型与真实记录相同
    for (const v of ALL_VARIANTS) expect(m.dex.entries[v.id]?.visits ?? 0).toBe(truth.entries[v.id]?.visits ?? 0);
    expect(totalVisits(m)).toBe(startedStays(m));
    // 正在停靠的露营者：首次日期不晚于其到达时刻（若该车型之前没来过则恰为到达时刻），其余为 null
    for (const sp of m.camp.spots) {
      if (!sp.stay) continue;
      const e = m.dex.entries[sp.stay.variantId];
      if (e.visits === 1) expect(e.firstVisitMs).toBe(sp.stay.arriveMs);
    }
    const unknown = dexView(m.dex).groups.flatMap((g) => g.slots).filter((x) => x.firstVisit === 'unknown');
    expect(unknown.length).toBeGreaterThan(0);
    // 当前车型记为开过
    expect(m.dex.entries[m.variantId].driven).toBe(true);
  });

  it('回填用的车型与 NPC 回放实际选用的车型一致（variantForCycle）', () => {
    const s = newGame(T0, 23);
    const seen: Array<{ spot: string; id: string; parkingId: string }> = [];
    for (let t = T0; t <= T0 + 3 * 24 * H; t += H) for (const e of arrivals(tick(s, t))) seen.push({ spot: e.spotId, id: e.stay.variantId, parkingId: e.stay.parkingId });
    for (const x of seen) expect(variantForCycle(s.seed, x.spot, Number(x.parkingId.split('#')[1]))).toBe(x.id);
  });

  it('旧版本标签页写过的存档（图鉴漏计了后来的到访）：加载时补上，已有日期不变', () => {
    const s = newGame(T0, 31);
    tick(s, T0 + 2 * 24 * H);
    const snapshot = JSON.parse(JSON.stringify(s.dex));
    // 旧标签页继续回放，但不认识 dex 字段，原样带回
    const old = loadSave(JSON.stringify(s))!;
    tick({ ...old, dex: emptyDex() }, T0 + 4 * 24 * H); // 用一个丢弃的图鉴模拟“旧代码不记图鉴”
    const written = { ...old, dex: snapshot };
    const m = loadSave(JSON.stringify(written))!;
    expect(totalVisits(m)).toBe(startedStays(m));
    for (const [id, e] of Object.entries(snapshot.entries as Record<string, { firstVisitMs: number | null }>)) {
      if (e.firstVisitMs !== null) expect(m.dex.entries[id].firstVisitMs).toBe(e.firstVisitMs);
    }
  });

  it('dex 结构损坏时重建，不拒绝整份存档', () => {
    const s = newGame(T0, 13);
    tick(s, T0 + 24 * H);
    const o = JSON.parse(JSON.stringify(s));
    o.dex = { entries: { x: { visits: -1 } }, counted: 'bad' };
    const m = loadSave(JSON.stringify(o))!;
    expect(m).not.toBeNull();
    expect(validDex(m.dex)).toBe(true);
    expect(totalVisits(m)).toBe(startedStays(m));
  });

  it('reconcileDex 对新局不计任何到访', () => {
    const s = newGame(T0, 2);
    const d = emptyDex();
    reconcileDex(d, s.camp);
    expect(d.entries).toEqual({});
  });
});

describe('面板', () => {
  it('完成度、已点亮信息与未点亮的解锁条件', () => {
    const s = newGame(T0, 8);
    tick(s, T0 + 24 * H);
    const v = dexView(s.dex);
    const html = dexHtml(v);
    expect(html).toContain(`已点亮 ${v.lit} / 25`);
    const on = v.groups.flatMap((g) => g.slots).find((x) => x.visits > 0)!;
    expect(html).toContain(`首次到访 ${on.firstVisit}`);
    expect(html).toContain(`累计到访 ${on.visits} 次`);
    if (v.lit < 25) expect(html).toContain(DEX_UNLOCK_HINT);
    expect(html).toContain('1/25');
    expect(html).toContain('没有抽取、没有付费');
  });

  it('升级前回填的到访显示“日期未记录”', () => {
    const d = emptyDex();
    recordVisit(d, 'p1', 0, ALL_VARIANTS[3].id, null);
    expect(dexHtml(dexView(d))).toContain('升级前，日期未记录');
  });
});
