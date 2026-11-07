/**
 * 金币账本：整数“分”（1 金 = 100 分），展示向下取整。
 *
 * 日软上限按 GPT 6612137921 的口径实现：
 * - G = 当日“软上限前”累计毛收入（不是可消费余额）；
 * - 每笔实得 = I(G + a) − I(G)，其中 I(G) = floor(g(G))，在“分”上取整；
 * - 因为是对同一累计函数做差，逐笔实得之和恒等于 floor(g(当日毛收入总额))，
 *   与事件如何拆分、合并无关（GPT 指出的“两笔 0.01 各打五折都取整为 0”问题不会出现）；
 * - 毛收入、实得、未发放三项分开记账，未发放 = 毛收入 − 实得，不是没收。
 *
 * 待收取池（issue #28，来源提案 #22）：NPC 离开时停靠费先进 pending，不改余额；玩家“收取”时才 credit 入账，
 * 软上限按收取时刻所在的上海日计（口径不变）。池上限 PENDING.capGold（提案值），满了之后新的停车费不再累积，
 * 未累积的部分单独记在 lost，不从余额里扣任何钱。
 */
import { ECONOMY, PENDING } from './config';

export type Cents = number;

export interface DayBucket {
  /** Asia/Shanghai 日序号（见 dayKey） */
  day: number;
  /** 当日软上限前累计毛收入 G */
  gross: Cents;
  /** 当日累计实得 */
  issued: Cents;
}

export interface LedgerEntry {
  /** 幂等键：同一键只入账一次（停车结算用 parking_id，每日礼物用 gift:<day>） */
  key: string;
  atMs: number;
  day: number;
  /** npc_parking：旧版（v2）离开即入账的停车费；parking_collect：从待收取池收取（#28） */
  kind: 'start' | 'npc_parking' | 'parking_collect' | 'daily_gift' | 'purchase';
  /** 毛额（购买为负） */
  gross: Cents;
  /** 实际入账（购买为负） */
  amount: Cents;
  note: string;
}

/** 待收取池（毛额，未过软上限）。不计入余额 */
export interface PendingPool {
  /** 待收取的停车费毛额，0 ≤ gross ≤ 上限 */
  gross: Cents;
  /** 待收取包含的停靠笔数（只累积了一部分的那笔也算） */
  stays: number;
  /** 自上次收取以来，因池已满而未累积的停车费（不是扣款：从未进过余额） */
  lost: Cents;
  /** 其中完全或部分未累积的停靠笔数 */
  lostStays: number;
  /** 已收取次数，作收取流水的幂等键序号 */
  collections: number;
}

export interface Ledger {
  balance: Cents;
  today: DayBucket;
  entries: LedgerEntry[];
  seen: Record<string, true>;
  pending: PendingPool;
}

export function assertCents(v: number, what: string): void {
  if (!Number.isSafeInteger(v)) throw new Error(`${what} 必须是安全整数（分），实际 ${v}`);
}

/** 展示用：向下取整到金 */
export function displayGold(c: Cents): number {
  return Math.floor(c / 100);
}

/** Asia/Shanghai 日序号：UTC+8 固定偏移，无夏令时 */
export function dayKey(ms: number): number {
  return Math.floor((ms + ECONOMY.dayOffsetMs) / 86_400_000);
}

/** 日序号 → 'YYYY-MM-DD'（上海日历） */
export function dayLabel(day: number): string {
  return new Date(day * 86_400_000).toISOString().slice(0, 10);
}

/**
 * I(G) = floor(g(G))（单位：分）。阈值以上发放比例为 num/den 的有理数，用整数运算避免浮点误差。
 */
export function issuedUpTo(grossCents: Cents): Cents {
  assertCents(grossCents, 'gross');
  const t = ECONOMY.softCapThresholdGold * 100;
  if (grossCents <= t) return grossCents;
  // softCapRateAbove = 0.5 → 1/2；写成通用的 num/den
  const [num, den] = rational(ECONOMY.softCapRateAbove);
  return t + Math.floor(((grossCents - t) * num) / den);
}

function rational(r: number): [number, number] {
  const den = 1000;
  const num = Math.round(r * den);
  if (Math.abs(num / den - r) > 1e-12) throw new Error(`软上限比例 ${r} 不能精确表示为千分比`);
  return [num, den];
}

export function emptyPending(): PendingPool {
  return { gross: 0, stays: 0, lost: 0, lostStays: 0, collections: 0 };
}

