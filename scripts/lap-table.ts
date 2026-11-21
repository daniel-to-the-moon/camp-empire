/**
 * docs/DRIVING_VIEW.md 第一节的数字来源：npm run lap:table
 * 每个基础车型：巡航 / 加速挡的最高速、静止起步圈时、飞驰圈时（游戏物理仿真，60 帧/秒，纯追踪驾驶员油门到底）。
 */
import { ALL_VARIANTS } from '../src/data/models';
import { playerObstacles } from '../src/client/drive';
import { loopLength } from '../src/shared/camp';
import { DRIVING } from '../src/shared/config';
import { specOf } from '../src/shared/kinematics';
import { idealLapS, simulateLaps } from '../src/shared/lapsim';

const f = (n: number, d = 2) => n.toFixed(d);
const obs = playerObstacles();
console.log(`环路中心线长 ${f(loopLength())} m；巡航上限 ${DRIVING.maxForwardSpeed} m/s（${f(DRIVING.maxForwardSpeed * 3.6, 1)} km/h），加速挡上限 ${DRIVING.boostMaxForwardSpeed} m/s（${f(DRIVING.boostMaxForwardSpeed * 3.6, 1)} km/h）`);
console.log(`恒速理论圈时：巡航 ${f(idealLapS(DRIVING.maxForwardSpeed))} s，加速挡 ${f(idealLapS(DRIVING.boostMaxForwardSpeed))} s\n`);
console.log('| 车型 | 巡航最高速 km/h | 巡航起步圈 s | 巡航飞驰圈 s | 加速最高速 km/h | 加速起步圈 s | 加速飞驰圈 s | 飞驰圈缩短 | 接触次数 |');
console.log('|---|---|---|---|---|---|---|---|---|');
const seen = new Set<string>();
for (const v of ALL_VARIANTS) {
  if (seen.has(v.model)) continue; // 速度与圈速与车高无关，同一基础车型只列一行
  seen.add(v.model);
  const s = specOf(v);
  const a = simulateLaps(s, false, obs);
  const b = simulateLaps(s, true, obs);
  console.log(
    `| ${v.model} | ${f(a.maxSpeed * 3.6, 1)} | ${f(a.standingS)} | ${f(a.flyingS)} | ${f(b.maxSpeed * 3.6, 1)} | ${f(b.standingS)} | ${f(b.flyingS)} | ${f((1 - b.flyingS / a.flyingS) * 100, 1)}% | ${a.impacts + b.impacts} |`,
  );
}
