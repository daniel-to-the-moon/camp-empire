/**
 * 回访面板与待收取区的文案（issue #28）。不依赖 DOM / three，tests/welcome.test.ts 在 node 里测。
 *
 * 每日首次登录的礼物与待收取的停车费放在同一个回访面板里：礼物已自动入账，停车费点“收取”入账。
 * 池满时把“待收取”（还能收的钱）与“未累积”（满了之后没进池的停车费）分开写，
 * 并明确说明未累积的部分从未进过余额、没有扣钱。
 */
import type { PendingView } from '../shared/economy';
import { displayGold } from '../shared/ledger';
import type { CampEvent } from '../shared/npc';
import type { DailyGift } from '../shared/state';
import { giftGoldForStreak } from '../shared/streak';

type Depart = Extract<CampEvent, { type: 'depart' }>;

const g = (c: number) => displayGold(c).toLocaleString('zh-CN');

/** 期望值估算的时长：1 小时以上取整到 10 分钟（“约 X 小时 Y 分”），以下按分钟向上取整，最少 1 分钟 */
export function fmtHours(h: number): string {
  const raw = h * 60;
  if (raw < 60) return `约 ${Math.max(1, Math.ceil(raw))} 分钟`;
  const min = Math.round(raw / 10) * 10;
  return `约 ${Math.floor(min / 60)} 小时${min % 60 ? ` ${min % 60} 分` : ''}`;
}

/** 一段时间内露营者离开的汇总；没有付费离开返回 null */
export function offlineSummary(events: CampEvent[]): string | null {
  const departs = events.filter((e): e is Depart => e.type === 'depart' && e.gross > 0);
  if (!departs.length) return null;
  const pooled = departs.reduce((s, e) => s + e.pooled, 0);
  const lost = departs.reduce((s, e) => s + e.lost, 0);
  return `${departs.length} 位露营者停完离开，${g(pooled)} 金进入待收取${lost ? `；待收取已满，${g(lost)} 金未累积` : ''}`;
}

/** 单个离开事件的提示 */
export function departToast(label: string, e: Depart, dur: string): string | null {
  if (e.gross <= 0) return null;
  if (e.lost === 0) return `${label}的露营者停了 ${dur}，${g(e.pooled)} 金进入待收取`;
  if (e.pooled === 0) return `${label}的露营者停了 ${dur}。待收取已满，这笔 ${g(e.lost)} 金未累积——收取后才会继续累积`;
  return `${label}的露营者停了 ${dur}，${g(e.pooled)} 金进入待收取后已满，其余 ${g(e.lost)} 金未累积`;
}

/** 待收取区：状态行 + （有未累积时）单独一行说明 */
export function pendingLines(v: PendingView): { status: string; lost: string | null } {
  const status = v.full
    ? `已满（上限 ${g(v.cap)} 金），新的停车费不再累积。收取后重新开始累积。`
    : v.pending > 0
      ? `${v.stays} 位露营者的停车费 · 距上限 ${g(v.cap - v.pending)} 金，按期望收入${fmtHours(v.hoursToFull)}后满`
      : `暂无。上限 ${g(v.cap)} 金，按期望收入${fmtHours(v.hoursToFull)}后满`;
  const lost = v.lost > 0 ? `未累积 ${g(v.lost)} 金（${v.lostStays} 位露营者，满了之后离开的）：这部分从未进过余额，不是扣钱。` : null;
  return { status, lost };
}

/**
 * 收取之后回访面板是否关闭（GPT 审核 #32 第 2 轮）：面板上的金额与按钮是打开时的快照，
 * 不论从面板还是从侧栏收取，只要收取成功就关掉，避免面板继续显示已经收走的金额；
 * 从面板点的收取即使失败（例如已被侧栏收走）也关掉，失败原因由提示说明。
 */
export function closeWelcomeAfterCollect(fromPanel: boolean, collected: boolean): boolean {
  return fromPanel || collected;
}

export interface ReturnPanel {
  lines: string[];
  /** 有待收取时的收取按钮文字；没有为 null */
  collect: string | null;
}

/** 礼物一句话：7 日循环第几天、领了多少、明天继续登录能领多少（#29） */
export function giftLine(gift: Pick<DailyGift, 'gold' | 'day' | 'streak'>): string {
  return `连续登录第 ${gift.day} 天：营地管理员巡视送来 ${gift.gold} 金（已入账）。明天继续登录可领 ${giftGoldForStreak(gift.streak + 1)} 金。`;
}

/** 回访面板：离线汇总、礼物、待收取放在一起；什么都没有返回 null（不弹） */
export function returnPanel(events: CampEvent[], gift: Pick<DailyGift, 'gold' | 'day' | 'streak'> | null, v: PendingView): ReturnPanel | null {
  const lines: string[] = [];
  const off = offlineSummary(events);
  if (off) lines.push(`你不在的时候，${off}。`);
  if (gift) lines.push(giftLine(gift));
  if (v.pending > 0) {
    lines.push(`待收取 ${g(v.pending)} 金${v.full ? `（已满，上限 ${g(v.cap)} 金）` : ''}。`);
    const { lost } = pendingLines(v);
    if (lost) lines.push(lost);
  }
  if (!lines.length) return null;
  return { lines, collect: v.pending > 0 ? `收取 ${g(v.pending)} 金` : null };
}
