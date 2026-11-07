/**
 * 多标签页存档（GPT 审核 #4 第 1 轮第 1 条、第 2 轮第 1 条）：IndexedDB 原子事务 + 单写者锁。
 * 用 fake-indexeddb（按 IndexedDB 规范实现的内存版）模拟浏览器：每个标签页是同一数据库的一条独立连接。
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { auditBalance } from '../src/shared/ledger';
import { IdbStore, requestWriter, SaveSlot, serialQueue, type AtomicStore, type LocksLike } from '../src/shared/save';
import { buyAwning, claimDailyGift, loadSave, newGame, recordPose, type GameState } from '../src/shared/state';

const T0 = Date.UTC(2026, 10, 5, 2);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KEY = 'save';

/** 一个浏览器（同源共享同一 IndexedDB）里打开 n 个标签页，第一个先建好存档并领完当天礼物 */
async function tabs(n: number) {
  const factory = new IDBFactory();
  const slots: SaveSlot[] = [];
  for (let i = 0; i < n; i++) slots.push(new SaveSlot(await IdbStore.open(factory, 'camp'), KEY));
  await slots[0].transact(newGame(T0, 17), (s) => claimDailyGift(s, T0));
  const states: GameState[] = [];
  for (const s of slots) states.push((await s.read())!);
  return { slots, states };
}

/** 把同样的动作按顺序作用在一份副本上，得到不丢写时应有的结果 */
function sequential(base: GameState, ...fns: ((s: GameState) => unknown)[]): GameState {
  const s = loadSave(JSON.stringify(base))!;
  for (const f of fns) f(s);
  return s;
}

describe('两个标签页读到同一修订号后交错提交（第 2 轮 blocker）', () => {
  it('A 购买、B 领礼物同时提交：购买、扣款、礼物与流水都保留', async () => {
    const {
      slots: [a, b],
      states: [sa, sb],
    } = await tabs(2);
    expect(sa.rev).toBe(sb.rev); // 两页内存里是同一修订号
    const buy = (s: GameState) => buyAwning(s, T0 + MIN);
    const gift = (s: GameState) => claimDailyGift(s, T0 + DAY);

    // 不等待：两个事务同时在途
    const [ta, tb] = await Promise.all([a.transact(sa, buy), b.transact(sb, gift)]);
    expect(ta.result.ok).toBe(true);
    expect(tb.result.gift).not.toBeNull();
    expect([ta.resynced, tb.resynced].sort()).toEqual([false, true]); // 后提交的那个看到了前者的写入

    const saved = (await a.read())!;
    const expected = sequential(sa, buy, gift);
    expect(saved.awningOwned).toBe(true);
    expect(saved.ledger.balance).toBe(expected.ledger.balance);
    expect(saved.ledger.entries.map((e) => e.key)).toEqual(expected.ledger.entries.map((e) => e.key));
    expect(saved.ledger.entries.some((e) => e.key === 'buy:side_awning')).toBe(true);
    expect(saved.rev).toBe(sa.rev + 2);
    expect(auditBalance(saved.ledger)).toBe(true);
  });

  it('两页同时购买：只扣一次款，第二次在最新存档上返回“已拥有”', async () => {
    const {
      slots: [a, b],
      states: [sa, sb],
    } = await tabs(2);
    const before = sa.ledger.balance;
    const [ta, tb] = await Promise.all([a.transact(sa, (s) => buyAwning(s, T0 + MIN)), b.transact(sb, (s) => buyAwning(s, T0 + MIN))]);
    expect([ta.result.ok, tb.result.ok].sort()).toEqual([false, true]);
    const saved = (await b.read())!;
    expect(saved.ledger.balance).toBe(before - 800 * 100);
    expect(saved.ledger.entries.filter((e) => e.key === 'buy:side_awning')).toHaveLength(1);
    expect(auditBalance(saved.ledger)).toBe(true);
  });

  it('三页各自用旧内存并发写 30 次：修订号逐一递增，没有任何一次写入丢失', async () => {
    const { slots, states } = await tabs(3);
    const base = states[0].rev;
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 10; i++) {
      slots.forEach((slot, k) => {
        const t = T0 + (i * 3 + k + 1) * MIN;
        jobs.push(slot.transact(states[k], (s) => (k === 1 && i === 4 ? buyAwning(s, t) : claimDailyGift(s, t))));
      });
    }
    await Promise.all(jobs);
    const saved = (await slots[2].read())!;
    expect(saved.rev).toBe(base + 30);
    expect(saved.awningOwned).toBe(true);
    expect(saved.ledger.entries.some((e) => e.key === 'buy:side_awning')).toBe(true);
    expect(auditBalance(saved.ledger)).toBe(true);
  });

  it('对照：读改写不在同一事务里（上一版 localStorage 的情形）时，同样的交错会丢掉购买', async () => {
    // 证明上面的用例确实能检出竞争：get 与 put 之间让出执行权，另一页插进来
    const m = new Map<string, string>();
    const racy: AtomicStore = {
      async get(k) {
        return m.get(k) ?? null;
      },
      async update(k, fn) {
        const prev = m.get(k) ?? null;
        await new Promise((r) => setTimeout(r, 0));
        const r = fn(prev);
        if (typeof r.value === 'string') m.set(k, r.value);
        return r.result;
      },
    };
    const first = new SaveSlot(racy, KEY);
    await first.transact(newGame(T0, 17), (s) => claimDailyGift(s, T0));
    const sa = (await first.read())!;
    const sb = (await first.read())!;
    await Promise.all([
      new SaveSlot(racy, KEY).transact(sa, (s) => buyAwning(s, T0 + MIN)),
      new SaveSlot(racy, KEY).transact(sb, (s) => claimDailyGift(s, T0 + DAY)),
    ]);
    expect(loadSave(m.get(KEY)!)!.awningOwned).toBe(false); // 购买被覆盖
  });
});

