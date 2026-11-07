/**
 * 多标签页存档（GPT 审核 #4 第 1 轮第 1 条、第 2 轮第 1 条）：IndexedDB 原子事务 + 单写者锁。
 * 用 fake-indexeddb（按 IndexedDB 规范实现的内存版）模拟浏览器：每个标签页是同一数据库的一条独立连接。
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { auditBalance } from '../src/shared/ledger';
import { IdbStore, requestWriter, sameVersion, SaveSlot, SaveSupersededError, serialQueue, type AtomicStore, type LocksLike } from '../src/shared/save';
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

describe('重开后旧标签页不能覆盖新局（第 3 轮 blocker）', () => {
  /** 旧局 seed=17 推进到 rev=2 并买了侧边帐；另一页重开为 seed=99 并推进到同样的 rev=2 */
  async function resetScenario() {
    const factory = new IDBFactory();
    const oldTab = new SaveSlot(await IdbStore.open(factory, 'camp'), KEY);
    const newTab = new SaveSlot(await IdbStore.open(factory, 'camp'), KEY);
    let old = (await oldTab.transact(newGame(T0, 17), (s) => claimDailyGift(s, T0))).state;
    old = (await oldTab.transact(old, (s) => buyAwning(s, T0 + MIN))).state;
    expect(old.rev).toBe(2);
    expect(old.awningOwned).toBe(true);

    const fresh = newGame(T0 + 2 * MIN, 99);
    await newTab.reset(fresh);
    let cur = (await newTab.read())!;
    expect(cur.rev).toBe(0);
    cur = (await newTab.transact(cur, (s) => claimDailyGift(s, T0 + 3 * MIN))).state;
    cur = (await newTab.transact(cur, (s) => claimDailyGift(s, T0 + 4 * MIN))).state;
    expect(cur.rev).toBe(old.rev); // 修订号相同，只比较 rev 分不出两局
    expect(cur.sid).not.toBe(old.sid);
    return { oldTab, newTab, old, cur };
  }

  it('复现：相同修订号下旧页写入被拒绝，新局（seed=99）保持不变', async () => {
    const { oldTab, newTab, old, cur } = await resetScenario();
    const before = JSON.stringify(await newTab.read());
    const err = await oldTab.transact(old, (s) => recordPose(s, T0 + 5 * MIN, { x: 1, y: 2, yaw: 0 })).catch((e) => e);
    expect(err).toBeInstanceOf(SaveSupersededError);
    expect((err as SaveSupersededError).latest!.seed).toBe(99);
    const saved = (await newTab.read())!;
    expect(JSON.stringify(saved)).toBe(before);
    expect(saved.seed).toBe(99);
    expect(saved.awningOwned).toBe(false); // 旧局的侧边帐没有回来
    expect(saved.ledger.entries.some((e) => e.key === 'buy:side_awning')).toBe(false);
    expect(sameVersion(saved, cur)).toBe(true);
  });

  it('旧页接管时 adoptLatest 的判断：同 rev 不同局也算“需要刷新”', async () => {
    const { oldTab, old } = await resetScenario();
    const latest = (await oldTab.read())!;
    expect(latest.rev).toBe(old.rev);
    expect(sameVersion(latest, old)).toBe(false);
    // 采纳最新存档后，旧页再写入就在新局上正常进行
    const t = await oldTab.transact(latest, (s) => claimDailyGift(s, T0 + 5 * MIN));
    expect(t.resynced).toBe(false);
    expect(t.state.seed).toBe(99);
  });

  it('重开与旧页写入同时在途：无论谁先提交，最终存档都是完整的新局', async () => {
    for (const oldFirst of [true, false]) {
      const factory = new IDBFactory();
      const oldTab = new SaveSlot(await IdbStore.open(factory, 'camp'), KEY);
      const newTab = new SaveSlot(await IdbStore.open(factory, 'camp'), KEY);
      const old = (await oldTab.transact(newGame(T0, 17), (s) => claimDailyGift(s, T0))).state;
      const fresh = newGame(T0 + MIN, 99);
      const write = () => oldTab.transact(old, (s) => buyAwning(s, T0 + 2 * MIN)).catch((e) => e);
      const reset = () => newTab.reset(fresh);
      // 事务按创建顺序串行提交
      const writeResult = oldFirst ? (await Promise.all([write(), reset()]))[0] : (await Promise.all([reset(), write()]))[1];
      if (oldFirst) expect(writeResult).not.toBeInstanceOf(Error); // 先提交的旧局写入随后被重开整份替换
      else expect(writeResult).toBeInstanceOf(SaveSupersededError);
      expect(JSON.stringify(await newTab.read())).toBe(JSON.stringify(fresh));
    }
  });

  it('存档被删除的空窗内提交：写过的旧局不会被写回，从未写过的新局可以首次写入', async () => {
    const factory = new IDBFactory();
    const store = await IdbStore.open(factory, 'camp');
    const slot = new SaveSlot(store, KEY);
    const old = (await slot.transact(newGame(T0, 17), (s) => claimDailyGift(s, T0))).state;
    await store.update(KEY, () => ({ value: null, result: undefined })); // 存档被删除（如用户清除站点数据）
    const err = await slot.transact(old, (s) => buyAwning(s, T0 + MIN)).catch((e) => e);
    expect(err).toBeInstanceOf(SaveSupersededError);
    expect((err as SaveSupersededError).latest).toBeNull();
    expect(await slot.read()).toBeNull();

    const t = await slot.transact(newGame(T0, 23), (s) => claimDailyGift(s, T0));
    expect(t.state.rev).toBe(1);
    expect((await slot.read())!.seed).toBe(23);
  });

  it('reset 只接受从未保存过的新局', async () => {
    const slot = new SaveSlot(await IdbStore.open(new IDBFactory(), 'camp'), KEY);
    const g = newGame(T0, 1);
    g.rev = 3;
    expect(() => slot.reset(g)).toThrow();
  });

  it('每局的 sid 都不同', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newGame(T0, 1).sid));
    expect(ids.size).toBe(50);
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

  it('旧版存档没有局标识：按种子确定性补齐，两次读取得到同一个 sid', () => {
    const legacy = newGame(T0, 5) as Partial<GameState>;
    delete legacy.sid;
    const json = JSON.stringify(legacy);
    expect(loadSave(json)!.sid).toBe('legacy:5');
    expect(loadSave(json)!.sid).toBe(loadSave(json)!.sid);
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
