/**
 * 游戏状态与动作：纯函数风格（就地修改传入的 state，返回事件），时间由调用方注入。
 * M1 单机存档在 IndexedDB（save.ts）；迁服务端时这些函数作为权威逻辑，nowMs 改由服务器提供。
 */
import { ALL_VARIANTS, findVariant, type Variant } from '../data/models';
import { RENTAL_SPOTS } from './camp';
import { DAILY_GIFT, SIDE_AWNING } from './config';
import { credit, dayKey, newLedger, spend, type Ledger } from './ledger';
import type { Pose } from './kinematics';
import { advanceCamp, newCampSim, type CampEvent, type CampSim } from './npc';
import { pickWeighted, uniform } from './rng';

export const SAVE_VERSION = 2;
export const DEFAULT_VARIANT = 'SH5043XLJH9DB-C_3116';

export interface GameState {
  version: number;
  seed: number;
  variantId: string;
  ledger: Ledger;
  camp: CampSim;
  awningOwned: boolean;
  /** 玩家意愿：停在家位时是否展开 */
  awningWanted: boolean;
  /** 玩家车：停在家位，或在营地里某个位姿 */
  player: { parkedHome: boolean; pose: Pose | null };
  lastGiftDay: number | null;
  /** 存档修订号：每次写入 +1，用于发现其他标签页的写入（见 save.ts） */
  rev: number;
  /**
   * 局标识：每开一局随机生成、不复用（GPT 审核 #4 第 3 轮第 1 条）。
   * 重开后新局的修订号可能与旧局相同，只比较 rev 分不出两局；save.ts 同时比较 sid 与 rev。
   */
  sid: string;
}

/** 新局标识：优先用 crypto.randomUUID，没有时退回时间 + 随机数（只需在同一浏览器内不重复） */
export function newSaveId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

export function newGame(nowMs: number, seed: number, sid: string = newSaveId()): GameState {
  return {
    version: SAVE_VERSION,
    sid,
    seed,
    variantId: findVariant(DEFAULT_VARIANT) ? DEFAULT_VARIANT : ALL_VARIANTS[0].id,
    ledger: newLedger(nowMs),
    camp: newCampSim(seed, nowMs, RENTAL_SPOTS),
    awningOwned: false,
    awningWanted: true,
    player: { parkedHome: true, pose: null },
    lastGiftDay: null,
    rev: 0,
  };
}

export function currentVariant(s: GameState): Variant {
  return findVariant(s.variantId) ?? ALL_VARIANTS[0];
}

export function awningOut(s: GameState): boolean {
  return s.awningOwned && s.awningWanted && s.player.parkedHome;
}

/**
 * 有效时间策略（所有状态动作统一使用）：
 * 有效时间 = max(本机时间, 已回放到的时刻 camp.lastMs)。本机时钟回拨时，游戏时间停在已处理到的最晚时刻，
 * 直到本机时间重新追上——因此回拨期间不会向历史账日入账、不会倒退领取日期，也不会触发
 * credit 的“入账时间早于当前账日”异常。
 * 不变量：账本当前账日 ≤ dayKey(camp.lastMs)（入账时刻都不晚于回放时刻，见 tests/state.test.ts）。
 */
export function effectiveNow(s: GameState, nowMs: number): number {
  return Math.max(nowMs, s.camp.lastMs);
}

/**
 * 回放 NPC 到有效时间（环境取当前状态）。所有动作都先调它，并把产生的事件原样返回给调用方：
 * 客户端必须把每个动作返回的 events 交给同一个分发入口（同步车辆、提示），不能丢弃。
 */
export function tick(s: GameState, nowMs: number): CampEvent[] {
  return advanceCamp(s.camp, s.ledger, effectiveNow(s, nowMs), { awningOut: awningOut(s) });
}

/** 动作结果：events 是本次动作回放出的 NPC 事件，必须分发 */
export interface ActionResult {
  ok: boolean;
  error?: string;
  events: CampEvent[];
}

/** 每日首次登录礼物（营地管理员巡视）。同一上海日只发一次；按有效时间计日，领取日期只进不退。 */
export function claimDailyGift(s: GameState, nowMs: number): { gift: { gold: number; amount: number } | null; events: CampEvent[] } {
  const events = tick(s, nowMs);
  const t = effectiveNow(s, nowMs);
  const day = dayKey(t);
  if (s.lastGiftDay !== null && day <= s.lastGiftDay) return { gift: null, events };
  const i = pickWeighted(
    uniform(s.seed, `gift:${day}`),
    DAILY_GIFT.map((g) => g.p),
  );
  const gold = DAILY_GIFT[i].gold;
  const amount = credit(s.ledger, { key: `gift:${day}`, atMs: t, kind: 'daily_gift', gross: gold * 100, note: `管理员巡视送礼 ${gold} 金` });
  s.lastGiftDay = day;
  return { gift: { gold, amount }, events };
}

export function buyAwning(s: GameState, nowMs: number): ActionResult {
  const events = tick(s, nowMs);
  if (s.awningOwned) return { ok: false, error: '已拥有侧边帐', events };
  if (!spend(s.ledger, { key: 'buy:side_awning', atMs: effectiveNow(s, nowMs), cost: SIDE_AWNING.priceGold * 100, note: '购买侧边帐' })) {
    return { ok: false, error: `金币不足（需要 ${SIDE_AWNING.priceGold}）`, events };
  }
  s.awningOwned = true;
  return { ok: true, events };
}

export function setAwningWanted(s: GameState, nowMs: number, wanted: boolean): ActionResult {
  const events = tick(s, nowMs);
  s.awningWanted = wanted;
  return { ok: true, events };
}

/** 换车：只能在家位停好时换（车库就在家位旁） */
export function selectVariant(s: GameState, nowMs: number, id: string): ActionResult {
  const events = tick(s, nowMs);
  if (!findVariant(id)) return { ok: false, error: '未知车型', events };
  if (!s.player.parkedHome) return { ok: false, error: '先把车停回家位再换车', events };
  s.variantId = id;
  return { ok: true, events };
}

export function leaveHome(s: GameState, nowMs: number, pose: Pose): ActionResult {
  const events = tick(s, nowMs);
  s.player = { parkedHome: false, pose };
  return { ok: true, events };
}

export function arriveHome(s: GameState, nowMs: number): ActionResult {
  const events = tick(s, nowMs);
  s.player = { parkedHome: true, pose: null };
  return { ok: true, events };
}

/** 驾驶途中定时记录玩家车位姿（同样先回放，事件交给调用方） */
export function recordPose(s: GameState, nowMs: number, pose: Pose): ActionResult {
  const events = tick(s, nowMs);
  if (!s.player.parkedHome) s.player.pose = pose;
  return { ok: true, events };
}

/** 存档：结构校验失败或版本不符时返回 null（调用方新开一局） */
export function loadSave(json: string | null): GameState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as GameState;
    if (s.version !== SAVE_VERSION || !s.ledger || !s.camp || !Number.isSafeInteger(s.ledger.balance)) return null;
    if (!Number.isSafeInteger(s.rev)) s.rev = 0; // 本字段加入前的存档
    // 局标识加入前的存档：按种子确定性补一个，多个标签页读同一份旧存档时得到同一个标识
    if (typeof s.sid !== 'string' || !s.sid) s.sid = `legacy:${s.seed}`;
    return s;
  } catch {
    return null;
  }
}
