/**
 * issue #12：换车事务未提交时出库，出库路线须按换车后的车型规划（不能用旧车型路线跳位）。
 * 用一个“提交前要等放行”的存储模拟慢提交，按 main.ts 的 act() 方式（本页队列 + 原子事务 + 提交后采纳）交错执行。
 */
import { describe, expect, it } from 'vitest';
import { stallById, staticShapes } from '../src/shared/camp';
import { departHome } from '../src/shared/depart';
import type { Shape } from '../src/shared/geom2d';
import { specOf } from '../src/shared/kinematics';
import { parkedPose, planReverseOut } from '../src/shared/parking';
import { SaveSlot, serialQueue, type AtomicStore } from '../src/shared/save';
import { claimDailyGift, currentVariant, DEFAULT_VARIANT, leaveHome, newGame, selectVariant, type GameState } from '../src/shared/state';

const T0 = Date.UTC(2026, 10, 5, 2);
const NEW_VARIANT = 'SH6601A4DB_2372';
const home = stallById('home');
const obstacles = () => staticShapes();

/** 内存存储：每次提交都要等测试调用 release() 才执行（模拟 IndexedDB 提交延迟） */
class GatedStore implements AtomicStore {
  private data = new Map<string, string>();
  private waiting: (() => void)[] = [];
  gated = false;
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async update<T>(key: string, fn: (prev: string | null) => { value?: string | null; result: T }): Promise<T> {
    if (this.gated) await new Promise<void>((r) => this.waiting.push(r));
    const out = fn(this.data.get(key) ?? null);
    if (typeof out.value === 'string') this.data.set(key, out.value);
    else if (out.value === null) this.data.delete(key);
    return out.result;
  }
  release() {
    for (const r of this.waiting.splice(0)) r();
  }
  get pending() {
    return this.waiting.length;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

/** 与 main.ts act() 相同的结构：排队 → 事务 → 提交后才采纳状态 */
async function page() {
  const store = new GatedStore();
  const slot = new SaveSlot(store, 'save');
  let state: GameState = newGame(T0, 7);
  state = (await slot.transact(state, (s) => claimDailyGift(s, T0))).state;
  const enqueue = serialQueue();
  const act = <R>(fn: (s: GameState) => R) =>
    enqueue(async () => {
      const tx = await slot.transact(state, fn);
      state = tx.state;
      return tx.result;
    });
  return { store, act, get state() {
    return state;
  } };
}

describe('换车 → 立即出库（延迟提交下交错，issue #12）', () => {
  it('两款车家位起点确实不同（复现的前提：约 0.24 m）', () => {
    const a = parkedPose(specOf(currentVariant({ variantId: DEFAULT_VARIANT } as GameState)), home);
    const b = parkedPose(specOf(currentVariant({ variantId: NEW_VARIANT } as GameState)), home);
    expect(dist(a, b)).toBeGreaterThan(0.2);
  });

  it('旧做法（队列外按画面车型规划）会用旧车型路线：用来证明下面的测试能抓到问题', async () => {
    const p = await page();
    expect(p.state.variantId).toBe(DEFAULT_VARIANT);
    p.store.gated = true;
    const swap = p.act((s) => selectVariant(s, T0, NEW_VARIANT));
    // 换车尚未提交：画面车型仍是旧车型
    const stalePlan = planReverseOut(specOf(currentVariant(p.state)), home, obstacles());
    const end = stalePlan.path[stalePlan.path.length - 1];
    const out = p.act((s) => leaveHome(s, T0, { x: end.x, y: end.y, yaw: end.yaw }));
    await flush();
    while (p.store.pending) {
      p.store.release();
      await flush();
    }
    await Promise.all([swap, out]);
    expect(p.state.variantId).toBe(NEW_VARIANT);
    const newStart = parkedPose(specOf(currentVariant(p.state)), home);
    expect(dist(stalePlan.path[0], newStart)).toBeGreaterThan(0.2); // 跳位
  });

  it('departHome 在事务内规划：路线基于新车型，起点 = 新车型家位位姿，无跳位', async () => {
    const p = await page();
    p.store.gated = true;
    const swap = p.act((s) => selectVariant(s, T0, NEW_VARIANT));
    const out = p.act((s) => departHome(s, T0, home, obstacles));
    await flush();
    expect(p.state.variantId).toBe(DEFAULT_VARIANT); // 两个事务都还没提交
    while (p.store.pending) {
      p.store.release();
      await flush();
    }
    const [sw, r] = await Promise.all([swap, out]);
    expect(sw.ok).toBe(true);
    expect(r.ok).toBe(true);
    expect(r.variantId).toBe(NEW_VARIANT);
    expect(p.state.variantId).toBe(NEW_VARIANT);

    const newSpec = specOf(currentVariant(p.state));
    const expected = planReverseOut(newSpec, home, obstacles());
    expect(r.path).toEqual(expected.path);
    expect(dist(r.path[0], parkedPose(newSpec, home))).toBeLessThan(1e-9);
    expect(r.path[0].yaw).toBeCloseTo(parkedPose(newSpec, home).yaw, 12);
    // 存档里的出库终点就是这条路线的终点
    const end = r.path[r.path.length - 1];
    expect(p.state.player).toEqual({ parkedHome: false, pose: { x: end.x, y: end.y, yaw: end.yaw } });
  });

  it('出库先排队、换车后到：换车被拒（已不在家位），路线仍是旧车型且画面车型不变', async () => {
    const p = await page();
    p.store.gated = true;
    const out = p.act((s) => departHome(s, T0, home, obstacles));
    const swap = p.act((s) => selectVariant(s, T0, NEW_VARIANT));
    await flush();
    while (p.store.pending) {
      p.store.release();
      await flush();
    }
    const [r, sw] = await Promise.all([out, swap]);
    expect(r.ok).toBe(true);
    expect(r.variantId).toBe(DEFAULT_VARIANT);
    expect(sw.ok).toBe(false);
    expect(p.state.variantId).toBe(DEFAULT_VARIANT);
  });

  it('已不在家位时出库失败，不改位姿', async () => {
    const p = await page();
    await p.act((s) => leaveHome(s, T0, { x: 1, y: 2, yaw: 0 }));
    const r = await p.act((s) => departHome(s, T0, home, obstacles));
    expect(r.ok).toBe(false);
    expect(r.path).toEqual([]);
    expect(p.state.player.pose).toEqual({ x: 1, y: 2, yaw: 0 });
  });

  it('车后被挡时出库失败，仍停在家位', async () => {
    const p = await page();
    const blockAll = (): Shape[] => [...staticShapes(), { type: 'circle', c: [home.cx, home.cy], r: 50, tag: 'wall' }];
    const r = await p.act((s) => departHome(s, T0, home, blockAll));
    expect(r.ok).toBe(false);
    expect(r.error).toBe('车后方有障碍，无法倒出');
    expect(p.state.player.parkedHome).toBe(true);
  });
});
