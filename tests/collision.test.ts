import { describe, expect, it } from 'vitest';
import { findVariant } from '../src/data/models';
import { staticShapes } from '../src/shared/camp';
import { COLLISION, resolveDrive } from '../src/shared/collision';
import { firstHit, penetration, rect, type Shape } from '../src/shared/geom2d';
import { footprint, specOf, stepDrive, type DriveState } from '../src/shared/kinematics';
import { uniform } from '../src/shared/rng';

const s = specOf(findVariant('SH5043XLJH9DB-C_3116')!);
// 一堵南北走向的墙，墙面在 x = 10
const wall: Shape = { type: 'poly', pts: rect(10.5, 0, 0, 1, 40), tag: 'wall' };
const front = s.wheelbaseM + s.frontOverhangM;

function driveInto(yaw: number, speed: number) {
  // 车头离墙 5 cm，以给定速度和朝向撞过去
  const prev: DriveState = { pose: { x: 10 - 0.05 - front * Math.cos(yaw) - (s.widthM / 2) * Math.abs(Math.sin(yaw)), y: 0, yaw }, speed, curvature: 0 };
  // 逐帧滑行直到撞上（擦边时每帧朝墙移动很少，一帧碰不到）
  let st = prev;
  for (let i = 0; i < 60; i++) {
    const before = st.speed;
    const r = resolveDrive(s, st, stepDrive(s, st, { throttle: 0, steer: 0 }, 1 / 30), [wall]);
    if (r.impact) return { ...r, before };
    st = r.state;
  }
  return { state: st, impact: null, before: st.speed };
}

describe('穿透检测', () => {
  it('多边形：法线从障碍物指向车，深度 = 重叠量', () => {
    const car = rect(9.8, 0, 0, 1, 1); // 右沿 x = 10.3，压进墙 0.3
    const p = penetration(car, wall)!;
    expect(p.n[0]).toBeCloseTo(-1, 9);
    expect(p.depth).toBeCloseTo(0.3, 9);
  });
  it('圆：法线从圆心指向车', () => {
    const p = penetration(rect(0, 1.2, 0, 2, 1), { type: 'circle', c: [0, 0], r: 1, tag: 't' })!;
    expect(p.n[1]).toBeCloseTo(1, 9);
    expect(p.depth).toBeCloseTo(0.3, 9);
  });
});

describe('碰撞响应', () => {
  it('正撞：反弹，速度 ≈ −e × 撞击速度（不归零），且解算后不穿墙', () => {
    const { state, impact } = driveInto(0, 4);
    expect(impact).not.toBeNull();
    expect(impact!.strength).toBeCloseTo(4, 1);
    expect(state.speed).toBeLessThan(0);
    expect(state.speed).toBeGreaterThan(-COLLISION.restitution * 4 - 1e-9);
    expect(Math.abs(state.speed)).toBeGreaterThan(0.5);
    expect(firstHit(footprint(s, state.pose), [wall])).toBeNull();
  });
  it('擦边（车头与墙面夹 15°）：只损失少量速度，继续前进', () => {
    const yaw = (75 * Math.PI) / 180; // 与墙法线夹 75° = 与墙面夹 15°
    const { state, impact, before } = driveInto(yaw, 4);
    expect(impact).not.toBeNull();
    expect(state.speed).toBeGreaterThan(before * 0.8);
    expect(firstHit(footprint(s, state.pose), [wall])).toBeNull();
  });
  it('倒车撞墙：向前弹开', () => {
    const prev: DriveState = { pose: { x: 10 - 0.05 - s.rearOverhangM, y: 0, yaw: Math.PI }, speed: -2, curvature: 0 };
    const next = stepDrive(s, prev, { throttle: 0, steer: 0 }, 1 / 30);
    const { state } = resolveDrive(s, prev, next, [wall]);
    expect(state.speed).toBeGreaterThan(0);
  });
  it('随机乱开 20 分钟：车身任何时刻都不与营地障碍物重叠，也不会卡死在零速', () => {
    const obs = staticShapes();
    let st: DriveState = { pose: { x: -8, y: -32, yaw: Math.PI / 2 }, speed: 0, curvature: 0 };
    let impacts = 0;
    for (let i = 0; i < 20 * 60 * 30; i++) {
      const seg = Math.floor(i / 45);
      const input = { throttle: uniform(seg, 't') < 0.75 ? 1 : -1, steer: uniform(seg, 's') * 2 - 1 };
      const next = stepDrive(s, st, input, 1 / 30);
      const r = resolveDrive(s, st, next, obs);
      if (r.impact) impacts++;
      st = r.state;
      expect(firstHit(footprint(s, st.pose), obs)).toBeNull();
    }
    expect(impacts).toBeGreaterThan(10);
  });
});
