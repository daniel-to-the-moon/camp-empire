/**
 * 开发快进偏移与局标识绑定（issue #11）。
 * 复现：A 页在 ?dev 下快进一天；B 页接管并重开；A 页再接管新局。
 * 上一版 A 页内存里的旧偏移仍在，A 接管后按“真实时间 + 一天”回放新局：提前结算、领未来日期的礼物，
 * 之后又被 effectiveNow 冻结。
 *
 * 用 fake-indexeddb 模拟两页共享的存档、用内存 Storage 模拟两页共享的 localStorage；
 * Page 按 src/client/main.ts 的接线复刻：now() = clock.now(state.sid)，adoptState 先 clock.adopt(sid)，
 * 接管写权时先以存档为准（adoptLatest）再 startSession（claimDailyGift(now())）。
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import main from '../src/client/main.ts?raw';
import { DevClock, freshGameAt, parseDevOffset, resetSave, type StorageLike } from '../src/shared/devgate';
import { dayKey } from '../src/shared/ledger';
import type { CampEvent } from '../src/shared/npc';
import { IdbStore, sameVersion, SaveSlot, SaveSupersededError } from '../src/shared/save';
import { claimDailyGift, effectiveNow, type GameState } from '../src/shared/state';

const T0 = Date.UTC(2026, 10, 5, 2);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const KEY = 'camp-empire.devOffsetMs';

class MemStorage implements StorageLike {
  readonly m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** 时钟接口：现实现（DevClock）与上一版行为（与局无关的全局偏移）共用，便于对照 */
interface Clock {
  now(sid: string): number;
  forward(sid: string, ms: number): void;
  adopt(sid: string): void;
  clear(): void;
}

/** 上一版行为：偏移是全局数，采纳另一局时不失效 */
class LegacyClock implements Clock {
  private ms: number;
  constructor(
    private readonly storage: StorageLike,
    private readonly realNow: () => number,
  ) {
    this.ms = Number(storage.getItem(KEY) ?? 0) || 0;
  }
  now() {
    return this.realNow() + this.ms;
  }
  forward(_sid: string, ms: number) {
    this.ms += ms;
    this.storage.setItem(KEY, String(this.ms));
  }
  adopt() {}
  clear() {
    this.ms = 0;
    this.storage.removeItem(KEY);
  }
}

type MakeClock = (storage: StorageLike, realNow: () => number) => Clock;
const current: MakeClock = (st, rn) => new DevClock(st, KEY, rn);
const legacy: MakeClock = (st, rn) => new LegacyClock(st, rn);

/** 一个标签页（按 main.ts 的接线） */
class Page {
  state!: GameState;
  readonly clock: Clock;
  constructor(
    readonly slot: SaveSlot,
    storage: StorageLike,
    readonly realNow: () => number,
    make: MakeClock,
  ) {
    this.clock = make(storage, realNow);
  }
  now() {
    return this.clock.now(this.state.sid);
  }
  async load(seed: number) {
    this.state = (await this.slot.read()) ?? freshGameAt(this.realNow(), seed);
  }
  adoptState(s: GameState) {
    this.clock.adopt(s.sid);
    this.state = s;
  }
  async act<R>(fn: (s: GameState) => R): Promise<R | null> {
    try {
      const tx = await this.slot.transact(this.state, fn);
      this.state = tx.state;
      return tx.result;
    } catch (e) {
      if (e instanceof SaveSupersededError && e.latest) {
        this.adoptState(e.latest);
        return null;
      }
      throw e;
    }
  }
  /** 拿到写权：先以存档为准，再开局（离线回放 + 每日礼物） */
  async takeover() {
    const latest = await this.slot.read();
    if (latest && !sameVersion(latest, this.state)) this.adoptState(latest);
    return this.act((s) => claimDailyGift(s, this.now()));
  }
}

