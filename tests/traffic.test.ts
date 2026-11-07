/**
 * 动态车辆让行（GPT 审核 #4 第 3 条）：同分钟到达、行驶途中出现障碍、玩家自动驾驶与 NPC 交互。
 * 每一帧都检查所有可见车辆两两不重叠。
 */
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS, findVariant } from '../src/data/models';
import { RENTAL_SPOTS, stallById, staticShapes } from '../src/shared/camp';
import type { Shape } from '../src/shared/geom2d';
import { footprint, specOf, type Pose } from '../src/shared/kinematics';
import { newLedger } from '../src/shared/ledger';
import { advanceCamp, newCampSim, type CampEvent } from '../src/shared/npc';
import { GATE_IN, parkedPose, pathCollides, planNpcArrival, planNpcDeparture, planParkIn, planReverseOut } from '../src/shared/parking';
import { anyOverlap, guardAutoRoute, PathRunner, PLAYER_GIVE_UP_S, SKIP_AFTER_S, stepTraffic, type Agent } from '../src/shared/traffic';

const DT = 1 / 60;
const big = specOf(findVariant('SH5043XLJH9DB-C_3116')!);

function arriving(id: string, variantId: string, spotId: string): Agent {
  const spec = specOf(findVariant(variantId)!);
  const stall = stallById(spotId);
  const plan = planNpcArrival(spec, stall, staticShapes());
  expect(plan.ok).toBe(true);
  return { id, spec, pose: plan.path[0], runner: new PathRunner(plan.path, 5), pending: true, waited: 0, skipTo: parkedPose(spec, stall) };
}

function expectAt(p: Pose, q: Pose | null | undefined) {
  expect(q).toBeTruthy();
  expect(Math.hypot(p.x - q!.x, p.y - q!.y)).toBeLessThan(1e-6);
  expect(Math.abs(Math.atan2(Math.sin(p.yaw - q!.yaw), Math.cos(p.yaw - q!.yaw)))).toBeLessThan(1e-6);
}

function staticCar(id: string, pose: Pose): Agent {
  return { id, spec: big, pose, runner: null, pending: false, waited: 0 };
}

/** 跑到所有行驶中的车停下或超时；每帧检查无重叠。返回跳过动画的车 */
function simulate(all: Agent[], seconds: number, each?: (t: number) => void): Agent[] {
  const skipped: Agent[] = [];
  for (let t = 0; t < seconds; t += DT) {
    each?.(t);
    // 与客户端一致：行驶 / 排队中的车 + 玩家车参与仲裁，停好的 NPC 不参与
    const r = stepTraffic(
      all.filter((a) => a.runner || a.id === 'player'),
      DT,
    );
    skipped.push(...r.skipped);
    const pair = anyOverlap(all.filter((a) => !(a.skipTo === null && !a.runner)));
    expect(pair && `${pair[0].id} ↔ ${pair[1].id} @ ${t.toFixed(2)} s`).toBeNull();
    if (all.every((a) => !a.runner)) break;
  }
  return skipped;
}

describe('同一分钟到达', () => {
  it('种子 17：p2 与爱心车位在同一分钟到达（复现审核场景）', () => {
    const t0 = Date.UTC(2026, 10, 5, 2);
    const sim = newCampSim(17, t0, RENTAL_SPOTS);
    const ev = advanceCamp(sim, newLedger(t0), t0 + 6 * 3600_000, { awningOut: false });
    const arrivals = ev.filter((e): e is Extract<CampEvent, { type: 'arrive' }> => e.type === 'arrive');
    const same = arrivals.filter((e) => arrivals.some((o) => o !== e && o.atMs === e.atMs));
    expect(same.map((e) => e.spotId).sort()).toEqual(['love', 'p2']);
  });

  it('两车同时从 GATE_IN 生成：先后进场，全程不重叠，都按路径停进车位', () => {
    const a = arriving('p2', 'SH5043XLJH9DB-C_3116', 'p2');
    const b = arriving('love', 'SH5043XLJH9DB-C_3116', 'love');
    expectAt(a.pose, GATE_IN);
    expectAt(b.pose, GATE_IN);
    let bothVisibleAtStart = false;
    const skipped = simulate([a, b], 120, () => {
      if (!a.pending && !b.pending && a.pose.x === GATE_IN.x && b.pose.x === GATE_IN.x && a.pose.y === b.pose.y) bothVisibleAtStart = true;
    });
    expect(bothVisibleAtStart).toBe(false);
    expect(skipped).toEqual([]);
    expectAt(a.pose, a.skipTo);
    expectAt(b.pose, b.skipTo);
  });

  it('全部出租车位同时到达（最大车型）：全程不重叠，最终都停好', () => {
    const cars = RENTAL_SPOTS.map((sp) => arriving(sp.id, 'SH5043XLJH9DB-C_3116', sp.id));
    simulate(cars, 300);
    for (const c of cars) {
      expect(c.runner).toBeNull();
      expectAt(c.pose, c.skipTo);
    }
  });
});

