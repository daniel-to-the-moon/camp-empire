/**
 * docs/SWEPT_PATH.md 的数字来源：npm run swept:table
 * 每个高度变体：真实 / 游戏最小转弯半径、满舵扫掠包络、与环路车道宽度的余量。
 */
import { ALL_VARIANTS } from '../src/data/models';
import { ROAD } from '../src/shared/camp';
import { DRIVING } from '../src/shared/config';
import { gameOuterFrontRadius, minRearAxleRadius, outerSteerDeg, realOuterFrontRadius, specOf, sweptEnvelope } from '../src/shared/kinematics';

const f = (n: number, d = 2) => n.toFixed(d);
const seen = new Set<string>();
console.log(`k = ${DRIVING.turnScaleK}；环路车道宽 ${ROAD.width} m，中心线半径 ${ROAD.centerR} m\n`);
console.log('| 车型 | 轴距 | 真实外前轮半径 | 游戏外前轮半径 | 满舵外轮转角 | 后轴最小半径 | 满舵扫掠宽 | 沿环路（R=9）扫掠宽 | 环路余量 |');
console.log('|---|---|---|---|---|---|---|---|---|');
for (const v of ALL_VARIANTS) {
  // 转弯与高度无关，同一基础车型只列一行
  if (seen.has(v.model)) continue;
  seen.add(v.model);
  const s = specOf(v);
  const e = sweptEnvelope(s, minRearAxleRadius(s));
  // 沿环路中心线行驶：后轴中心半径取中心线半径（近似）
  const loop = sweptEnvelope(s, ROAD.centerR);
  console.log(
    `| ${v.model} | ${f(s.wheelbaseM, 3)} | ${f(realOuterFrontRadius(s))} | ${f(gameOuterFrontRadius(s))} | ${f(outerSteerDeg(s), 1)}° | ${f(minRearAxleRadius(s))} | ${f(e.sweptW)} | ${f(loop.sweptW)} | ${f(ROAD.width - loop.sweptW)} |`,
  );
}