/** 待收取池上限（分）。配置见 config.ts PENDING（提案值，推演见 docs/ECONOMY_M1.md） */
export function pendingCapCents(): Cents {
  return PENDING.capGold * 100;
}

export function newLedger(nowMs: number): Ledger {
  const l: Ledger = { balance: 0, today: { day: dayKey(nowMs), gross: 0, issued: 0 }, entries: [], seen: {}, pending: emptyPending() };
  const start = ECONOMY.startingGold * 100;
  l.balance = start;
  l.entries.push({ key: 'start', atMs: nowMs, day: l.today.day, kind: 'start', gross: start, amount: start, note: '开局资金' });
  l.seen.start = true;
  return l;
}

/**
 * 收入入账（过软上限）。返回实际入账额；重复键返回 0 且不改账。
 * 调用方必须按 atMs 非递减的顺序调用（NPC 回放即按时间排序）。
 */
export function credit(
  l: Ledger,
  e: { key: string; atMs: number; kind: 'npc_parking' | 'parking_collect' | 'daily_gift'; gross: Cents; note: string },
): Cents {
  assertCents(e.gross, 'gross');
  if (e.gross < 0) throw new Error('收入不能为负');
  if (l.seen[e.key]) return 0;
  const day = dayKey(e.atMs);
  if (day < l.today.day) throw new Error(`入账时间早于当前账日（${day} < ${l.today.day}），调用顺序错误`);
  if (day > l.today.day) l.today = { day, gross: 0, issued: 0 };
  const before = issuedUpTo(l.today.gross);
  l.today.gross += e.gross;
  const amount = issuedUpTo(l.today.gross) - before;
  l.today.issued += amount;
  l.balance += amount;
  l.seen[e.key] = true;
  l.entries.push({ key: e.key, atMs: e.atMs, day, kind: e.kind, gross: e.gross, amount, note: e.note });
  return amount;
}

/**
 * 停车费存入待收取池（不改余额）。超过上限的部分不累积，记入 lost。
 * 幂等：同一 parking_id 只存一次（重复返回 0 / 0）。
 */
export function deposit(l: Ledger, e: { key: string; gross: Cents }): { pooled: Cents; lost: Cents } {
  assertCents(e.gross, 'gross');
  if (e.gross < 0) throw new Error('收入不能为负');
  if (l.seen[e.key]) return { pooled: 0, lost: 0 };
  l.seen[e.key] = true;
  const p = l.pending;
  const pooled = Math.max(0, Math.min(e.gross, pendingCapCents() - p.gross));
  const lost = e.gross - pooled;
  p.gross += pooled;
  if (pooled > 0) p.stays += 1;
  if (lost > 0) {
    p.lost += lost;
    p.lostStays += 1;
  }
  return { pooled, lost };
}

/**
 * 收取：把待收取池按收取时刻 atMs 入账（过当日软上限），清空池与“未累积”计数。
 * 池为空时返回 null 且不改账。调用方须保证 atMs 不早于当前账日（state.ts 用有效时间）。
 */
export function collect(l: Ledger, atMs: number): { gross: Cents; amount: Cents; stays: number } | null {
  const p = l.pending;
  if (p.gross <= 0) return null;
  const gross = p.gross;
  const stays = p.stays;
  const amount = credit(l, { key: `collect:${p.collections}`, atMs, kind: 'parking_collect', gross, note: `收取停车费（${stays} 位露营者）` });
  l.pending = { gross: 0, stays: 0, lost: 0, lostStays: 0, collections: p.collections + 1 };
  return { gross, amount, stays };
}

/** 消费：余额不足返回 false 且不改账 */
export function spend(l: Ledger, e: { key: string; atMs: number; cost: Cents; note: string }): boolean {
  assertCents(e.cost, 'cost');
  if (e.cost <= 0) throw new Error('价格必须为正');
  if (l.seen[e.key]) return false;
  if (l.balance < e.cost) return false;
  l.balance -= e.cost;
  l.seen[e.key] = true;
  l.entries.push({ key: e.key, atMs: e.atMs, day: dayKey(e.atMs), kind: 'purchase', gross: -e.cost, amount: -e.cost, note: e.note });
  return true;
}

/** 不变量：余额 = 全部流水实得之和 */
export function auditBalance(l: Ledger): boolean {
  return l.entries.reduce((s, e) => s + e.amount, 0) === l.balance;
}
