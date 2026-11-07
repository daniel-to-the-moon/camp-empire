/**
 * 营地布局可达性：全部 25 个变体 × 全部车位，NPC 进场 / 离场、玩家一键泊入 / 倒出都必须规划成功，
 * 且路径不穿岛、不穿围栏、不穿其他车位里停着的最大车。
 */
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS, findVariant } from '../src/data/models';
import { HOME, loopLength, loopPose, SPAWN, stallById, STALLS, stallRect, staticShapes } from '../src/shared/camp';
import { SIDE_AWNING } from '../src/shared/config';
import { firstHit, polysOverlap, type Shape } from '../src/shared/geom2d';
import { footprint, poseFromCenter, specOf } from '../src/shared/kinematics';
import { uniform } from '../src/shared/rng';
import { againstLoop, parkedPose, pathCollides, planNpcArrival, planNpcDeparture, planParkIn, planReverseOut } from '../src/shared/parking';

const big = specOf(findVariant('SH5043XLJH9DB-C_3116')!);

describe('营地布局', () => {
  it('车位互不重叠，且不压环路岛与围栏', () => {
    for (let i = 0; i < STALLS.length; i++) {
      expect(firstHit(stallRect(STALLS[i]), staticShapes())).toBeNull();
      for (let j = i + 1; j < STALLS.length; j++) expect(polysOverlap(stallRect(STALLS[i]), stallRect(STALLS[j]))).toBe(false);
    }
  });
  it('家位能容纳最宽车 + 右侧 2.5 m 侧边帐', () => {
    const home = STALLS.find((s) => s.kind === 'home')!;
    expect(home.carLateral - 2.343 / 2 - SIDE_AWNING.depthM).toBeGreaterThanOrEqual(-HOME.width / 2);
  });
});

describe.each(ALL_VARIANTS.map((v) => [v.id, specOf(v)] as const))('可达性 %s', (_id, s) => {
  it.each(STALLS.map((st) => [st.id, st] as const))('车位 %s', (_sid, st) => {
    const others: Shape[] = STALLS.filter((o) => o.id !== st.id).map((o) => ({
      type: 'poly',
      pts: footprint(big, parkedPose(big, o)),
      tag: o.id,
    }));
    const obs = [...staticShapes(), ...others];
    expect(firstHit(footprint(s, parkedPose(s, st)), obs)).toBeNull();
    for (const r of [planNpcArrival(s, st, obs), planNpcDeparture(s, st, obs), planParkIn(s, SPAWN, st, obs), planReverseOut(s, st, obs)]) {
      expect(r.reason ?? 'ok').toBe('ok');
      // 不只看 reason：返回的路径逐点检查（含环路段）
      expect(pathCollides(s, r.path, obs)).toBeNull();
    }
  });
});

describe('NPC 路线：环路被车辆阻挡', () => {
  // GPT 审核 #4 第 4 条的反例：玩家车停在环路上，后轴位姿 (24, 0, π/2)
  const player = specOf(findVariant('SH5043XLJH9DB-C_3116')!);
  const blocker: Shape = { type: 'poly', pts: footprint(player, { x: 24, y: 0, yaw: Math.PI / 2 }), tag: 'player' };
  const obs = [...staticShapes(), blocker];

  it.each(ALL_VARIANTS.filter((_, i) => i % 4 === 0).map((v) => [v.id, specOf(v)] as const))('%s：成功的路线全程不碰撞，被挡的路线返回失败', (_id, s) => {
    let blocked = 0;
    for (const st of STALLS.filter((x) => x.kind !== 'home')) {
      for (const r of [planNpcArrival(s, st, obs), planNpcDeparture(s, st, obs)]) {
        if (r.ok) expect(pathCollides(s, r.path, obs)).toBeNull();
        else blocked++;
      }
      // 不加阻挡时同一车位能走通：失败确实是阻挡造成的
      expect(planNpcArrival(s, st, staticShapes()).ok).toBe(true);
    }
    expect(blocked).toBeGreaterThan(0);
  });
});

describe('一键泊回家位：环路上任意顺行起点都能规划成功', () => {
  const home = stallById('home');
  const obs = staticShapes();
  it.each(ALL_VARIANTS.filter((_, i) => i % 6 === 0).map((v) => [v.id, specOf(v)] as const))('%s', (_id, s) => {
    let tried = 0;
    for (let i = 0; i < 120; i++) {
      const p = loopPose(uniform(i, 's') * loopLength());
      const lat = (uniform(i, 'l') - 0.5) * 2.4;
      const yaw = p.yaw + (uniform(i, 'y') - 0.5) * 1.6 + (uniform(i, 'r') < 0.15 ? Math.PI : 0);
      const pose = poseFromCenter(s, p.x - Math.sin(p.yaw) * lat, p.y + Math.cos(p.yaw) * lat, yaw);
      if (firstHit(footprint(s, pose, 0.05), obs)) continue;
      tried++;
      const r = planParkIn(s, pose, home, obs);
      if (againstLoop(pose)) expect(r.ok || r.reason!.includes('方向相反')).toBe(true);
      else expect(r.reason ?? 'ok').toBe('ok');
    }
    expect(tried).toBeGreaterThan(80);
  });
});
