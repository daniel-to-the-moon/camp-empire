/**
 * 客户端换车 / 出库衔接（src/client/homeflow.ts，main.ts 的 variant / out 就是它）的回归测试（GPT 审核 #14 第 1、2 条）。
 *
 * 存档走真实的 SaveSlot + serialQueue，提交可延迟；画面用一个按 main.ts rebuildPlayer / startAuto 语义写的假视图。
 * act() 的返回还可以“扣住”，用来覆盖 variant 与 out 的后续代码谁先跑的两种顺序。
 */
import { describe, expect, it } from 'vitest';
import { homeFlow, type Mode } from '../src/client/homeflow';
import { stallById, staticShapes } from '../src/shared/camp';
import type { Shape } from '../src/shared/geom2d';
import { specOf, type Pose } from '../src/shared/kinematics';
import type { CampEvent } from '../src/shared/npc';
import { parkedPose, planReverseOut, type PathPose } from '../src/shared/parking';
import { SaveSlot, serialQueue, type AtomicStore } from '../src/shared/save';
import { claimDailyGift, currentVariant, DEFAULT_VARIANT, newGame, type GameState } from '../src/shared/state';

const T0 = Date.UTC(2026, 10, 5, 2);
const NEW_VARIANT = 'SH6601A4DB_2372';
const home = stallById('home');

