/**
 * NPC 露营者停车：M1 唯一停车收入来源（2026-11-04 本地会话转述的用户答复，待用户在 issue 中确认，确认前不是正式结论）。
 *
 * 规则（数值见 config.ts NPC，均为提案）：
 * - 每个出租车位独立循环：空 → 等待（指数分布）→ NPC 到达 → 停靠（均匀分布，≤ 12 h 封顶）→ 自动离开 → 空 …
 * - 离开时停靠费进入待收取池（issue #28，来源提案 #22，用户 2026-11-07 拍板），不直接改余额；
 *   玩家“收取”才入账。池上限 48 h 期望收入（提案值），满了之后新的停车费不再累积（见 ledger.ts deposit）。
 *   NPC 的到达与离开本身不需要营主上线，池上限保证不会出现无限累积或无限等待；
 * - 营主不能赶走 NPC，也没有没收；爱心车位的 NPC 不给营主付费（只计公益时长）。
 * - 惰性回放：每次玩家请求时按时间顺序回放到 now；所有随机数由 (种子, 车位, 循环序号) 决定，
 *   同一时间点多次回放结果相同；parking_id = `${spotId}#${cycle}` 作为幂等键。
 */
import { ALL_VARIANTS } from '../data/models';
import { NPC } from './config';
import { dayKey, deposit, type Ledger } from './ledger';
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
  /**
   * 当日统计（issue #30 露营卡片）：上海日 day 内到访的露营者数（按到达时刻计）与爱心车位公益停靠分钟
   * （按离开时刻所在日计整段停靠，与 loveMinutes 的累计口径一致）。跨日时清零重计。
   * 本字段加入前的存档在 loadSave 中补为“从加载时起计”，加入前当天已发生的到访不补算。
   */
  daily: CampDaily;
}

export interface CampDaily {
  day: number;
  arrivals: number;
  loveMinutes: number;
}

export function emptyDaily(day: number): CampDaily {
  return { day, arrivals: 0, loveMinutes: 0 };
}

export function validDaily(x: unknown): x is CampDaily {
  const d = x as CampDaily;
  return !!d && typeof d === 'object' && [d.day, d.arrivals, d.loveMinutes].every((v) => Number.isSafeInteger(v)) && d.arrivals >= 0 && d.loveMinutes >= 0;
}

/** 取 atMs 所在上海日的统计桶；事件按时间顺序处理，新的一天清零 */
function dailyAt(sim: CampSim, atMs: number): CampDaily {
  const day = dayKey(atMs);
  if (day > sim.daily.day) sim.daily = emptyDaily(day);
  return sim.daily;
}

export type CampEvent =
  | { type: 'arrive'; atMs: number; spotId: string; stay: NpcStay }
  /** gross：停靠费；pooled：进入待收取池的部分；lost：池已满未累积的部分（gross = pooled + lost） */
  | { type: 'depart'; atMs: number; spotId: string; stay: NpcStay; gross: number; pooled: number; lost: number; minutes: number };

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
    daily: emptyDaily(dayKey(nowMs)),
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

/**
 * 第 cycle 位露营者的车型：25 个变体等概率（各 1/25），只由 (种子, 车位, 循环序号) 决定，与到达时刻、侧边帐无关。
 * 车型图鉴（dex.ts）据此为旧存档回填已离开露营者的车型。
 */
export function variantForCycle(seed: number, spotId: string, cycle: number): string {
  const u = uniform(seed, `car:${spotId}:${cycle}`);
  return ALL_VARIANTS[Math.floor(u * ALL_VARIANTS.length)].id;
}

function pickVariant(seed: number, sp: SpotSim): string {
  return variantForCycle(seed, sp.id, sp.cycle);
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
      let pooled = 0;
      let lost = 0;
      if (sp.kind === 'private') {
        gross = feeCents(minutes);
        ({ pooled, lost } = deposit(ledger, { key: stay.parkingId, gross }));
      } else {
        sim.loveMinutes += minutes;
        dailyAt(sim, stay.departMs).loveMinutes += minutes;
      }
      sim.settlements += 1;
      events.push({ type: 'depart', atMs: stay.departMs, spotId: sp.id, stay, gross, pooled, lost, minutes });
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
      dailyAt(sim, arriveMs).arrivals += 1;
      events.push({ type: 'arrive', atMs: arriveMs, spotId: sp.id, stay });
    }
  }
  throw new Error('NPC 回放事件数超出上限');
}
