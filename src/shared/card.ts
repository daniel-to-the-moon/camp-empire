/**
 * 露营卡片（issue #30，来源提案 #26）：取数与文案。纯函数、只读，不依赖 DOM / three，tests/card.test.ts 在 node 里测。
 *
 * 卡片上的数字与界面读同一个来源（todayStats / giftStreakView / state），保证与游戏内记录一致：
 * - 露营者到访数：camp.daily.arrivals，当天（上海日）到达的露营者数，按到达时刻计；
 * - 当日实得金币：ledger.today.issued（软上限后实际入账，含每日礼物与收取的停车费），与“每日”区“今日已入账”同口径；
 * - 爱心车位公益时长：camp.daily.loveMinutes，当天离开的爱心车位露营者的整段停靠分钟。
 * 统计桶停在更早的日子（今天还没有事件 / 入账）时，当天数据为 0。
 *
 * 第一阶段只生成与下载 / 复制，不接分享渠道、无回流链接、不给任何分享奖励（#30“不做”）。
 */
import { dayKey, dayLabel, displayGold } from './ledger';
import { awningOut, currentVariant, effectiveNow, giftStreakView, type GameState } from './state';

export const CARD_GAME_NAME = 'camp·empire 房车营地';

/**
 * 连续登录达到几天才作为里程碑显示（提案值，待核实）：第 1 天就是“刚登录”，不算里程碑；
 * 从第 2 天起才体现“连续”。
 */
export const CARD_STREAK_MIN = 2;

export interface TodayStats {
  /** 上海日序号 */
  day: number;
  visitors: number;
  /** 当日实得（分） */
  issuedCents: number;
  loveMinutes: number;
}

/** 当天（按有效时间所在的上海日）统计；界面与卡片共用 */
export function todayStats(s: GameState, nowMs: number): TodayStats {
  const day = dayKey(effectiveNow(s, nowMs));
  const d = s.camp.daily;
  const sameDay = d.day === day;
  return {
    day,
    visitors: sameDay ? d.arrivals : 0,
    issuedCents: s.ledger.today.day === day ? s.ledger.today.issued : 0,
    loveMinutes: sameDay ? d.loveMinutes : 0,
  };
}

export interface CardData {
  game: string;
  /** 'YYYY-MM-DD'（上海日历） */
  date: string;
  vehicle: { model: string; roof: string; size: string };
  visitors: number;
  /** 当日实得金币（展示用，向下取整到金，与界面一致） */
  goldToday: number;
  loveMinutesToday: number;
  /** 成就 / 里程碑；没有为空数组（卡片上整块不显示） */
  milestones: string[];
}

/** 分钟 → “X 小时 YY 分”（与界面 fmtDur 一致） */
export function fmtMinutes(min: number): string {
  return `${Math.floor(min / 60)} 小时 ${String(min % 60).padStart(2, '0')} 分`;
}

export function cardData(s: GameState, nowMs: number): CardData {
  const t = todayStats(s, nowMs);
  const v = currentVariant(s);
  const milestones: string[] = [];
  if (s.awningOwned) milestones.push(awningOut(s) ? '已拥有侧边帐（正在展开）' : '已拥有侧边帐');
  const sv = giftStreakView(s, nowMs);
  if (sv.claimedToday && sv.streak >= CARD_STREAK_MIN) milestones.push(`连续登录 ${sv.streak} 天`);
  if (s.camp.loveMinutes > 0) milestones.push(`爱心车位累计公益停靠 ${fmtMinutes(s.camp.loveMinutes)}`);
  return {
    game: CARD_GAME_NAME,
    date: dayLabel(t.day),
    vehicle: {
      model: v.model,
      roof: v.roofLabel,
      size: `${v.lengthM.toFixed(2)} × ${v.widthM.toFixed(2)} × ${v.heightM.toFixed(2)} m`,
    },
    visitors: t.visitors,
    goldToday: displayGold(t.issuedCents),
    loveMinutesToday: t.loveMinutes,
    milestones,
  };
}

/** 卡片上的三项当日数据（标签 + 值），顺序即绘制顺序 */
export function cardStats(d: CardData): Array<{ label: string; value: string }> {
  return [
    { label: '今日到访露营者', value: `${d.visitors} 位` },
    { label: '今日实得金币', value: `${d.goldToday.toLocaleString('zh-CN')} 金` },
    { label: '爱心车位公益停靠', value: fmtMinutes(d.loveMinutesToday) },
  ];
}

/** 下载文件名 */
export function cardFileName(d: Pick<CardData, 'date'>): string {
  return `camp-empire-${d.date}.png`;
}

export type CopyResult = 'copied' | 'unsupported' | 'failed';

/** 复制图片所需的浏览器能力（测试时传假对象） */
export interface ClipboardEnv {
  clipboard?: { write?: (items: unknown[]) => Promise<void> };
  ClipboardItem?: new (items: Record<string, Blob>) => unknown;
}

/** 复制 PNG 到剪贴板：浏览器不支持返回 unsupported，写入被拒（未授权、页面未聚焦等）返回 failed，不抛异常 */
export async function copyPng(blob: Blob, env: ClipboardEnv): Promise<CopyResult> {
  if (!env.ClipboardItem || typeof env.clipboard?.write !== 'function') return 'unsupported';
  try {
    await env.clipboard.write([new env.ClipboardItem({ 'image/png': blob })]);
    return 'copied';
  } catch {
    return 'failed';
  }
}

export function copyMessage(r: CopyResult): string {
  if (r === 'copied') return '卡片图片已复制到剪贴板';
  if (r === 'unsupported') return '这个浏览器不支持复制图片，请用“下载 PNG”';
  return '复制失败（浏览器拒绝了剪贴板写入），请用“下载 PNG”';
}
