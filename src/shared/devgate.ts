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