async function scenario(make: MakeClock) {
  const slot = new SaveSlot(await IdbStore.open(new IDBFactory(), 'camp'), 'save');
  const storage = new MemStorage();
  let real = T0;
  const realNow = () => real;

  // A 页：建局、开局，然后快进一天
  const a = new Page(slot, storage, realNow, make);
  await a.load(17);
  await a.takeover();
  a.clock.forward(a.state.sid, DAY);
  await a.act((s) => claimDailyGift(s, a.now()));
  const oldSid = a.state.sid;

  // B 页：打开、接管、重开存档（替换成功后清偏移）
  real = T0 + MIN;
  const b = new Page(slot, storage, realNow, make);
  await b.load(23);
  await b.takeover();
  const resetAt = real;
  await resetSave({ realNowMs: resetAt, seed: 99, replace: (fresh) => slot.reset(fresh), clearDevState: () => b.clock.clear() });

  // A 页再接管（内存里还留着旧局与旧偏移）
  real = T0 + 2 * MIN;
  const takeoverAt = real;
  const r = await a.takeover();
  return { slot, storage, a, r, oldSid, resetAt, takeoverAt };
}

describe('双标签页：快进 → 另一页重开 → 旧页接管', () => {
  it('新局时间从真实当前时间开始、无提前结算、礼物日期正确', async () => {
    const { slot, storage, a, r, oldSid, resetAt, takeoverAt } = await scenario(current);
    expect(a.state.sid).not.toBe(oldSid);
    expect(a.state.seed).toBe(99);

    // 本页偏移已失效，本地存储里也没有偏移
    expect(a.now()).toBe(takeoverAt);
    expect(storage.getItem(KEY)).toBeNull();

    // 时间：回放只到真实当前时间，有效时间不被冻结
    const saved = (await slot.read())!;
    expect(saved.sid).toBe(a.state.sid);
    expect(saved.camp.lastMs).toBe(takeoverAt);
    expect(effectiveNow(saved, takeoverAt)).toBe(takeoverAt);

    // 无提前结算：没有露营者离开（停车费），事件都不晚于真实当前时间
    expect(r).not.toBeNull();
    const events: CampEvent[] = r!.events;
    expect(events.filter((e) => e.type === 'depart')).toEqual([]);
    for (const e of events) expect(e.atMs).toBeLessThanOrEqual(takeoverAt);
    for (const sp of saved.camp.spots) if (sp.nextArrivalMs !== null && sp.nextArrivalMs !== undefined) expect(sp.nextArrivalMs).toBeGreaterThan(resetAt);

    // 礼物：按真实当天发放
    expect(r!.gift).not.toBeNull();
    expect(saved.lastGiftDay).toBe(dayKey(takeoverAt));
    expect(saved.ledger.today.day).toBe(dayKey(takeoverAt));
  });

  it('对照：恢复上一版（偏移与局无关）时，同一流程新局被推进一天、领到未来日期的礼物', async () => {
    const { slot, a, r, takeoverAt } = await scenario(legacy);
    const saved = (await slot.read())!;
    expect(a.now()).toBe(takeoverAt + DAY);
    expect(saved.camp.lastMs).toBe(takeoverAt + DAY);
    expect(effectiveNow(saved, takeoverAt)).toBe(takeoverAt + DAY); // 偏移清除后会被冻结在未来
    expect(r!.events.some((e) => e.type === 'depart')).toBe(true); // 提前结算
    expect(saved.lastGiftDay).toBe(dayKey(takeoverAt + DAY));
    expect(saved.lastGiftDay).not.toBe(dayKey(takeoverAt));
  });
});

