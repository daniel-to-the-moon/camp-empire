/**
 * NPC 露营者停车：M1 唯一停车收入来源（2026-11-04 本地会话转述的用户答复，待用户在 issue 中确认，确认前不是正式结论）。
 *
 * 规则（数值见 config.ts NPC，均为提案）：
 * - 每个出租车位独立循环：空 → 等待（指数分布）→ NPC 到达 → 停靠（均匀分布，≤ 12 h 封顶）→ 自动离开并结算 → 空 …
 * - 结算在离开时刻自动发生，不需要营主上线（避免“必须间隔 12 h 上线”的隐性催促，见 #1 E2）；
 * - 营主不能赶走 NPC，也没有没收；爱心车位的 NPC 不给营主付费（只计公益时长）。
 * - 惰性回放：每次玩家请求时按时间顺序回放到 now；所有随机数由 (种子, 车位, 循环序号) 决定，
 *   同一时间点多次回放结果相同；parking_id = `${spotId}#${cycle}` 作为幂等键。
 */
import { ALL_VARIANTS } from '../data/models';
import { NPC } from './config';
import { credit, type Ledger } from './ledger';
import { uniform } from './rng';

const MIN = 60_000;

export type SpotKind = 'private' | 'love';

export interface NpcStay {
  parkingId: string;
  variantId: string;
  arriveMs: number;
  departMs: number;
}

export interface SpotSim {
  id: string;
  kind: SpotKind;
  cycle: number;
  /** 空位时：下一辆到达时刻 */
  nextArrivalMs: number | null;
  stay: NpcStay | null;
}

export interface CampSim {
  seed: number;
  lastMs: number;
  spots: SpotSim[];
  /** 爱心车位累计公益停靠分钟 */
  loveMinutes: number;
  settlements: number;
}

export type CampEvent =
  | { type: 'arrive'; atMs: number; spotId: string; stay: NpcStay }
  | { type: 'depart'; atMs: number; spotId: string; stay: NpcStay; gross: number; amount: number; minutes: number };

/** 当前环境对 NPC 吸引力的影响（侧边帐在家位展开） */
export interface CampEnv {
  awningOut: boolean;
}

export function newCampSim(seed: number, nowMs: number, spots: Array<{ id: string; kind: SpotKind }>): CampSim {
  const sim: CampSim = {
    seed,
    lastMs: nowMs,
    spots: spots.map((s) => ({ id: s.id, kind: s.kind, cycle: 0, nextArrivalMs: null, stay: null })),
    loveMinutes: 0,
    settlements: 0,
  };
  for (const sp of sim.spots) sp.nextArrivalMs = nowMs + gapMs(sim.seed, sp, { awningOut: false });
  return sim;
}

function gapMs(seed: number, sp: SpotSim, env: CampEnv): number {
  const u = uniform(seed, `gap:${sp.id}:${sp.cycle}`);
  const mean = NPC.meanGapMinutes * (env.awningOut ? NPC.awningGapFactor : 1);
  // 指数分布，至少 1 分钟（同一分钟内不会又走又来）
  return Math.max(1, Math.round(-Math.log(1 - u) * mean)) * MIN;
}

function stayMinutes(seed: number, sp: SpotSim): number {
  const u = uniform(seed, `stay:${sp.id}:${sp.cycle}`);
  return NPC.minStayMinutes + Math.floor(u * (NPC.capMinutes - NPC.minStayMinutes + 1));
}

function pickVariant(seed: number, sp: SpotSim): string {
  const u = uniform(seed, `car:${sp.id}:${sp.cycle}`);
  return ALL_VARIANTS[Math.floor(u * ALL_VARIANTS.length)].id;
}

/** 停靠费：floor(分钟 × 每小时费率 / 60)，单位分 */
export function feeCents(minutes: number): number {
  return Math.floor((minutes * NPC.rateCentsPerHour) / 60);
}

function nextEventMs(sp: SpotSim): number {
  return sp.stay ? sp.stay.departMs : (sp.nextArrivalMs ?? Infinity);
}

/**
 * 回放到 nowMs，按时间顺序处理全部到达 / 离开，离开即结算入账。
 * env 为自上次回放以来不变的环境（调用方在每次改变环境的操作前先回放到当时）。
 */
export function advanceCamp(sim: CampSim, ledger: Ledger, nowMs: number, env: CampEnv): CampEvent[] {
  const events: CampEvent[] = [];
  if (nowMs < sim.lastMs) return events; // 时钟回拨：什么都不做，不倒退
  for (let guard = 0; guard < 200_000; guard++) {
    let sp: SpotSim | null = null;
    let t = Infinity;
    for (const s of sim.spots) {
      const e = nextEventMs(s);
      if (e < t || (e === t && sp && s.id < sp.id)) {
        t = e;
        sp = s;
      }
    }
    if (!sp || t > nowMs) {
      sim.lastMs = nowMs;
      return events;
    }
    if (sp.stay) {
      const stay = sp.stay;
      const minutes = Math.round((stay.departMs - stay.arriveMs) / MIN);
      let gross = 0;
      let amount = 0;
      if (sp.kind === 'private') {
        gross = feeCents(minutes);
        amount = credit(ledger, { key: stay.parkingId, atMs: stay.departMs, kind: 'npc_parking', gross, note: `露营者停靠 ${minutes} 分钟` });
      } else {
        sim.loveMinutes += minutes;
      }
      sim.settlements += 1;
      events.push({ type: 'depart', atMs: stay.departMs, spotId: sp.id, stay, gross, amount, minutes });
      sp.stay = null;
      sp.cycle += 1;
      sp.nextArrivalMs = stay.departMs + gapMs(sim.seed, sp, env);
    } else {
      const arriveMs = sp.nextArrivalMs!;
      const stay: NpcStay = {
        parkingId: `${sp.id}#${sp.cycle}`,
        variantId: pickVariant(sim.seed, sp),
        arriveMs,
        departMs: arriveMs + stayMinutes(sim.seed, sp) * MIN,
      };
      sp.stay = stay;
      sp.nextArrivalMs = null;
      events.push({ type: 'arrive', atMs: arriveMs, spotId: sp.id, stay });
    }
  }
  throw new Error('NPC 回放事件数超出上限');
}
