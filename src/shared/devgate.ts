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