describe('顺序写入与事务细节', () => {
  it('B 先驾驶保存、A 再购买、B 再保存：三次写入都保留', async () => {
    const {
      slots: [a, b],
      states: [sa0, sb0],
    } = await tabs(2);
    const sb = (
      await b.transact(sb0, (s) => {
        s.player.parkedHome = false;
        return recordPose(s, T0 + MIN, { x: 3, y: 4, yaw: 0 });
      })
    ).state;
    const ta = await a.transact(sa0, (s) => buyAwning(s, T0 + 2 * MIN));
    expect(ta.resynced).toBe(true);
    expect(ta.state.player.pose).toEqual({ x: 3, y: 4, yaw: 0 });

    const tb = await b.transact(sb, (s) => recordPose(s, T0 + 3 * MIN, { x: 5, y: 6, yaw: 0 }));
    expect(tb.resynced).toBe(true);
    const saved = (await b.read())!;
    expect(saved.awningOwned).toBe(true);
    expect(saved.player.pose).toEqual({ x: 5, y: 6, yaw: 0 });
    expect(saved.rev).toBe(sa0.rev + 3);
    expect(auditBalance(saved.ledger)).toBe(true);
  });

  it('同一标签页按顺序连续写入不触发重新同步', async () => {
    const {
      slots: [a],
      states: [s0],
    } = await tabs(1);
    let s = s0;
    for (let i = 1; i <= 5; i++) {
      const t = await a.transact(s, (x) => claimDailyGift(x, T0 + i * MIN));
      expect(t.resynced).toBe(false);
      s = t.state;
    }
    expect((await a.read())!.rev).toBe(s.rev);
  });

  it('动作抛异常：事务回滚，存档与调用方内存状态都不变', async () => {
    const {
      slots: [a],
      states: [s],
    } = await tabs(1);
    const before = JSON.stringify(s);
    await expect(
      a.transact(s, (x) => {
        x.ledger.balance = -1;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(JSON.stringify(s)).toBe(before);
    expect(JSON.stringify(await a.read())).toBe(before);
  });

  it('旧版 localStorage 存档：存档为空时导入一次，之后不再覆盖', async () => {
    const slot = new SaveSlot(await IdbStore.open(new IDBFactory(), 'camp'), KEY);
    const legacy = newGame(T0, 1) as Partial<GameState>;
    delete legacy.rev; // 修订号加入前的存档
    expect(await slot.importIfEmpty(JSON.stringify(legacy))).toBe(true);
    const imported = (await slot.read())!;
    expect(imported.rev).toBe(0);
    expect(await slot.importIfEmpty(JSON.stringify(newGame(T0, 2)))).toBe(false);
    expect(JSON.stringify(await slot.read())).toBe(JSON.stringify(imported));
    expect(await new SaveSlot(await IdbStore.open(new IDBFactory(), 'x'), KEY).importIfEmpty('坏数据')).toBe(false);
  });

  it('clear 删除存档', async () => {
    const {
      slots: [a],
    } = await tabs(1);
    await a.clear();
    expect(await a.read()).toBeNull();
  });

  it('serialQueue：按调用顺序执行，前一个失败不影响后一个', async () => {
    const q = serialQueue();
    const log: number[] = [];
    const slow = q(async () => {
      await new Promise((r) => setTimeout(r, 5));
      log.push(1);
    });
    const bad = q(async () => {
      log.push(2);
      throw new Error('x');
    });
    const fast = q(async () => log.push(3));
    await Promise.allSettled([slow, bad, fast]);
    expect(log).toEqual([1, 2, 3]);
    await expect(bad).rejects.toThrow('x');
  });
});

/** Web Locks 的最小替身：独占锁，支持 ifAvailable 与 steal */
class FakeLocks implements LocksLike {
  private holder: ((e: Error) => void) | null = null;
  request(_name: string, opts: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown> {
    if (opts.ifAvailable && this.holder) return Promise.resolve(cb(null));
    if (opts.steal && this.holder) this.holder(new Error('AbortError'));
    return new Promise((resolve, reject) => {
      this.holder = reject;
      Promise.resolve(cb({})).then(resolve, reject);
    });
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('单写者锁', () => {
  it('第一个标签页拿到写权，第二个只读；第二个抢过写权后第一个转为只读', async () => {
    const locks = new FakeLocks();
    const a: boolean[] = [];
    const b: boolean[] = [];
    requestWriter(locks, 'w', false, (w) => a.push(w));
    await flush();
    requestWriter(locks, 'w', false, (w) => b.push(w));
    await flush();
    expect(a).toEqual([true]);
    expect(b).toEqual([false]);

    requestWriter(locks, 'w', true, (w) => b.push(w));
    await flush();
    expect(b).toEqual([false, true]);
    expect(a).toEqual([true, false]);
  });

  it('不支持 Web Locks 时没有可靠的单写者：只读，并返回 false 供界面提示', () => {
    const r: boolean[] = [];
    expect(requestWriter(undefined, 'w', false, (w) => r.push(w))).toBe(false);
    expect(r).toEqual([false]);
  });
});