describe('行驶途中出现障碍', () => {
  // 审核反例里的玩家车位姿：停在环路上
  const blockPose: Pose = { x: 24, y: 0, yaw: Math.PI / 2 };
  const blockShape: Shape = { type: 'poly', pts: footprint(big, blockPose), tag: 'player' };
  const victim = RENTAL_SPOTS.find((sp) => {
    const p = planNpcArrival(big, stallById(sp.id), staticShapes());
    return pathCollides(big, p.path, [blockShape]);
  })!;

  it('存在路线经过该位置的车位', () => {
    expect(victim).toBeDefined();
  });

  it('玩家车途中停在环路上并一直不走：NPC 停车等待，超时后直接停进车位，期间不穿模', () => {
    const npc = arriving('npc', 'SH5043XLJH9DB-C_3116', victim.id);
    const player = staticCar('player', { x: 0, y: -100, yaw: 0 }); // 先在场外
    const skipped = simulate([player, npc], 120, (t) => {
      if (t >= 2 && t < 2 + DT) player.pose = blockPose;
    });
    expect(skipped).toEqual([npc]);
    expectAt(npc.pose, npc.skipTo);
  });

  it('障碍在超时前离开：NPC 恢复行驶并按路径到位（不跳过）', () => {
    const npc = arriving('npc', 'SH5043XLJH9DB-C_3116', victim.id);
    const player = staticCar('player', { x: 0, y: -100, yaw: 0 });
    let waitedMax = 0;
    const skipped = simulate([player, npc], 120, (t) => {
      if (t >= 2 && t < 2 + DT) player.pose = blockPose;
      // NPC 等了一半超时时间后，玩家开走
      if (npc.waited >= SKIP_AFTER_S / 2) player.pose = { x: 0, y: -100, yaw: 0 };
      waitedMax = Math.max(waitedMax, npc.waited);
    });
    expect(skipped).toEqual([]);
    expect(waitedMax).toBeGreaterThan(1); // 确实被挡过
    expectAt(npc.pose, npc.skipTo);
  });

  it('玩家自动驾驶与 NPC 走同一段路：NPC 让行，玩家不跳过、不穿模', () => {
    const npc = arriving('npc', 'SH5043XLJH9DB-C_3116', victim.id);
    // 玩家自动驾驶沿同一路线的前半段（大门 → 环路），走完后停在路上
    const half = (npc.runner as PathRunner).path.slice(0, Math.floor((npc.runner as PathRunner).path.length / 2));
    const player: Agent = { id: 'player', spec: big, pose: half[0], runner: new PathRunner(half, 6), pending: false, waited: 0 };
    simulate([player, npc], 120);
    expect(player.runner).toBeNull();
    expectAt(player.pose, half[half.length - 1]);
    expect(npc.runner).toBeNull();
    expectAt(npc.pose, npc.skipTo);
  });

  it('离场 NPC 被长期挡住：超时后直接驶离（移除）', () => {
    const stall = stallById(victim.id);
    const plan = planNpcDeparture(big, stall, staticShapes());
    expect(plan.ok).toBe(true);
    const npc: Agent = { id: 'npc', spec: big, pose: plan.path[0], runner: new PathRunner(plan.path, 5), pending: false, waited: 0, skipTo: null };
    // 玩家车挡在倒出路线上：取路线上第一个与起点车身不重叠的位姿
    const start: Shape = { type: 'poly', pts: footprint(big, plan.path[0]), tag: 'start' };
    const p = plan.path.find((q) => !pathCollides(big, [q], [start]))!;
    const player = staticCar('player', { x: p.x, y: p.y, yaw: p.yaw });
    const skipped = simulate([player, npc], 120);
    expect(skipped).toEqual([npc]);
    expect(npc.runner).toBeNull();
  });
});