/** 内存存储：gated 时每次提交都要等 release()；failNext 时下一次提交抛错（模拟 IndexedDB 写入失败） */
class GatedStore implements AtomicStore {
  private data = new Map<string, string>();
  private waiting: (() => void)[] = [];
  gated = false;
  failNext = false;
  async get(key: string) {
    return this.data.get(key) ?? null;
  }
  async update<T>(key: string, fn: (prev: string | null) => { value?: string | null; result: T }): Promise<T> {
    if (this.gated) await new Promise<void>((r) => this.waiting.push(r));
    if (this.failNext) {
      this.failNext = false;
      throw new Error('写入失败');
    }
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

type Log = { kind: 'rebuild'; variantId: string; pose: Pose } | { kind: 'start'; path: PathPose[]; viewVariantId: string; viewPose: Pose };

async function page(opts: { obstacles?: () => Shape[] } = {}) {
  const store = new GatedStore();
  const slot = new SaveSlot(store, 'save');
  let state: GameState = newGame(T0, 7);
  state = (await slot.transact(state, (s) => claimDailyGift(s, T0))).state;

  // ---- 假视图：语义同 main.ts ----
  let mode: Mode = 'parked';
  let viewVariant = state.variantId;
  let pose: Pose = parkedPose(specOf(currentVariant(state)), home);
  let autoPath: PathPose[] | null = null;
  const log: Log[] = [];
  const toasts: string[] = [];

  // ---- act：与 main.ts 相同（排队 → 事务 → 提交后采纳；失败返回 null 并提示），返回值可被扣住 ----
  const enqueue = serialQueue();
  let holding = false;
  const held: (() => void)[] = [];
  const act = <R extends { events: CampEvent[] }>(fn: (s: GameState) => R): Promise<R | null> => {
    const p = enqueue(async () => {
      try {
        const tx = await slot.transact(state, fn);
        state = tx.state;
        return tx.result;
      } catch {
        toasts.push('存档写入失败，这次操作没有生效');
        return null;
      }
    });
    if (!holding) return p;
    return p.then((v) => new Promise<R | null>((res) => held.push(() => res(v))));
  };

  const lock = { busy: false };
  const flow = homeFlow({
    act,
    state: () => state,
    mode: () => mode,
    now: () => T0,
    home,
    obstacles: opts.obstacles ?? (() => staticShapes()),
    viewVariantId: () => viewVariant,
    rebuildPlayer: () => {
      viewVariant = state.variantId;
      if (mode === 'parked') pose = parkedPose(specOf(currentVariant(state)), home);
      log.push({ kind: 'rebuild', variantId: viewVariant, pose: { ...pose } });
    },
    setAwning: () => {},
    startAuto: (path) => {
      mode = 'auto';
      autoPath = path;
      pose = { x: path[0].x, y: path[0].y, yaw: path[0].yaw };
      log.push({ kind: 'start', path, viewVariantId: viewVariant, viewPose: pose });
    },
    onDeparted: () => {
      mode = 'driving';
    },
    toast: (m) => toasts.push(m),
    lock,
  });

  async function drain() {
    await flush();
    while (store.pending) {
      store.release();
      await flush();
    }
  }

  return {
    store,
    flow,
    lock,
    log,
    toasts,
    drain,
    hold: () => (holding = true),
    /** 按给定顺序放行被扣住的 act 返回（下标为 act 调用顺序） */
    deliver: async (order: number[]) => {
      const list = [...held];
      for (const i of order) {
        list[i]();
        await flush();
      }
    },
    get state() {
      return state;
    },
    get mode() {
      return mode;
    },
    get autoPath() {
      return autoPath;
    },
    get viewVariant() {
      return viewVariant;
    },
    get pose() {
      return pose;
    },
  };
}

/** 起步那一刻：画面车型 = 路线车型 = 存档车型，路线起点与画面位姿重合，且是新车型的家位位姿 */
function expectNoJump(p: Awaited<ReturnType<typeof page>>) {
  const starts = p.log.filter((l) => l.kind === 'start');
  expect(starts).toHaveLength(1);
  const s = starts[0] as Extract<Log, { kind: 'start' }>;
  const newSpec = specOf(currentVariant(p.state));
  expect(p.state.variantId).toBe(NEW_VARIANT);
  expect(s.viewVariantId).toBe(NEW_VARIANT);
  expect(s.path).toEqual(planReverseOut(newSpec, home, staticShapes()).path);
  expect(dist(s.path[0], parkedPose(newSpec, home))).toBeLessThan(1e-9);
  // 起步前画面的最后一次重建就落在新车型家位：重建位姿 = 路线起点
  const lastRebuild = p.log.filter((l) => l.kind === 'rebuild').at(-1) as Extract<Log, { kind: 'rebuild' }>;
  expect(p.log.indexOf(lastRebuild)).toBeLessThan(p.log.indexOf(s));
  expect(dist(lastRebuild.pose, s.path[0])).toBeLessThan(1e-9);
}

describe('客户端：换车 → 立即出库（延迟提交，issue #12）', () => {
  it('换车后续先跑：换车重建一次，出库不再重建，按新车型起步', async () => {
    const p = await page();
    p.store.gated = true;
    const sw = p.flow.variant(NEW_VARIANT);
    const out = p.flow.out();
    await p.drain();
    await Promise.all([sw, out]);
    expectNoJump(p);
    expect(p.log.filter((l) => l.kind === 'rebuild')).toHaveLength(1);
    expect(p.mode).toBe('auto');
  });

  it('出库后续先跑：出库先按新车型重建再起步；之后换车后续不再重建，不打断进行中的路线', async () => {
    const p = await page();
    p.store.gated = true;
    p.hold();
    const sw = p.flow.variant(NEW_VARIANT); // act #0
    const out = p.flow.out(); // act #1
    await p.drain();
    await p.deliver([1]); // 出库后续先跑
    expectNoJump(p);
    const pathAtStart = p.autoPath;
    await p.deliver([0]); // 换车后续后跑
    await Promise.all([sw, out]);
    expect(p.log.filter((l) => l.kind === 'rebuild')).toHaveLength(1);
    expect(p.log.at(-1)!.kind).toBe('start'); // 起步之后没有任何重建
    expect(p.mode).toBe('auto');
    expect(p.autoPath).toBe(pathAtStart);
  });

  it('出库先排队、换车后到：按旧车型起步，换车被拒并提示，画面不重建', async () => {
    const p = await page();
    p.store.gated = true;
    const out = p.flow.out();
    const sw = p.flow.variant(NEW_VARIANT);
    await p.drain();
    await Promise.all([out, sw]);
    expect(p.state.variantId).toBe(DEFAULT_VARIANT);
    expect(p.log.map((l) => l.kind)).toEqual(['start']);
    expect(p.toasts).toHaveLength(1); // 换车被拒的原因
    const s = p.log[0] as Extract<Log, { kind: 'start' }>;
    expect(s.viewVariantId).toBe(DEFAULT_VARIANT);
    expect(dist(s.path[0], parkedPose(specOf(currentVariant(p.state)), home))).toBeLessThan(1e-9);
  });
});

describe('客户端：出库失败', () => {
  it('车后被挡：提示原因，不起步，仍停在家位，释放锁', async () => {
    const wall: Shape = { type: 'circle', c: [home.cx, home.cy], r: 50, tag: 'wall' };
    const p = await page({ obstacles: () => [...staticShapes(), wall] });
    expect(await p.flow.out()).toBe(false);
    expect(p.toasts).toEqual(['车后方有障碍，无法倒出']);
    expect(p.log).toEqual([]);
    expect(p.mode).toBe('parked');
    expect(p.state.player.parkedHome).toBe(true);
    expect(p.lock.busy).toBe(false);
  });

  it('提交失败：不起步、不重建，状态不变，释放锁', async () => {
    const p = await page();
    p.store.failNext = true;
    expect(await p.flow.out()).toBe(false);
    expect(p.toasts).toEqual(['存档写入失败，这次操作没有生效']);
    expect(p.log).toEqual([]);
    expect(p.mode).toBe('parked');
    expect(p.state.player.parkedHome).toBe(true);
    expect(p.lock.busy).toBe(false);
  });

  it('提交等待中重复按 O：只出库一次', async () => {
    const p = await page();
    p.store.gated = true;
    const a = p.flow.out();
    const b = p.flow.out();
    expect(p.lock.busy).toBe(true);
    await p.drain();
    // 返回值决定是否计 drive_out（Codex 审核 #66）：只有真正起步的那次为 true
    expect(await Promise.all([a, b])).toEqual([true, false]);
    expect(p.log.filter((l) => l.kind === 'start')).toHaveLength(1);
    // 已经开出去了再按 O：不起步，也不计数
    expect(await p.flow.out()).toBe(false);
  });
});
