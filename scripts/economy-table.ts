/**
 * docs/ECONOMY_M1.md 推演表的数字来源：npm run economy:table
 * 改 src/shared/config.ts 后重跑，并把输出同步进文档。
 * 解析值（更新过程期望）与真实模拟器蒙特卡洛（同一份 advanceCamp 代码）并列，二者应吻合。
 */
import { RENTAL_SPOTS } from '../src/shared/camp';
import { DAILY_GIFT, ECONOMY, NPC, SIDE_AWNING } from '../src/shared/config';
import { newLedger } from '../src/shared/ledger';
import { advanceCamp, newCampSim } from '../src/shared/npc';

const DAY = 86_400_000;
const f = (n: number, d = 1) => n.toFixed(d);

const privateSpots = RENTAL_SPOTS.filter((s) => s.kind === 'private').length;
const meanStay = (NPC.minStayMinutes + NPC.capMinutes) / 2; // 均匀整数分钟 [min, cap] 的均值
const giftMean = DAILY_GIFT.reduce((s, g) => s + g.gold * g.p, 0);

function analytic(awning: boolean) {
  const gap = NPC.meanGapMinutes * (awning ? NPC.awningGapFactor : 1);
  const cycle = meanStay + gap;
  const occupancy = meanStay / cycle;
  // 更新回报定理：长期每分钟收入 = 每次停靠期望收入 / 期望循环长度
  const perSpotDay = ((1440 * meanStay) / cycle) * (NPC.rateCentsPerHour / 100 / 60);
  return { gap, cycle, occupancy, perSpotDay, parkingDay: perSpotDay * privateSpots };
}

function monteCarlo(awning: boolean, seeds: number, days: number) {
  const t0 = Date.UTC(2026, 10, 1, 16); // 上海 11-02 00:00
  const per: number[] = [];
  for (let seed = 0; seed < seeds; seed++) {
    const l = newLedger(t0);
    const sim = newCampSim(seed, t0, RENTAL_SPOTS);
    // 前 2 天预热（开局车位全空，不代表稳态）
    advanceCamp(sim, l, t0 + 2 * DAY, { awningOut: awning });
    const b0 = l.balance;
    advanceCamp(sim, l, t0 + (2 + days) * DAY, { awningOut: awning });
    per.push((l.balance - b0) / 100 / days);
  }
  per.sort((a, b) => a - b);
  const mean = per.reduce((s, x) => s + x, 0) / per.length;
  return { mean, p5: per[Math.floor(per.length * 0.05)], p95: per[Math.floor(per.length * 0.95)] };
}

console.log('## 输入参数\n');
console.log(`- 私家车位 ${privateSpots} 个，爱心车位 ${RENTAL_SPOTS.length - privateSpots} 个（不付费）`);
console.log(`- 停靠费 ${NPC.rateCentsPerHour / 100} 金/小时；停靠时长 U[${NPC.minStayMinutes}, ${NPC.capMinutes}] 分钟，均值 ${meanStay}`);
console.log(`- 空位等待 Exp(均值 ${NPC.meanGapMinutes} 分钟)；侧边帐展开 ×${NPC.awningGapFactor}`);
console.log(`- 每日礼物期望 ${f(giftMean)} 金；开局 ${ECONOMY.startingGold} 金；侧边帐 ${SIDE_AWNING.priceGold} 金\n`);

console.log('## 日收入（稳态）\n');
console.log('| 情形 | 循环 分钟 | 占用率 | 每车位 金/天 | 停车 金/天（解析） | 停车 金/天（模拟均值，P5–P95） | 含礼物 金/天 |');
console.log('|---|---|---|---|---|---|---|');
const rows: Array<[string, boolean]> = [
  ['无侧边帐', false],
  ['侧边帐常驻展开', true],
];
const res: Record<string, ReturnType<typeof analytic>> = {};
for (const [name, aw] of rows) {
  const a = analytic(aw);
  res[name] = a;
  const mc = monteCarlo(aw, 200, 28);
  console.log(
    `| ${name} | ${f(a.cycle)} | ${f(a.occupancy * 100)}% | ${f(a.perSpotDay)} | ${f(a.parkingDay)} | ${f(mc.mean)}（${f(mc.p5)}–${f(mc.p95)}） | ${f(a.parkingDay + giftMean)} |`,
  );
}

const gain = res['侧边帐常驻展开'].parkingDay - res['无侧边帐'].parkingDay;
console.log('\n## 侧边帐回本\n');
console.log(`- 日增收 ${f(gain, 2)} 金 → 回本 ${f(SIDE_AWNING.priceGold / gain)} 天`);

const daily = res['无侧边帐'].parkingDay + giftMean;
console.log('\n## 开局资金路径（无侧边帐，期望值）\n');
console.log(`- 开局 ${ECONOMY.startingGold} 金即可买侧边帐（剩 ${ECONOMY.startingGold - SIDE_AWNING.priceGold}）`);
console.log(`- 日收入期望 ${f(daily)} 金，远低于软上限阈值 ${ECONOMY.softCapThresholdGold} 金 → M1 正常游玩不会触发软上限`);
console.log(`- 软上限触发所需日毛收入 ${ECONOMY.softCapThresholdGold} 金 ≈ ${f(ECONOMY.softCapThresholdGold / daily, 2)} 倍当前期望`);