describe('DevClock', () => {
  const real = () => T0;

  it('偏移只对记录它的那一局生效', () => {
    const st = new MemStorage();
    const c = new DevClock(st, KEY, real);
    c.forward('x', DAY);
    expect(c.now('x')).toBe(T0 + DAY);
    expect(c.now('y')).toBe(T0);
    expect(c.offsetFor('y')).toBe(0);
    c.forward('x', MIN);
    expect(c.offsetFor('x')).toBe(DAY + MIN);
    // 另一局快进从 0 起算，并取代旧局的偏移
    c.forward('y', MIN);
    expect(c.offsetFor('y')).toBe(MIN);
    expect(c.offsetFor('x')).toBe(0);
    expect(parseDevOffset(st.getItem(KEY))).toEqual({ sid: 'y', ms: MIN });
  });

  it('重载后从本地存储恢复同一局的偏移', () => {
    const st = new MemStorage();
    new DevClock(st, KEY, real).forward('x', DAY);
    const c = new DevClock(st, KEY, real);
    expect(c.offsetFor('x')).toBe(DAY);
    expect(c.offsetFor('y')).toBe(0);
  });

  it('adopt：别的局的偏移在内存和本地存储里都失效；同一局保留', () => {
    const st = new MemStorage();
    const c = new DevClock(st, KEY, real);
    c.forward('x', DAY);
    c.adopt('x');
    expect(c.offsetFor('x')).toBe(DAY);
    expect(st.getItem(KEY)).not.toBeNull();
    c.adopt('y');
    expect(c.offsetFor('x')).toBe(0);
    expect(c.offsetFor('y')).toBe(0);
    expect(st.getItem(KEY)).toBeNull();
  });

  it('adopt：本地存储里是另一页为新局写的偏移时不删', () => {
    const st = new MemStorage();
    const mine = new DevClock(st, KEY, real);
    mine.forward('old', DAY);
    new DevClock(st, KEY, real).forward('new', MIN); // 另一页在新局上快进
    mine.adopt('new');
    expect(parseDevOffset(st.getItem(KEY))).toEqual({ sid: 'new', ms: MIN });
    expect(mine.offsetFor('new')).toBe(0); // 本页内存不跟随他页（与上一版一致，重载后才读入）
  });

  it('上一版的裸数字、损坏或非正的值一律不认', () => {
    for (const raw of ['86400000', 'abc', '{}', '{"sid":"x","ms":-1}', '{"sid":"","ms":5}', '{"sid":"x","ms":"5"}', 'null']) {
      expect(parseDevOffset(raw)).toBeNull();
      const st = new MemStorage();
      st.setItem(KEY, raw);
      expect(new DevClock(st, KEY, real).offsetFor('x')).toBe(0);
    }
  });

  it('没有本地存储（普通入口）时也能用，且不写存储', () => {
    const c = new DevClock(null, KEY, real);
    expect(c.now('x')).toBe(T0);
    c.forward('x', MIN);
    expect(c.now('x')).toBe(T0 + MIN);
    c.adopt('y');
    expect(c.now('x')).toBe(T0);
    c.clear();
  });

  it('clear 清除内存与本地存储', () => {
    const st = new MemStorage();
    const c = new DevClock(st, KEY, real);
    c.forward('x', DAY);
    c.clear();
    expect(c.offsetFor('x')).toBe(0);
    expect(st.getItem(KEY)).toBeNull();
  });
});

describe('main.ts 接线（静态检查）', () => {
  it('now() 只取当前这一局的偏移，没有与局无关的全局偏移', () => {
    expect(main).not.toMatch(/\bdevOffset\b/);
    expect(main).toMatch(/const now = \(\) => devClock\.now\(state\.sid\)/);
    // 存储经 prefs 安全取得（localStorage 不可用时为 null，GPT 审核 #90）；普通入口仍不读不写
    expect(main).toMatch(/new DevClock\(DEV \? prefs : null, DEV_KEY,/);
  });

  it('adoptState 在换局前让偏移失效', () => {
    const body = main.slice(main.indexOf('function adoptState('));
    expect(body.indexOf('devClock.adopt(s.sid)')).toBeGreaterThan(0);
    expect(body.indexOf('devClock.adopt(s.sid)')).toBeLessThan(body.indexOf('state = s'));
  });

  it('快进记在当前这一局上', () => {
    expect(main).toMatch(/devClock\.forward\(state\.sid, cmd\.ms\)/);
  });
});
