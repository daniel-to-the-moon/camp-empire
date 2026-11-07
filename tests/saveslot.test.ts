/**
 * 存档分槽（GPT 审核 #32 第 1 条）：v3 用独立槽位 save.v3，v2 槽位只在 v3 为空时导入一次。
 * 场景：基准版本（只认 v2）的旧标签页与新版本标签页共存，写权来回交接，新版本存档不能被旧页覆盖。
 *
 * 旧版本的行为按基准提交 a5d5151 的 SaveSlot.transact / client act 复刻（只认 version === 2；
 * 存档读不懂且内存 rev > 0 时视为“已删除” → freshGame → 以 rev 0 写回同一槽位）。
 */
import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { auditBalance, credit } from '../src/shared/ledger';
import { IdbStore, migrateSave, PREV_SAVE_KEY, SAVE_KEY, SaveSlot, type AtomicStore } from '../src/shared/save';
import { buyAwning, claimDailyGift, collectPending, newGame, SAVE_VERSION, type GameState } from '../src/shared/state';

const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);

/** 基准版本的 loadSave：只接受 v2 */
function oldLoad(json: string | null): (GameState & { version: 2 }) | null {
  if (!json) return null;
  const s = JSON.parse(json);
  return s && s.version === 2 && s.ledger && s.camp ? s : null;
}

/** 基准版本的一次写入（按 a5d5151 的 transact + act 的 SaveSupersededError 分支复刻）：返回旧页之后的内存状态 */
async function oldTabWrite(store: AtomicStore, mem: GameState, fn: (s: GameState) => void): Promise<GameState> {
  let superseded = false;
  const next = await store
    .update(PREV_SAVE_KEY, (prev) => {
      const latest = oldLoad(prev);
      if (latest ? latest.sid !== mem.sid : mem.rev > 0) throw new Error('superseded');
      const s: GameState = latest && latest.rev !== mem.rev ? latest : JSON.parse(JSON.stringify(mem));
      fn(s);
      s.rev += 1;
      return { value: JSON.stringify(s), result: s };
    })
    .catch(() => {
      superseded = true;
      return null;
    });
  if (!superseded) return next!;
  // 旧版 act：latest 为 null → freshGame()；下一次每秒自动保存以 rev 0 写回同一槽位
  const fresh = { ...newGame(nov(5), 999), version: 2 } as GameState;
  await store.update(PREV_SAVE_KEY, () => ({ value: JSON.stringify(fresh), result: undefined }));
  return fresh;
}

/** 一份基准版本写下的 v2 存档：有礼物、有离开即入账的停车费，没有 pending */
function v2Json(): string {
  const s = newGame(nov(5, 8), 11);
  claimDailyGift(s, nov(5, 8));
  credit(s.ledger, { key: 'p1#0', atMs: nov(5, 12), kind: 'npc_parking', gross: 4_200, note: '' });
  s.rev = 3;
  const raw = JSON.parse(JSON.stringify(s));
  delete raw.ledger.pending;
  raw.version = 2;
  return JSON.stringify(raw);
}

async function browser() {
  const factory = new IDBFactory();
  const oldStore = await IdbStore.open(factory, 'camp-empire'); // 旧版本标签页的连接
  const newStore = await IdbStore.open(factory, 'camp-empire'); // 新版本标签页的连接
  return { oldStore, newStore };
}

describe('v2 / v3 存档分槽', () => {
  it('槽位不同：新版本不写旧版本的槽位', () => {
    expect(SAVE_KEY).not.toBe(PREV_SAVE_KEY);
    expect(SAVE_VERSION).toBe(3);
  });

  it('首次启动：v3 为空时从 v2 槽位迁移，v2 原样保留；再次启动不再导入', async () => {
    const { newStore } = await browser();
    const v2 = v2Json();
    await newStore.update(PREV_SAVE_KEY, () => ({ value: v2, result: undefined }));
    expect(await migrateSave(newStore, null)).toBe('idb');
    const s = (await new SaveSlot(newStore, SAVE_KEY).read())!;
    expect(s.version).toBe(3);
    expect(s.ledger.balance).toBe(oldLoad(v2)!.ledger.balance);
    expect(await newStore.get(PREV_SAVE_KEY)).toBe(v2);
    expect(await migrateSave(newStore, null)).toBeNull();
  });

  it('v2 槽位为空时导入 localStorage 旧存档；两处都没有则不导入', async () => {
    const { newStore } = await browser();
    expect(await migrateSave(newStore, null)).toBeNull();
    expect(await migrateSave(newStore, v2Json())).toBe('legacy');
    expect(await migrateSave(newStore, v2Json())).toBeNull();
  });

  it('旧标签页与新版共存、写权来回交接：旧页的写入（含读不懂后新开局覆盖）不影响 v3 存档', async () => {
    const { oldStore, newStore } = await browser();
    await oldStore.update(PREV_SAVE_KEY, () => ({ value: v2Json(), result: undefined }));
    let oldMem: GameState = oldLoad(await oldStore.get(PREV_SAVE_KEY))!; // 旧页先打开，内存里是 v2、rev 3

    // 新版本标签页打开：迁移，买侧边帐，快进后收取停车费
    await migrateSave(newStore, null);
    const slot = new SaveSlot(newStore, SAVE_KEY);
    let mem = (await slot.read())!;
    mem = (await slot.transact(mem, (s) => buyAwning(s, nov(5, 13)))).state;
    mem = (await slot.transact(mem, (s) => claimDailyGift(s, nov(6, 20)))).state;
    expect(mem.ledger.pending.gross).toBeGreaterThan(0);
    mem = (await slot.transact(mem, (s) => collectPending(s, nov(6, 20)))).state;
    mem = (await slot.transact(mem, (s) => claimDailyGift(s, nov(7, 20)))).state; // 再积一池待收取
    expect(mem.awningOwned).toBe(true);
    expect(mem.ledger.pending.gross).toBeGreaterThan(0);
    const saved = await newStore.get(SAVE_KEY);

    // 旧页点“在这里玩”抢回写权：正常写 v2 槽位，再模拟读不懂存档后新开一局、以 rev 0 覆盖
    oldMem = await oldTabWrite(oldStore, oldMem, (s) => {
      s.awningWanted = false;
    });
    expect(oldMem.rev).toBe(4);
    await oldStore.update(PREV_SAVE_KEY, () => ({ value: null, result: undefined })); // 极端情况：v2 槽位被清空
    oldMem = await oldTabWrite(oldStore, oldMem, () => {}); // rev > 0 且槽位为空 → 旧版 freshGame 覆盖
    expect(oldMem.rev).toBe(0);
    expect(oldLoad(await oldStore.get(PREV_SAVE_KEY))!.seed).toBe(999);

    // v3 存档一字未变；新页再抢回写权继续写，不需要重同步，余额、购买、待收取都在
    expect(await newStore.get(SAVE_KEY)).toBe(saved);
    const tx = await slot.transact(mem, (s) => collectPending(s, nov(7, 20)));
    expect(tx.resynced).toBe(false);
    expect(tx.result.collected!.gross).toBe(mem.ledger.pending.gross);
    expect(tx.state.awningOwned).toBe(true);
    expect(tx.state.ledger.balance).toBe(mem.ledger.balance + tx.result.collected!.amount);
    expect(auditBalance(tx.state.ledger)).toBe(true);

    // 刷新新页：v3 已有存档，不会被（已被覆盖的）v2 槽位重新导入
    expect(await migrateSave(newStore, null)).toBeNull();
    expect((await slot.read())!.sid).toBe(mem.sid);
  });
});
