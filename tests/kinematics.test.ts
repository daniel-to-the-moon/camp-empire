import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS, findVariant } from '../src/data/models';
import { dubinsAll, dubinsAt, segCurvatures } from '../src/shared/dubins';
import {
  bodyCenter,
  footprint,
  integrate,
  minRearAxleRadius,
  poseFromCenter,
  realOuterFrontRadius,
  specOf,
  stepDrive,
  sweptEnvelope,
  type DriveState,
} from '../src/shared/kinematics';
import { uniform } from '../src/shared/rng';

const a4db = specOf(findVariant(ALL_VARIANTS.find((v) => v.model === 'SH6601A4DB')!.id)!);

describe('转弯半径', () => {
  it('30° 外轮转角复现 A4DB 手册最小转弯直径 16.7 m', () => {
    expect(2 * realOuterFrontRadius(a4db)).toBeCloseTo(16.7, 2);
  });
  it('游戏半径 = k × 真实半径，k 越小越好开', () => {
    expect(minRearAxleRadius(a4db, 0.75)).toBeLessThan(minRearAxleRadius(a4db, 1));
  });
  it.each(ALL_VARIANTS.map((v) => [v.id, specOf(v)] as const))('%s 包络合理：内侧半径 > 0，外角 > 后轴', (_id, s) => {
    const e = sweptEnvelope(s, minRearAxleRadius(s));
    expect(e.innerR).toBeGreaterThan(0);
    expect(e.outerR).toBeGreaterThan(e.rearAxleR + s.widthM / 2);
  });
});

describe('手动驾驶', () => {
  it('满舵持续转圈，实际转弯半径不小于最小半径', () => {
    let st: DriveState = { pose: { x: 0, y: 0, yaw: 0 }, speed: 0, curvature: 0 };
    let maxK = 0;
    for (let i = 0; i < 2000; i++) {
      st = stepDrive(a4db, st, { throttle: 1, steer: 1 }, 1 / 60);
      maxK = Math.max(maxK, Math.abs(st.curvature));
    }
    expect(maxK).toBeLessThanOrEqual(1 / minRearAxleRadius(a4db) + 1e-12);
  });
  it('大步长积分仍在圆上（不会因帧率低而转得更急）', () => {
    const r = 5;
    const p = integrate({ x: 0, y: 0, yaw: 0 }, 10, 1 / r, 1.3);
    expect(Math.hypot(p.x, p.y - r)).toBeCloseTo(r, 9);
  });
  it('倒车：反向油门先刹停再倒车，速度不超上限', () => {
    let st: DriveState = { pose: { x: 0, y: 0, yaw: 0 }, speed: 3, curvature: 0 };
    for (let i = 0; i < 600; i++) st = stepDrive(a4db, st, { throttle: -1, steer: 0 }, 1 / 60);
    expect(st.speed).toBeLessThan(0);
    expect(st.speed).toBeGreaterThanOrEqual(-2.5);
  });
  it('车身中心 ↔ 后轴位姿互逆，footprint 长宽 = 公告长宽', () => {
    const p = poseFromCenter(a4db, 3, 4, 0.7);
    const [cx, cy] = bodyCenter(a4db, p);
    expect(cx).toBeCloseTo(3, 9);
    expect(cy).toBeCloseTo(4, 9);
    const f = footprint(a4db, p);
    expect(Math.hypot(f[1][0] - f[0][0], f[1][1] - f[0][1])).toBeCloseTo(a4db.lengthM, 9);
    expect(Math.hypot(f[2][0] - f[1][0], f[2][1] - f[1][1])).toBeCloseTo(a4db.widthM, 9);
  });
});

describe('Dubins 曲线', () => {
  it('随机 500 组起终点：每条解都精确到达终点，曲率不超过 1/r', () => {
    let n = 0;
    for (let i = 0; i < 500; i++) {
      const u = (k: string) => uniform(i, k);
      const q0 = { x: u('a') * 40 - 20, y: u('b') * 40 - 20, yaw: u('c') * 6.28 - 3.14 };
      const q1 = { x: u('d') * 40 - 20, y: u('e') * 40 - 20, yaw: u('f') * 6.28 - 3.14 };
      const r = 3 + u('g') * 5;
      for (const p of dubinsAll(q0, q1, r)) {
        n++;
        const e = dubinsAt(p, p.length);
        expect(Math.hypot(e.x - q1.x, e.y - q1.y)).toBeLessThan(1e-6);
        expect(Math.abs(Math.atan2(Math.sin(e.yaw - q1.yaw), Math.cos(e.yaw - q1.yaw)))).toBeLessThan(1e-6);
        for (const k of segCurvatures(p)) expect(Math.abs(k)).toBeLessThanOrEqual(1 / r + 1e-12);
      }
    }
    expect(n).toBeGreaterThan(1500);
  });
});
