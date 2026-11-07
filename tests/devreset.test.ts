/**
 * 快进后重开存档（GPT 审核 #4 第 4 轮第 1 条）：新局必须按真实时间建立。
 * 复现流程：?dev 页快进一天 → 重开存档 → 重载（快进偏移已清除，now() = 真实时间）。
 * 用 fake-indexeddb 模拟浏览器存档；“重载”即从存档重新读出，并以真实时间作为 now()。
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import main from '../src/client/main.ts?raw';
import { freshGameAt, resetSave } from '../src/shared/devgate';
import { dayKey } from '../src/shared/ledger';
import { advanceCamp } from '../src/shared/npc';
import { IdbStore, SaveSlot } from '../src/shared/save';
import { claimDailyGift, effectiveNow, newGame, tick, type GameState } from '../src/shared/state';

const T0 = Date.UTC(2026, 10, 5, 2);
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** 模拟 ?dev 页：旧局在真实时间 T0 建立，快进一天并领礼物，然后（真实时间过了 1 分钟）重开 */
async function forwardThenReset() {
  const slot = new SaveSlot(await IdbStore.open(new IDBFactory(), 'camp'), 'save');
  let offset = 0;
  const now = (real: number) => real + offset;
  await slot.transact(newGame(now(T0), 17), (s) => claimDailyGift(s, now(T0)));
  offset += DAY; // 快进一天
  const old = (await slot.read())!;
  await slot.transact(old, (s) => claimDailyGift(s, now(T0)));
  const realAtReset = T0 + MIN;
  await resetSave({
    realNowMs: realAtReset,
    seed: 99,
    replace: (fresh) => slot.reset(fresh),
    clearDevState: () => {
      offset = 0;
    },
  });
  return { slot, realAtReset, offset };
}

/** 最早一辆 NPC 的到达时刻 */
const firstArrival = (s: GameState) => Math.min(...s.camp.spots.map((sp) => sp.nextArrivalMs ?? Infinity));

describe('快进一天 → 重开 → 重载：新局从真实当前时间开始', () => {
  it('新局时间、NPC 到达与每日礼物都以真实时间为准', async () => {
    const { slot, realAtReset, offset } = await forwardThenReset();
    expect(offset).toBe(0); // 存档替换成功后偏移已清除
    const real = realAtReset + 2 * MIN; // 重载时真实时间又过了 2 分钟
    const s = (await slot.read())!; // 重载
    expect(s.seed).toBe(99);
    expect(s.rev).toBe(0);

    // 新局时间：不领先真实时间，有效时间就是真实时间（防回拨逻辑不会冻结）
    expect(s.camp.lastMs).toBe(realAtReset);
    expect(s.ledger.today.day).toBe(dayKey(realAtReset));
    expect(effectiveNow(s, real)).toBe(real);

    // NPC 到达：与在真实时间新开的同种子局完全一致，并且在真实时间推进到该时刻时确实到达
    const ref = newGame(realAtReset, 99);
    expect(s.camp.spots.map((sp) => sp.nextArrivalMs)).toEqual(ref.camp.spots.map((sp) => sp.nextArrivalMs));
    const first = firstArrival(s);
    expect(first).toBeGreaterThan(realAtReset);
    expect(first - realAtReset).toBeLessThan(DAY); // 不会被推迟一天以上
    const events = tick(s, first);
    expect(events.some((e) => e.type === 'arrive' && e.atMs === first)).toBe(true);

    // 每日礼物：按真实当天发放，日期不在未来
    const r = claimDailyGift(s, first);
    expect(r.gift).not.toBeNull();
    expect(s.lastGiftDay).toBe(dayKey(first));
  });

  it('对照：按“真实时间 + 旧偏移”建局（上一版行为），重载后时间冻结、NPC 推迟一天', () => {
    const realAtReset = T0 + MIN;
    const bad = newGame(realAtReset + DAY, 99); // 上一版 freshGame() 用的是 now() = 真实时间 + 偏移
    const real = realAtReset + 2 * MIN;
    expect(effectiveNow(bad, real)).toBe(realAtReset + DAY); // 被防回拨逻辑冻结在“未来”
    expect(firstArrival(bad) - real).toBeGreaterThan(DAY - 2 * MIN);
    expect(advanceCamp(bad.camp, bad.ledger, real, { awningOut: false })).toEqual([]); // 真实时间下什么都不发生
    // 新的建局函数不受偏移影响
    expect(freshGameAt(realAtReset, 99).camp.lastMs).toBe(realAtReset);
  });

  it('存档替换失败：不清除快进偏移，抛出原错误', async () => {
    let cleared = false;
    const err = new Error('idb down');
    await expect(
      resetSave({
        realNowMs: T0,
        seed: 1,
        replace: async () => {
          throw err;
        },
        clearDevState: () => {
          cleared = true;
        },
      }),
    ).rejects.toBe(err);
    expect(cleared).toBe(false);
  });
});

describe('main.ts 接线（静态检查）', () => {
  it('新局一律按 Date.now() 建立，不用带偏移的 now()', () => {
    expect(main).not.toMatch(/newGame\(/);
    expect(main).toMatch(/freshGameAt\(Date\.now\(\)/);
    const reset = main.slice(main.indexOf("cmd.kind === 'reset'"), main.indexOf('devOffset +='));
    expect(reset).toMatch(/resetSave\(\{\s*realNowMs: Date\.now\(\)/);
    expect(reset).not.toMatch(/removeItem\(DEV_KEY\)/); // 偏移只在 resetSave 成功后经 clearDevState 清除
    expect(reset.indexOf('location.reload()')).toBeGreaterThan(reset.indexOf('resetSave('));
  });

  it('没有存档而新开一局时，同时清掉残留的快进偏移', () => {
    const fresh = main.slice(main.indexOf('function freshGame()'));
    expect(fresh.indexOf('clearDevOffset()')).toBeLessThan(fresh.indexOf('freshGameAt('));
  });
});
