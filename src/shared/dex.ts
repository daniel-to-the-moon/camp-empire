/**
 * 露营者车型图鉴（issue #31，来源提案 #21；用户 2026-11-07 拍板第一阶段）。
 *
 * - 收集位 = models.json 的全部高度变体：9 款基础车型共 25 个（不是 9 × 25），按基础车型分组。
 * - 点亮规则全部明码、无概率、无付费：
 *   1. NPC 露营者入场即算一次到访（含爱心车位），该变体点亮，累计到访 +1，记首次到访时刻；
 *   2. 玩家自己选用过的变体也点亮（开局默认车也算），只记“开过”，不算到访。
 * - 幂等：每个车位的循环序号单调递增（parking_id = `${spotId}#${cycle}`），counted[spotId] 记“已计入到访的下一个循环序号”，
 *   同一位露营者无论回放、重做事务还是加载时补算都只计一次。
 * - 存档兼容（本字段加入前的存档，或旧版本标签页写过的存档）：loadSave 调 reconcileDex 补算。
 *   NPC 车型由 (种子, 车位, 循环序号) 确定（npc.ts variantForCycle），已离开的露营者车型可按种子精确回填、次数准确；
 *   但到达时刻依赖当时的侧边帐状态，存档里没有记录，回填的首次到访日期记为 null（界面显示“升级前，日期未记录”）。
 *   正停在车位里的露营者有到达时刻，按实际日期记。
 */
import { ALL_VARIANTS, CATALOG, findVariant } from '../data/models';
import { dayLabel, dayKey } from './ledger';
import { variantForCycle, type CampSim } from './npc';

export interface DexEntry {
  /** NPC 露营者累计到访次数（入场即算） */
  visits: number;
  /** 首次到访时刻；visits > 0 而为 null 表示升级前回填、日期未记录 */
  firstVisitMs: number | null;
  /** 玩家自己选用过 */
  driven: boolean;
}

export interface Dex {
  /** 键为变体 id（见 data/models.ts），只记已点亮的 */
  entries: Record<string, DexEntry>;
  /** 每个车位已计入到访的下一个循环序号 */
  counted: Record<string, number>;
}

export const DEX_TOTAL = ALL_VARIANTS.length;

export function emptyDex(): Dex {
  return { entries: {}, counted: {} };
}

function entryOf(dex: Dex, variantId: string): DexEntry {
  return (dex.entries[variantId] ??= { visits: 0, firstVisitMs: null, driven: false });
}

/** 是否点亮：到访过或自己开过 */
export function lit(e: DexEntry | undefined): boolean {
  return !!e && (e.visits > 0 || e.driven);
}

/**
 * 记一次 NPC 到访。cycle 早于该车位已计入的序号时视为重复，不计（返回 false）。
 * atMs 为 null 表示到达时刻未知（升级回填）。未知车型（数据被改过）不计，但仍推进序号，避免反复尝试。
 */
export function recordVisit(dex: Dex, spotId: string, cycle: number, variantId: string, atMs: number | null): boolean {
  if (cycle < (dex.counted[spotId] ?? 0)) return false;
  dex.counted[spotId] = cycle + 1;
  if (!findVariant(variantId)) return false;
  const e = entryOf(dex, variantId);
  e.visits += 1;
  // 首次到访日期：第一次到访就有时刻则记下；更早的到访是回填（日期未知，null）时不用后来的日期冒充“首次”
  if (atMs !== null && (e.firstVisitMs === null ? e.visits === 1 : atMs < e.firstVisitMs)) e.firstVisitMs = atMs;
  return true;
}

/** 玩家选用过某个变体 */
export function recordDriven(dex: Dex, variantId: string): void {
  if (findVariant(variantId)) entryOf(dex, variantId).driven = true;
}

/** parking_id `${spotId}#${cycle}` → 循环序号 */
export function cycleOf(parkingId: string): number {
  return Number(parkingId.slice(parkingId.lastIndexOf('#') + 1));
}

/**
 * 按营地权威状态补算漏计的到访（幂等）：每个车位已结束的循环 0…cycle−1 加上正在停靠的那位。
 * 已离开的车型按种子确定（日期未知，记 null）；正在停靠的用存档里的车型与到达时刻。
 */
export function reconcileDex(dex: Dex, camp: CampSim): void {
  for (const sp of camp.spots) {
    for (let c = dex.counted[sp.id] ?? 0; c < sp.cycle; c++) recordVisit(dex, sp.id, c, variantForCycle(camp.seed, sp.id, c), null);
    if (sp.stay) recordVisit(dex, sp.id, sp.cycle, sp.stay.variantId, sp.stay.arriveMs);
  }
}

/** 存档结构校验：不合法时由 loadSave 重建（重建 = 空图鉴 + reconcileDex 回填，不拒绝整份存档） */
export function validDex(x: unknown): x is Dex {
  const d = x as Dex;
  if (!d || typeof d !== 'object' || !d.entries || typeof d.entries !== 'object' || !d.counted || typeof d.counted !== 'object') return false;
  const okCount = Object.values(d.counted).every((v) => Number.isSafeInteger(v) && v >= 0);
  const okEntries = Object.values(d.entries).every(
    (e) =>
      !!e &&
      typeof e === 'object' &&
      Number.isSafeInteger(e.visits) &&
      e.visits >= 0 &&
      typeof e.driven === 'boolean' &&
      (e.firstVisitMs === null || Number.isSafeInteger(e.firstVisitMs)),
  );
  return okCount && okEntries;
}

// ---------- 界面视图（纯函数，界面与测试同源） ----------

export interface DexSlotView {
  id: string;
  model: string;
  roofLabel: string;
  heightMm: number;
  lit: boolean;
  visits: number;
  driven: boolean;
  /** 首次到访日期（上海日历 YYYY-MM-DD）；未到访为 null；升级前回填、日期未记录为 'unknown' */
  firstVisit: string | 'unknown' | null;
}

export interface DexView {
  groups: Array<{ model: string; slots: DexSlotView[]; lit: number }>;
  lit: number;
  total: number;
}

export function dexView(dex: Dex): DexView {
  const groups = CATALOG.map((m) => {
    const slots = m.variants.map((v): DexSlotView => {
      const e = dex.entries[v.id];
      return {
        id: v.id,
        model: v.model,
        roofLabel: v.roofLabel,
        heightMm: Math.round(v.heightM * 1000),
        lit: lit(e),
        visits: e?.visits ?? 0,
        driven: e?.driven ?? false,
        firstVisit: !e || e.visits === 0 ? null : e.firstVisitMs === null ? 'unknown' : dayLabel(dayKey(e.firstVisitMs)),
      };
    });
    return { model: m.model, slots, lit: slots.filter((s) => s.lit).length };
  });
  return { groups, lit: groups.reduce((n, g) => n + g.lit, 0), total: DEX_TOTAL };
}

/** 未点亮收集位的解锁条件（明码） */
export const DEX_UNLOCK_HINT = '等一位开这辆车的露营者来，或在车库里换上它';
