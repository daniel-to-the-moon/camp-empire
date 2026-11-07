/**
 * docs/ECONOMY_M1.md 推演表的数字来源：npm run economy:table
 * 改 src/shared/config.ts 后重跑，并把输出同步进文档。
 * 解析值（更新过程期望，src/shared/economy.ts）与真实模拟器蒙特卡洛（同一份 advanceCamp 代码）并列，二者应吻合。
 * 停车费离开时进入待收取池（#28），所以模拟收入按离开事件的停靠费毛额统计，不看余额。
 */
import { RENTAL_SPOTS } from '../src/shared/camp';
import { DAILY_GIFT, ECONOMY, NPC, PENDING, SIDE_AWNING } from '../src/shared/config';
import { derivedPendingCapGold, expectedParking, MEAN_STAY_MINUTES, PRIVATE_SPOTS } from '../src/shared/economy';
import { newLedger } from '../src/shared/ledger';
import { advanceCamp, newCampSim, type CampEvent } from '../src/shared/npc';

const DAY = 86_400_000;
const H = 3_600_000;
const f = (n: number, d = 1) => n.toFixed(d);

const giftMean = DAILY_GIFT.reduce((s, g) => s + g.gold * g.p, 0);
const grossOf = (ev: CampEvent[]) => ev.reduce((s, e) => s + (e.type === 'depart' ? e.gross : 0), 0);
const pct = (xs: number[], p: number) => xs[Math.min(xs.length - 1, Math.floor(xs.length * p))];

function monteCarlo(awning: boolean, seeds: number, days: number) {
  const t0 = Date.UTC(2026, 10, 1, 16); // 上海 11-02 00:00
  const per: number[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    const l = newLedger(t0);
    const sim = newCampSim(seed, t0, RENTAL_SPOTS);
    // 前 2 天预热（开局车位全空，不代表稳态）
    advanceCamp(sim, l, t0 + 2 * DAY, { awningOut: awning });
    const ev = advanceCamp(sim, l, t0 + (2 + days) * DAY, { awningOut: awning });
    per.push(grossOf(ev) / 100 / days);
  }
  per.sort((a, b) => a - b);
  const mean = per.reduce((s, x) => s + x, 0) / per.length;
  return { mean, p5: pct(per, 0.05), p95: pct(per, 0.95) };
}

/** 稳态下收取一次后，待收取池从 0 到满所需小时（逐笔离开事件累计到上限的时刻） */
function hoursToFull(awning: boolean, seeds: number) {
  const t0 = Date.UTC(2026, 10, 1, 16);
  const cap = PENDING.capGold * 100;
  const hs: number[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    const sim = newCampSim(seed, t0, RENTAL_SPOTS);
    const start = t0 + 2 * DAY;
    advanceCamp(sim, newLedger(t0), start, { awningOut: awning });
    let acc = 0;
    for (const e of advanceCamp(sim, newLedger(t0), start + 10 * DAY, { awningOut: awning })) {
      if (e.type !== 'depart') continue;
      acc += e.gross;
      if (acc >= cap) {
        hs.push((e.atMs - start) / H);
        break;
      }
    }
  }
  hs.sort((a, b) => a - b);
  return { mean: hs.reduce((s, x) => s + x, 0) / hs.length, min: hs[0], p5: pct(hs, 0.05), p50: pct(hs, 0.5), p95: pct(hs, 0.95) };
}

console.log('## 输入参数\n');
console.log(`- 私家车位 ${PRIVATE_SPOTS} 个，爱心车位 ${RENTAL_SPOTS.length - PRIVATE_SPOTS} 个（不付费）`);
console.log(`- 停靠费 ${NPC.rateCentsPerHour / 100} 金/小时；停靠时长 U[${NPC.minStayMinutes}, ${NPC.capMinutes}] 分钟，均值 ${MEAN_STAY_MINUTES}`);
console.log(`- 空位等待 Exp(均值 ${NPC.meanGapMinutes} 分钟)；侧边帐展开 ×${NPC.awningGapFactor}`);
console.log(`- 每日礼物期望 ${f(giftMean)} 金；开局 ${ECONOMY.startingGold} 金；侧边帐 ${SIDE_AWNING.priceGold} 金`);
console.log(`- 待收取池上限 ${PENDING.capGold} 金（${PENDING.capHours} h 期望，按侧边帐展开情形推出 ${derivedPendingCapGold()}）\n`);

console.log('## 日收入（稳态）\n');
console.log('| 情形 | 循环 分钟 | 占用率 | 每车位 金/天 | 停车 金/天（解析） | 停车 金/天（模拟均值，P5–P95） | 含礼物 金/天 |');
console.log('|---|---|---|---|---|---|---|');
const rows: Array<[string, boolean]> = [
  ['无侧边帐', false],
  ['侧边帐常驻展开', true],
];
for (const [name, aw] of rows) {
  const a = expectedParking(aw);
  const mc = monteCarlo(aw, 200, 28);
  console.log(
    `| ${name} | ${f(a.cycle)} | ${f(a.occupancy * 100)}% | ${f(a.perSpotGoldPerDay)} | ${f(a.goldPerDay)} | ${f(mc.mean)}（${f(mc.p5)}–${f(mc.p95)}） | ${f(a.goldPerDay + giftMean)} |`,
  );
}

console.log('\n## 待收取池：收取后从 0 到满\n');
console.log('| 情形 | 解析 小时（上限 / 期望时速） | 模拟均值 小时 | 样本最小 / P5 / P50 / P95 小时 |');
console.log('|---|---|---|---|');
for (const [name, aw] of rows) {
  const a = expectedParking(aw);
  const mc = hoursToFull(aw, 200);
  console.log(`| ${name} | ${f((PENDING.capGold / a.goldPerDay) * 24)} | ${f(mc.mean)} | ${f(mc.min)} / ${f(mc.p5)} / ${f(mc.p50)} / ${f(mc.p95)} |`);
}

const gain = expectedParking(true).goldPerDay - expectedParking(false).goldPerDay;
console.log('\n## 侧边帐回本\n');
console.log(`- 日增收 ${f(gain, 2)} 金 → 回本 ${f(SIDE_AWNING.priceGold / gain)} 天`);

const daily = expectedParking(false).goldPerDay + giftMean;
console.log('\n## 开局资金路径（无侧边帐，期望值）\n');
console.log(`- 开局 ${ECONOMY.startingGold} 金即可买侧边帐（剩 ${ECONOMY.startingGold - SIDE_AWNING.priceGold}）`);
console.log(`- 日收入期望 ${f(daily)} 金，低于软上限阈值 ${ECONOMY.softCapThresholdGold} 金；但收取按收取时刻计日，长时间离开后同日收取两次仍可能触发软上限（见 docs/ECONOMY_M1.md 发现 3）`);
console.log(`- 软上限触发所需日毛收入 ${ECONOMY.softCapThresholdGold} 金 ≈ ${f(ECONOMY.softCapThresholdGold / daily, 2)} 倍当前期望`);