describe('玩家自动驾驶途中 NPC 停好（第 3 轮 major）', () => {
  // 审核复现：双方 SH5043，玩家从后轴位姿自动回家，p2 入场车剩余路径 8 m
  const PLAYER_FROM: Pose = { x: -1.44816, y: 10.34888, yaw: 3.36241 };
  const home = stallById('home');
  const replan = (from: Pose, parked: Shape[]) => {
    const p = planParkIn(big, from, home, [...staticShapes(), ...parked]);
    return p.ok ? p.path : null;
  };

  function scenario(npcRemaining = 8) {
    const plan = planParkIn(big, PLAYER_FROM, home, staticShapes()); // 规划时 p2 的车还在路上，不算障碍
    expect(plan.ok).toBe(true);
    const player: Agent = { id: 'player', spec: big, pose: plan.path[0], runner: new PathRunner(plan.path, 6), pending: false, waited: 0, avoidParked: true };
    const npc = arriving('p2', 'SH5043XLJH9DB-C_3116', 'p2');
    npc.pending = false;
    while (npc.runner!.remaining > npcRemaining) npc.pose = npc.runner!.step(DT);
    return { player, npc };
  }

  /** 与客户端主循环一致：玩家 + 行驶中的 NPC + 停好的 NPC（parked）参与仲裁，之后守护玩家路线 */
  function run(player: Agent, npcs: Agent[], guard: boolean, seconds = 60) {
    const log: string[] = [];
    let overlapAt: string | null = null;
    for (let t = 0; t < seconds; t += DT) {
      for (const n of npcs) n.parked = guard && !n.runner;
      const traffic = [player, ...npcs.filter((n) => n.runner || (guard && n.parked))];
      const step = stepTraffic(traffic, DT);
      if (guard) {
        const changed = [...step.finished, ...step.skipped].some((a) => a !== player);
        const g = guardAutoRoute(
          player,
          npcs.filter((n) => n.parked || !n.runner),
          changed,
          replan,
          6,
        );
        if (g.kind !== 'keep') log.push(g.kind);
      }
      const pair = anyOverlap([player, ...npcs]);
      if (pair && !overlapAt) overlapAt = `${pair[0].id} ↔ ${pair[1].id} @ ${t.toFixed(2)} s`;
      if (!player.runner && npcs.every((n) => !n.runner)) break;
    }
    return { log, overlapAt };
  }

  it('对照：只按规划时的车辆避让（上一版行为）会与刚停好的 NPC 重叠', () => {
    const { player, npc } = scenario();
    const { overlapAt } = run(player, [npc], false);
    expect(overlapAt).not.toBeNull();
  });

  it('修复后：NPC 停好后玩家剩余路线被重新验证并重规划，逐帧无重叠，最终停回家位', () => {
    const { player, npc } = scenario();
    const { log, overlapAt } = run(player, [npc], true);
    expect(overlapAt).toBeNull();
    expect(npc.runner).toBeNull();
    expectAt(npc.pose, npc.skipTo);
    expect(log).toContain('replanned');
    expect(player.runner).toBeNull();
    expectAt(player.pose, parkedPose(big, home));
  });

  it('无法重规划时放弃自动驾驶，玩家车停在原地且不与 NPC 重叠', () => {
    // replan 永远失败
    const { player, npc } = scenario();
    let aborted = false;
    for (let t = 0; t < 60 && !aborted; t += DT) {
      npc.parked = !npc.runner;
      const step = stepTraffic([player, npc], DT);
      const g = guardAutoRoute(player, npc.parked ? [npc] : [], step.finished.includes(npc), () => null, 6);
      expect(anyOverlap([player, npc])).toBeNull();
      if (g.kind === 'abort') aborted = true;
      else if (!player.runner) break;
    }
    expect(aborted).toBe(true);
    expect(player.runner).toBeNull();
    expect(anyOverlap([player, npc])).toBeNull();
  });

  it('出租车位全部停满最大车型时，各车型从家位倒出的路线都不碰停好的车（倒出时不会因此被挡）', () => {
    const parked: Shape[] = RENTAL_SPOTS.map((sp) => ({ type: 'poly', pts: footprint(big, parkedPose(big, stallById(sp.id))), tag: sp.id }));
    for (const v of ALL_VARIANTS) {
      const s = specOf(v);
      const p = planReverseOut(s, home, [...staticShapes(), ...parked]);
      expect(p.ok, v.id).toBe(true);
      expect(pathCollides(s, p.path, parked), v.id).toBeNull();
    }
  });

  it('剩余路线不受影响时不重规划', () => {
    const plan = planParkIn(big, PLAYER_FROM, home, staticShapes());
    const player: Agent = { id: 'player', spec: big, pose: plan.path[0], runner: new PathRunner(plan.path, 6), pending: false, waited: 0, avoidParked: true };
    const far: Agent = { ...staticCar('far', { x: 0, y: -100, yaw: 0 }), parked: true };
    const before = player.runner;
    expect(guardAutoRoute(player, [far], true, replan, 6)).toEqual({ kind: 'keep' });
    expect(player.runner).toBe(before);
  });

  it(`被挡超过 ${PLAYER_GIVE_UP_S} s：放弃自动驾驶`, () => {
    const plan = planParkIn(big, PLAYER_FROM, home, staticShapes());
    const player: Agent = { id: 'player', spec: big, pose: plan.path[0], runner: new PathRunner(plan.path, 6), pending: false, waited: PLAYER_GIVE_UP_S, avoidParked: true };
    expect(guardAutoRoute(player, [], false, replan, 6).kind).toBe('abort');
    expect(player.runner).toBeNull();
  });

  it('停好的车只挡 avoidParked 的参与者：NPC 之间不受停好车辆的外扩影响', () => {
    const parkedNpc: Agent = { ...staticCar('x', { x: 0, y: 0, yaw: 0 }), parked: true };
    const mover: Agent = { id: 'm', spec: big, pose: { x: 0, y: 0, yaw: 0 }, runner: new PathRunner([{ x: 0, y: 0, yaw: 0, dir: 1 }, { x: 1, y: 0, yaw: 0, dir: 1 }], 5), pending: false, waited: 0 };
    stepTraffic([mover, parkedNpc], DT);
    expect(mover.waited).toBe(0); // NPC 不避让停好的车
    const p2: Agent = { ...mover, id: 'p', runner: new PathRunner(mover.runner!.path, 5), avoidParked: true };
    stepTraffic([p2, parkedNpc], DT);
    expect(p2.waited).toBeGreaterThan(0); // 玩家自动驾驶避让
  });
});
