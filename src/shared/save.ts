/**
 * 存档写入（GPT 审核 #4 第 1 条：多标签页互相覆盖）。两层保护：
 *
 * 1. 单写者（主）：用 Web Locks 独占锁，同一浏览器同一存档只有一个标签页可写；其他标签页只读，
 *    只跟随存档变化刷新画面。玩家可在只读页点“在这里玩”抢过写权（steal），原写者的锁被撤销后立即转为只读。
 * 2. 修订号事务（兜底）：每次写入都在同一个同步调用里“读最新存档 → 若修订号与内存不同则以最新存档为准 →
 *    执行动作 → 修订号 +1 写回”。抢锁瞬间旧写者可能还没收到撤销通知而多写一次，或浏览器不支持 Web Locks，
 *    新写者下次写入时也会发现修订号变化，在最新存档上重做动作，不会用旧状态覆盖购买、扣款和流水。
 *
 * 残余风险（如实列出）：localStorage 跨标签页的读改写不保证原子；不支持 Web Locks 的浏览器里，
 * 两个标签页在同一毫秒级窗口内同时写入仍可能丢一次写。M1 单机原型接受；迁服务端后由服务器事务取代。
 */
import { loadSave, type GameState } from './state';

export interface KV {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface TxResult<T> {
  /** 动作作用后的状态（resynced 时是从存档读出的新对象） */
  state: GameState;
  result: T;
  /** 存档已被其他标签页改过：内存状态已丢弃，动作在最新存档上执行 */
  resynced: boolean;
}

export class SaveSlot {
  constructor(
    private readonly kv: KV,
    readonly key: string,
  ) {}

  read(): GameState | null {
    return loadSave(this.kv.getItem(this.key));
  }

  /**
   * 事务：全程同步，中间不能有 await。fn 必须只依赖传入的状态（不能依赖调用方持有的旧对象）。
   */
  transact<T>(mem: GameState, fn: (s: GameState) => T): TxResult<T> {
    const latest = this.read();
    const resynced = !!latest && latest.rev !== mem.rev;
    const s = resynced ? latest! : mem;
    const result = fn(s);
    s.rev += 1;
    this.kv.setItem(this.key, JSON.stringify(s));
    return { state: s, result, resynced };
  }
}

/** Web Locks 的最小接口（便于测试替身） */
export interface LocksLike {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
}

/**
 * 申请写者锁。拿到时 onChange(true)，并一直持有到标签页关闭；拿不到（他人持有）或被他人 steal 撤销时 onChange(false)。
 * 不支持 Web Locks 时直接视为写者（只靠修订号事务兜底）。
 */
export function requestWriter(locks: LocksLike | undefined, name: string, steal: boolean, onChange: (writer: boolean) => void): void {
  if (!locks) {
    onChange(true);
    return;
  }
  locks
    .request(name, steal ? { steal: true } : { ifAvailable: true }, (lock) => {
      if (!lock) {
        onChange(false);
        return;
      }
      onChange(true);
      return new Promise<void>(() => {}); // 持有到标签页关闭
    })
    .catch(() => onChange(false)); // 被 steal：原请求以 AbortError 拒绝
}
