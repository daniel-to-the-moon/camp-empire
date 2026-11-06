/**
 * 游戏状态与动作：纯函数风格（就地修改传入的 state，返回事件），时间由调用方注入。
 * M1 单机存档在 localStorage；迁服务端时这些函数作为权威逻辑，nowMs 改由服务器提供。
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
}

export function newGame(nowMs: number, seed: number): GameState {
  return {
    version: SAVE_VERSION,
    seed,
    variantId: findVariant(DEFAULT_VARIANT) ? DEFAULT_VARIANT : ALL_VARIANTS[0].id,
    ledger: newLedger(nowMs),
    camp: newCampSim(seed, nowMs, RENTAL_SPOTS),
    awningOwned: false,
    awningWanted: true,
    player: { parkedHome: true, pose: null },
    lastGiftDay: null,
  };
}

export function currentVariant(s: GameState): Variant {
  return findVariant(s.variantId) ?? ALL_VARIANTS[0];
}

export function awningOut(s: GameState): boolean {
  return s.awningOwned && s.awningWanted && s.player.parkedHome;
}

/** 回放 NPC 到 now（环境取当前状态）。所有改变环境的动作都先调它。 */
export function tick(s: GameState, nowMs: number): CampEvent[] {
  return advanceCamp(s.camp, s.ledger, nowMs, { awningOut: awningOut(s) });
}

/** 每日首次登录礼物（营地管理员巡视）。同一上海日只发一次。 */
export function claimDailyGift(s: GameState, nowMs: number): { gold: number; amount: number } | null {
  const day = dayKey(nowMs);
  if (s.lastGiftDay === day) return null;
  tick(s, nowMs);
  const i = pickWeighted(
    uniform(s.seed, `gift:${day}`),
    DAILY_GIFT.map((g) => g.p),
  );
  const gold = DAILY_GIFT[i].gold;
  const amount = credit(s.ledger, { key: `gift:${day}`, atMs: nowMs, kind: 'daily_gift', gross: gold * 100, note: `管理员巡视送礼 ${gold} 金` });
  s.lastGiftDay = day;
  return { gold, amount };
}

export function buyAwning(s: GameState, nowMs: number): { ok: boolean; error?: string } {
  if (s.awningOwned) return { ok: false, error: '已拥有侧边帐' };
  tick(s, nowMs);
  if (!spend(s.ledger, { key: 'buy:side_awning', atMs: nowMs, cost: SIDE_AWNING.priceGold * 100, note: '购买侧边帐' })) {
    return { ok: false, error: `金币不足（需要 ${SIDE_AWNING.priceGold}）` };
  }
  s.awningOwned = true;
  return { ok: true };
}

export function setAwningWanted(s: GameState, nowMs: number, wanted: boolean): void {
  tick(s, nowMs);
  s.awningWanted = wanted;
}

/** 换车：只能在家位停好时换（车库就在家位旁） */
export function selectVariant(s: GameState, nowMs: number, id: string): { ok: boolean; error?: string } {
  if (!findVariant(id)) return { ok: false, error: '未知车型' };
  if (!s.player.parkedHome) return { ok: false, error: '先把车停回家位再换车' };
  tick(s, nowMs);
  s.variantId = id;
  return { ok: true };
}

export function leaveHome(s: GameState, nowMs: number, pose: Pose): void {
  tick(s, nowMs);
  s.player = { parkedHome: false, pose };
}

export function arriveHome(s: GameState, nowMs: number): void {
  tick(s, nowMs);
  s.player = { parkedHome: true, pose: null };
}

/** 存档：结构校验失败或版本不符时返回 null（调用方新开一局） */
export function loadSave(json: string | null): GameState | null {
  if (!json) return null;
  try {
    const s = JSON.parse(json) as GameState;
    if (s.version !== SAVE_VERSION || !s.ledger || !s.camp || !Number.isSafeInteger(s.ledger.balance)) return null;
    return s;
  } catch {
    return null;
  }
}
