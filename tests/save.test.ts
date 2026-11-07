/**
 * 多标签页存档（GPT 审核 #4 第 1 条）：修订号事务 + 单写者锁。
 */
import { describe, expect, it } from 'vitest';
import { auditBalance } from '../src/shared/ledger';
import { requestWriter, SaveSlot, type KV, type LocksLike } from '../src/shared/save';
import { buyAwning, claimDailyGift, newGame, recordPose, type GameState } from '../src/shared/state';

const T0 = Date.UTC(2026, 10, 5, 2);
const MIN = 60_000;

class MemKV implements KV {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
}

function setup() {
  const kv = new MemKV();
  const key = 'save';
  const first = new SaveSlot(kv, key);
  first.transact(newGame(T0, 17), (s) => claimDailyGift(s, T0));
  // 两个标签页各自从同一份存档启动
  const a = new SaveSlot(kv, key);
  const b = new SaveSlot(kv, key);
  return { kv, key, a, b, stateA: a.read()!, stateB: b.read()! };
}

describe('双标签页交错写入', () => {
  it('A 购买后，B 用旧内存状态结算 / 保存：不回滚购买、扣款与流水', () => {
    const { a, b, stateA, stateB } = setup();
    const before = stateA.ledger.balance;

    const ta = a.transact(stateA, (s) => buyAwning(s, T0 + MIN));
    expect(ta.result.ok).toBe(true);
    expect(ta.resynced).toBe(false);

    // B 的内存里 awningOwned=false、余额未扣：原实现会把这份旧状态整份写回
    expect(stateB.awningOwned).toBe(false);
    const tb = b.transact(stateB, (s) => claimDailyGift(s, T0 + 5 * MIN));
    expect(tb.resynced).toBe(true);
    expect(tb.state.awningOwned).toBe(true);

    const saved = b.read()!;
    expect(saved.awningOwned).toBe(true);
    // 5 分钟内同一天、NPC 停靠至少 2 h，没有新收入：余额恰好是扣款后的值
    expect(saved.ledger.balance).toBe(before - 800 * 100);
    expect(saved.ledger.entries.some((e) => e.key === 'buy:side_awning')).toBe(true);
    expect(auditBalance(saved.ledger)).toBe(true);
  });

  it('B 先驾驶保存、A 再购买、B 再保存：三次写入都保留', () => {
    const { a, b, stateA, stateB } = setup();
    let sb: GameState = stateB;
    let sa: GameState = stateA;

    sb = b.transact(sb, (s) => {
      s.player.parkedHome = false;
      return recordPose(s, T0 + MIN, { x: 3, y: 4, yaw: 0 });
    }).state;
    const ta = a.transact(sa, (s) => buyAwning(s, T0 + 2 * MIN));
    expect(ta.resynced).toBe(true); // A 看到了 B 的写入
    sa = ta.state;
    expect(sa.player.pose).toEqual({ x: 3, y: 4, yaw: 0 });

    const tb = b.transact(sb, (s) => recordPose(s, T0 + 3 * MIN, { x: 5, y: 6, yaw: 0 }));
    expect(tb.resynced).toBe(true); // B 看到了 A 的购买
    const saved = b.read()!;
    expect(saved.awningOwned).toBe(true);
    expect(saved.player.pose).toEqual({ x: 5, y: 6, yaw: 0 });
    expect(saved.rev).toBe(stateA.rev + 3);
    expect(auditBalance(saved.ledger)).toBe(true);
  });

  it('同一标签页连续写入不触发重新同步', () => {
    const { a, stateA } = setup();
    let s = stateA;
    for (let i = 1; i <= 5; i++) {
      const t = a.transact(s, (x) => claimDailyGift(x, T0 + i * MIN));
      expect(t.resynced).toBe(false);
      s = t.state;
    }
    expect(a.read()!.rev).toBe(s.rev);
  });

  it('旧存档没有修订号：读出后按 0 处理', () => {
    const s = newGame(T0, 1) as Partial<GameState>;
    delete s.rev;
    const kv = new MemKV();
    kv.setItem('k', JSON.stringify(s));
    expect(new SaveSlot(kv, 'k').read()!.rev).toBe(0);
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

  it('不支持 Web Locks 时视为写者（只靠修订号事务兜底）', () => {
    const r: boolean[] = [];
    requestWriter(undefined, 'w', false, (w) => r.push(w));
    expect(r).toEqual([true]);
  });
});
