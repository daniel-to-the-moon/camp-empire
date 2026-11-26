import { ECONOMY } from './config';

/** 视觉提案 / 待核实：与 HUD 同一个上海时钟，18:00（含）至次日 06:00（不含）亮常亮灯。
 * 不模拟真实日落，也不影响驾驶信号灯、存档或经济结算。
 */
export function runningLights(nowMs: number) {
  const hour = Math.floor((nowMs + ECONOMY.dayOffsetMs) / 3600_000) % 24;
  const night = hour >= 18 || hour < 6;
  return { head: night, tail: night, marker: night };
}
