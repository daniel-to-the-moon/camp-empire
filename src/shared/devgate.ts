import { newGame, type GameState } from './state';

/**
 * 调试入口闸门（GPT 审核 #4 第 2 轮第 2 条）：快进收入、重开存档只在 ?dev 入口可用。
 * 普通入口既不展示面板（index.html 的 hidden + style.css 的 [hidden] 规则），也不能执行这些动作（本函数拒绝）。
 */
export function isDevEntry(search: string): boolean {
  return new URLSearchParams(search).has('dev');
}

export type DevCommand = { kind: 'denied'; reason: string } | { kind: 'reset' } | { kind: 'forward'; ms: number };

export function devCommand(dev: boolean, writer: boolean, arg: string): DevCommand {
  if (!dev) return { kind: 'denied', reason: '调试操作只在 ?dev 入口可用' };
  if (!writer) return { kind: 'denied', reason: '本页只读：这个存档正在另一个标签页里玩' };
  if (arg === 'reset') return { kind: 'reset' };
  const ms = Number(arg);
  if (!Number.isFinite(ms) || ms <= 0) return { kind: 'denied', reason: `未知的调试参数：${arg}` };
  return { kind: 'forward', ms };
}

/**
 * 新开一局（GPT 审核 #4 第 4 轮第 1 条）：一律按**真实时间**建局，不带开发快进偏移。
 * 快进偏移只用来推进已有的局；若按“真实时间 + 偏移”建局，偏移一旦清除（重开后重载），
 * 新局的 camp.lastMs 就领先真实时间，effectiveNow 的防回拨逻辑会冻结游戏时间，
 * NPC 到达和每日礼物都推迟到“未来”。
 */
export function freshGameAt(realNowMs: number, seed: number): GameState {
  return newGame(realNowMs, seed);
}

/** localStorage 的最小接口（便于测试替身） */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * 开发快进偏移，与局标识（sid）绑定（issue #11）。
 * 上一版偏移是一个与局无关的全局数：其他标签页重开后，旧页内存里的偏移仍在，
 * 旧页接管新局时按“真实时间 + 旧偏移”回放，新局一开局就前进到未来（提前结算、领未来日期的礼物），
 * 之后又被 effectiveNow 的防回拨逻辑冻结。现在偏移只对记录它的那一局生效：
 * - now(sid)：sid 与偏移所属的局不同，偏移视为 0；
 * - adopt(sid)：采纳另一局时，内存偏移（及本地存储里属于别的局的偏移）一并清除；
 * - 本地存储格式为 {"sid":…,"ms":…}；旧格式（裸数字，不知道属于哪一局）一律不认。
 */
export class DevClock {
  private off: { sid: string; ms: number } | null;

  constructor(
    private readonly storage: StorageLike | null,
    private readonly key: string,
    private readonly realNow: () => number,
  ) {
    this.off = parseDevOffset(storage?.getItem(key) ?? null);
  }

  /** 这一局当前生效的偏移（毫秒）；不是这一局的偏移按 0 计 */
  offsetFor(sid: string): number {
    return this.off && this.off.sid === sid ? this.off.ms : 0;
  }

  now(sid: string): number {
    return this.realNow() + this.offsetFor(sid);
  }

  /** 为这一局快进 ms；原有偏移属于别的局时从 0 起算 */
  forward(sid: string, ms: number): void {
    this.off = { sid, ms: this.offsetFor(sid) + ms };
    this.storage?.setItem(this.key, JSON.stringify(this.off));
  }

  /** 采纳局 sid：属于别的局的偏移（内存与本地存储）都失效 */
  adopt(sid: string): void {
    if (this.off && this.off.sid !== sid) this.off = null;
    const raw = this.storage?.getItem(this.key) ?? null;
    if (raw !== null && parseDevOffset(raw)?.sid !== sid) this.storage!.removeItem(this.key);
  }

  clear(): void {
    this.off = null;
    this.storage?.removeItem(this.key);
  }
}

export function parseDevOffset(raw: string | null): { sid: string; ms: number } | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { sid?: unknown; ms?: unknown };
    if (v && typeof v === 'object' && typeof v.sid === 'string' && v.sid && typeof v.ms === 'number' && Number.isFinite(v.ms) && v.ms > 0) {
      return { sid: v.sid, ms: v.ms };
    }
  } catch {
    // 不是 JSON（例如旧格式的裸数字）
  }
  return null;
}

/**
 * 重开存档：先用一个事务把存档整份换成按真实时间新建的局，**成功后**才清除开发偏移等本地状态；
 * 替换失败时什么都不清，抛出原错误（旧局和它的偏移保持一致）。
 */
export async function resetSave(opts: {
  realNowMs: number;
  seed: number;
  replace: (fresh: GameState) => Promise<void>;
  clearDevState: () => void;
}): Promise<GameState> {
  const fresh = freshGameAt(opts.realNowMs, opts.seed);
  await opts.replace(fresh);
  opts.clearDevState();
  return fresh;
}
