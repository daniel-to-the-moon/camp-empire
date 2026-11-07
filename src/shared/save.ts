/**
 * 存档写入（GPT 审核 #4：第 1 轮第 1 条多标签页互相覆盖；第 2 轮第 1 条修订号检查与写回不原子）。
 *
 * 1. 原子事务（正确性的根基）：存档放在 IndexedDB。每次写入是一个 readwrite 事务，在事务内同步完成
 *    “读最新存档 → 若修订号与内存不同则以最新存档为准 → 执行动作 → 修订号 +1 写回”。
 *    IndexedDB 规范保证作用域重叠的 readwrite 事务（含不同标签页的不同连接）按创建顺序串行执行、互不交错，
 *    所以两个标签页即使读到同一修订号后同时提交，后提交的那个也会在事务内看到前者的写入并在其上重做动作，
 *    不会覆盖购买、扣款和流水。上一版用 localStorage：跨标签页 getItem / setItem 之间没有任何互斥，
 *    且浏览器向其他标签页同步 localStorage 是异步的，修订号检查无法保证原子，已弃用。
 * 2. 单写者（体验层）：Web Locks 独占锁，同一存档只有一个标签页可写，其他标签页只读跟随。
 *    抢锁（steal）交接瞬间旧写者可能多提交一次，由第 1 层兜住（新写者下次事务发现修订号变化，按最新存档重做）。
 * 3. 没有可靠机制时禁止写入：浏览器不支持 IndexedDB 或 Web Locks 时，客户端整页只读并提示原因（见 client/main.ts）。
 */
import { loadSave, type GameState } from './state';

/** 原子读改写存储：update 的 fn 在事务内同步执行，期间其他写入不能插入 */
export interface AtomicStore {
  get(key: string): Promise<string | null>;
  /** fn 返回 value：字符串写入，null 删除，undefined 不写；result 原样作为 Promise 结果 */
  update<T>(key: string, fn: (prev: string | null) => { value?: string | null; result: T }): Promise<T>;
}

const OBJECT_STORE = 'kv';

/** IndexedDB 实现。事务提交（complete）后才 resolve；fn 抛异常则整个事务回滚，什么都不写 */
export class IdbStore implements AtomicStore {
  private constructor(private readonly db: IDBDatabase) {}

  static open(factory: IDBFactory, name: string): Promise<IdbStore> {
    return new Promise((resolve, reject) => {
      const req = factory.open(name, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(OBJECT_STORE)) req.result.createObjectStore(OBJECT_STORE);
      };
      req.onsuccess = () => resolve(new IdbStore(req.result));
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB 打开被阻塞'));
    });
  }

  get(key: string): Promise<string | null> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(OBJECT_STORE, 'readonly');
      const req = tx.objectStore(OBJECT_STORE).get(key);
      tx.oncomplete = () => resolve(typeof req.result === 'string' ? req.result : null);
      tx.onabort = tx.onerror = () => reject(tx.error);
    });
  }

  update<T>(key: string, fn: (prev: string | null) => { value?: string | null; result: T }): Promise<T> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(OBJECT_STORE, 'readwrite');
      const os = tx.objectStore(OBJECT_STORE);
      let out: { result: T } | null = null;
      let thrown: unknown = null;
      const req = os.get(key);
      req.onsuccess = () => {
        try {
          const r = fn(typeof req.result === 'string' ? req.result : null);
          if (r.value === null) os.delete(key);
          else if (r.value !== undefined) os.put(r.value, key);
          out = r;
        } catch (e) {
          thrown = e;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(out!.result);
      tx.onabort = tx.onerror = () => reject(thrown ?? tx.error ?? new Error('存档事务中止'));
    });
  }

  close() {
    this.db.close();
  }
}

export interface TxResult<T> {
  /** 动作作用后的状态（总是新对象；调用方在 Promise 完成后才采纳） */
  state: GameState;
  result: T;
  /** 存档已被其他标签页改过：内存状态已丢弃，动作在最新存档上执行 */
  resynced: boolean;
}

const clone = (s: GameState): GameState => loadSave(JSON.stringify(s))!;

export class SaveSlot {
  constructor(
    private readonly store: AtomicStore,
    readonly key: string,
  ) {}

  async read(): Promise<GameState | null> {
    return loadSave(await this.store.get(this.key));
  }

  /**
   * 原子事务。fn 必须同步、只依赖传入的状态。fn 作用在副本上：事务失败时调用方的内存状态不被改动。
   */
  transact<T>(mem: GameState, fn: (s: GameState) => T): Promise<TxResult<T>> {
    return this.store.update(this.key, (prev) => {
      const latest = loadSave(prev);
      const resynced = !!latest && latest.rev !== mem.rev;
      const s = resynced ? latest! : clone(mem);
      const result = fn(s);
      s.rev += 1;
      return { value: JSON.stringify(s), result: { state: s, result, resynced } };
    });
  }

  /** 只在存档为空时导入旧版 localStorage 存档；返回是否导入 */
  importIfEmpty(legacy: string | null): Promise<boolean> {
    const s = loadSave(legacy);
    return this.store.update(this.key, (prev) => (prev || !s ? { result: false } : { value: JSON.stringify(s), result: true }));
  }

  clear(): Promise<void> {
    return this.store.update(this.key, () => ({ value: null, result: undefined }));
  }
}

/** Web Locks 的最小接口（便于测试替身） */
export interface LocksLike {
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, cb: (lock: unknown) => unknown): Promise<unknown>;
}

/**
 * 申请写者锁。拿到时 onChange(true)，并一直持有到标签页关闭；拿不到（他人持有）或被他人 steal 撤销时 onChange(false)。
 * 不支持 Web Locks 时没有可靠的单写者机制：onChange(false) 并返回 false，调用方整页只读并提示。
 */
export function requestWriter(locks: LocksLike | undefined, name: string, steal: boolean, onChange: (writer: boolean) => void): boolean {
  if (!locks) {
    onChange(false);
    return false;
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
  return true;
}

/** 串行队列：同一标签页内的存档动作按调用顺序一个接一个执行，避免自己和自己产生修订号冲突 */
export function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>): Promise<T> => {
    const p = tail.then(job);
    tail = p.catch(() => undefined);
    return p;
  };
}
