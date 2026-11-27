/** issue #44：加速挡、车灯、视图 / 环绕相机、引擎盖视角、触屏手势 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS, findVariant } from '../src/data/models';
import { playerObstacles } from '../src/client/drive';
import { fenceShapes, loopLength, treeShapes } from '../src/shared/camp';
import css from '../src/style.css?raw';
import sceneSrc from '../src/client/scene.ts?raw';
import {
  applyShake,
  camFor,
  clampOrbit,
  SHAKE_MAX_M,
  followCam,
  HOOD,
  hoodCam,
  hoodMount,
  ORBIT,
  OrbitGesture,
  orbitBehind,
  orbitFrom,
  VIEW_LABEL,
  DEFAULT_VIEW,
  orbitCam,
  smoothOrbit,
  VIEWS,
  ViewChoice,
  viewForKey,
  wheelZoom,
  type Orbit,
  type Target,
} from '../src/shared/camview';
import { resolveDrive } from '../src/shared/collision';
import { DRIVING, FRAME_MAX_DT_S } from '../src/shared/config';
import { firstHit, penetration, type Shape } from '../src/shared/geom2d';
import { footprint, specOf, stepDrive, type DriveState } from '../src/shared/kinematics';
import { idealLapS, simulateLaps } from '../src/shared/lapsim';
import { BlinkClock, blinkOn, LIGHTS, lightsFor, manualBraking } from '../src/shared/lights';
import { uniform } from '../src/shared/rng';
import { computeLayout } from '../src/geometry/layout';
import { buildPlaceholderVehicle } from '../src/geometry/placeholder';

const s = specOf(findVariant('SH5043XLJH9DB-C_3116')!);
const drive = (st: DriveState, throttle: number, boost: boolean, n: number, dt = 1 / 60) => {
  for (let i = 0; i < n; i++) st = stepDrive(s, st, { throttle, steer: 0, boost }, dt);
  return st;
};
const still: DriveState = { pose: { x: 0, y: 0, yaw: 0 }, speed: 0, curvature: 0 };

describe('加速挡', () => {
  it('巡航最高速不变（5.5 m/s），加速挡达到 boostMaxForwardSpeed 且不超', () => {
    expect(drive(still, 1, false, 600).speed).toBeCloseTo(DRIVING.maxForwardSpeed, 9);
    const b = drive(still, 1, true, 600);
    expect(b.speed).toBeCloseTo(DRIVING.boostMaxForwardSpeed, 9);
    expect(DRIVING.boostMaxForwardSpeed).toBeGreaterThan(DRIVING.maxForwardSpeed);
  });
  it('松开加速挡：按滑行减速平滑回落到巡航上限，不瞬间掉速、不低于巡航上限', () => {
    const fast = drive(still, 1, true, 600);
    const one = stepDrive(s, fast, { throttle: 1, steer: 0, boost: false }, 1 / 60);
    expect(one.speed).toBeCloseTo(fast.speed - DRIVING.coastDecel / 60, 9);
    const settled = drive(fast, 1, false, 600);
    expect(settled.speed).toBeCloseTo(DRIVING.maxForwardSpeed, 9);
  });
  it('加速挡下刹车仍有效：反向油门按刹车减速度停车', () => {
    const fast = drive(still, 1, true, 600);
    const braked = drive(fast, -1, true, Math.ceil((fast.speed / DRIVING.brakeDecel) * 60) + 1);
    expect(braked.speed).toBeLessThanOrEqual(0);
    expect(braked.speed).toBeGreaterThan(-0.1);
  });
  it('倒车上限不受加速挡影响', () => {
    expect(drive(still, -1, true, 600).speed).toBeCloseTo(-DRIVING.maxReverseSpeed, 9);
  });
  it('穿透约束：加速挡最高速 × 单帧最大步长 < 最薄障碍物半厚（围栏、拦杆 1 m 厚、树半径 ≥ 1 m）', () => {
    const step = DRIVING.boostMaxForwardSpeed * FRAME_MAX_DT_S;
    const thin = Math.min(1, ...treeShapes().map((t) => (t.type === 'circle' ? t.r * 2 : Infinity)));
    expect(step).toBeLessThan(thin / 2);
  });
  it('加速挡正撞围栏（最大步长 0.05 s）：反弹且解算后不穿透', () => {
    const fence = fenceShapes()[2]; // 东墙，内侧面 x = 34
    const front = s.wheelbaseM + s.frontOverhangM;
    let st: DriveState = { pose: { x: 34 - 0.05 - front, y: 0, yaw: 0 }, speed: DRIVING.boostMaxForwardSpeed, curvature: 0 };
    let hit = false;
    for (let i = 0; i < 10; i++) {
      const r = resolveDrive(s, st, stepDrive(s, st, { throttle: 1, steer: 0, boost: true }, FRAME_MAX_DT_S), [fence]);
      st = r.state;
      hit ||= !!r.impact;
      expect(firstHit(footprint(s, st.pose), [fence])).toBeNull();
      expect(st.pose.x).toBeLessThan(34);
    }
    expect(hit).toBe(true);
  });
  it('加速挡随机乱开 10 分钟（每帧 0.05 s 最大步长）：车身任何时刻都不与玩家障碍物重叠', () => {
    const obs = playerObstacles();
    let st: DriveState = { pose: { x: -8, y: -32, yaw: Math.PI / 2 }, speed: 0, curvature: 0 };
    let impacts = 0;
    for (let i = 0; i < 10 * 60 * 20; i++) {
      const seg = Math.floor(i / 30);
      const input = { throttle: uniform(seg, 'bt') < 0.8 ? 1 : -1, steer: uniform(seg, 'bs') * 2 - 1, boost: true };
      const r = resolveDrive(s, st, stepDrive(s, st, input, FRAME_MAX_DT_S), obs);
      if (r.impact) impacts++;
      st = r.state;
      expect(firstHit(footprint(s, st.pose), obs)).toBeNull();
    }
    expect(impacts).toBeGreaterThan(10);
  });
  it('移动中的 NPC 车也不会被加速挡穿过：迎面相对速度 13 m/s 时每帧位移 < NPC 车半宽', () => {
    const minHalfW = Math.min(...ALL_VARIANTS.map((v) => v.widthM / 2));
    expect((DRIVING.boostMaxForwardSpeed + 5) * FRAME_MAX_DT_S).toBeLessThan(minHalfW);
    // 撞一辆横停的车（宽度最窄的那款）
    const npc = specOf(ALL_VARIANTS.reduce((a, b) => (a.widthM < b.widthM ? a : b)));
    const npcShape: Shape = { type: 'poly', pts: footprint(npc, { x: 20, y: -npc.wheelbaseM / 2, yaw: Math.PI / 2 }), tag: 'npc' };
    const front = s.wheelbaseM + s.frontOverhangM;
    let st: DriveState = { pose: { x: 20 - npc.widthM / 2 - 0.05 - front, y: 0, yaw: 0 }, speed: DRIVING.boostMaxForwardSpeed, curvature: 0 };
    for (let i = 0; i < 10; i++) {
      st = resolveDrive(s, st, stepDrive(s, st, { throttle: 1, steer: 0, boost: true }, FRAME_MAX_DT_S), [npcShape]).state;
      expect(penetration(footprint(s, st.pose), npcShape)).toBeNull();
      expect(st.pose.x + front).toBeLessThan(20);
    }
  });
});

describe('环路圈速基线（游戏物理仿真）', () => {
  const obs = playerObstacles();
  const cruise = simulateLaps(s, false, obs);
  const boost = simulateLaps(s, true, obs);
  it('巡航：最高速 19.8 km/h，飞驰圈与恒速理论圈时（116.55 / 5.5 = 21.19 s）相差 < 2%，全程无碰撞', () => {
    expect(loopLength()).toBeCloseTo(116.55, 2);
    expect(cruise.maxSpeed * 3.6).toBeCloseTo(19.8, 6);
    expect(Math.abs(cruise.flyingS / idealLapS(DRIVING.maxForwardSpeed) - 1)).toBeLessThan(0.02);
    expect(cruise.impacts).toBe(0);
  });
  it('加速挡：飞驰圈比巡航缩短 ≥ 25%，起步圈也更快，全程无碰撞', () => {
    expect(boost.flyingS).toBeLessThan(cruise.flyingS * 0.75);
    expect(boost.standingS).toBeLessThan(cruise.standingS);
    expect(boost.maxSpeed).toBeCloseTo(DRIVING.boostMaxForwardSpeed, 6);
    expect(boost.impacts).toBe(0);
  });
});

describe('车灯（自动）', () => {
  const base = { mode: 'driving' as const, steer: 0, speed: 3, braking: false };
  it('左打亮左、右打亮右；回正即灭', () => {
    expect(lightsFor({ ...base, steer: 1 })).toMatchObject({ left: true, right: false });
    expect(lightsFor({ ...base, steer: -1 })).toMatchObject({ left: false, right: true });
    expect(lightsFor({ ...base, steer: 0 })).toMatchObject({ left: false, right: false });
  });
  it('停稳不闪：速度 ≤ 停稳阈值时打方向也不亮', () => {
    expect(lightsFor({ ...base, steer: 1, speed: 0 })).toMatchObject({ left: false, right: false });
    expect(lightsFor({ ...base, steer: 1, speed: LIGHTS.stopSpeed })).toMatchObject({ left: false });
  });
  it('刹车灯：刹车时亮（含停稳后仍踩刹车），滑行不亮', () => {
    expect(lightsFor({ ...base, braking: true }).brake).toBe(true);
    expect(lightsFor({ ...base, speed: 0, braking: true }).brake).toBe(true);
    expect(lightsFor(base).brake).toBe(false);
    expect(manualBraking(-1, 3, false)).toBe(true);
    expect(manualBraking(1, -2, false)).toBe(true);
    expect(manualBraking(0, 3, false)).toBe(false); // 松油门滑行
    expect(manualBraking(1, 3, false)).toBe(false);
    expect(manualBraking(0, 0, true)).toBe(true); // 停着按空格
    expect(manualBraking(-1, 0, false)).toBe(false); // 停着按倒车 = 起步倒车，不是刹车
  });
  it('倒车灯：倒退时亮白灯，前进不亮', () => {
    expect(lightsFor({ ...base, speed: -1 }).reverse).toBe(true);
    expect(lightsFor(base).reverse).toBe(false);
  });
  it('停回家位：驾驶信号全部熄灭', () => {
    expect(lightsFor({ mode: 'parked', steer: 1, speed: -1, braking: true })).toEqual({ left: false, right: false, brake: false, reverse: false });
  });
  it('自动驾驶：按路径曲率亮转向灯，直线不亮', () => {
    const auto = { mode: 'auto' as const, steer: 0, speed: 6, braking: false };
    expect(lightsFor({ ...auto, curvature: 1 / 9 }).left).toBe(true);
    expect(lightsFor({ ...auto, curvature: -1 / 9 }).right).toBe(true);
    expect(lightsFor({ ...auto, curvature: 0.001 })).toMatchObject({ left: false, right: false });
  });
  it('闪烁：1.5 Hz，开启那一刻先亮，亮灭各半周期；切换方向重新计时', () => {
    expect(blinkOn(0)).toBe(true);
    expect(blinkOn(0.32)).toBe(true);
    expect(blinkOn(0.34)).toBe(false);
    expect(blinkOn(0.67)).toBe(true);
    const c = new BlinkClock();
    const L = { left: true, right: false, brake: false, reverse: false };
    const R = { left: false, right: true, brake: false, reverse: false };
    expect(c.update(L, 10)).toEqual({ left: true, right: false });
    expect(c.update(L, 10.4)).toEqual({ left: false, right: false });
    expect(c.update(R, 10.5)).toEqual({ left: false, right: true }); // 右侧从这一刻起算，先亮
    expect(c.update(R, 10.9).right).toBe(false);
  });
});

// 车灯几何、昼夜与顶点色回归见 lampFixtures.test.ts。
describe('视图切换', () => {
  it('三种可选视图（跟随 · 驾驶舱 · 俯瞰）；1–3 直选，V 循环，C 俯瞰 ↔ 跟随；环绕不再单独可选', () => {
    expect(VIEWS).toEqual(['follow', 'hood', 'overview']);
    expect(VIEW_LABEL.hood).toBe('驾驶舱');
    expect(viewForKey('Digit1', 'orbit')).toBe('follow');
    expect(viewForKey('Digit2', 'follow')).toBe('hood');
    expect(viewForKey('Digit3', 'follow')).toBe('overview');
    expect(viewForKey('Digit4', 'follow')).toBeNull();
    expect(viewForKey('KeyV', 'follow')).toBe('next');
    expect(viewForKey('KeyC', 'overview')).toBe('follow');
    expect(viewForKey('KeyC', 'hood')).toBe('overview');
    expect(viewForKey('KeyW', 'follow')).toBeNull();
  });
  it('默认跟随（用户 2026-11-27）：进入游戏与停回家位都是跟随；拖拽进入的自由环绕按 V 回到跟随', () => {
    expect(DEFAULT_VIEW).toBe('follow');
    const v = new ViewChoice();
    expect(v.effective(true)).toBe('follow');
    expect(v.effective(false)).toBe('follow');
    v.select('hood', false);
    expect(v.effective(false)).toBe('hood');
    expect(v.next(false)).toBe('overview');
    v.onParked();
    expect(v.effective(true)).toBe('follow');
    expect(v.next(true)).toBe('hood');
    v.select('orbit', true); // 拖拽画面进入自由环绕
    expect(v.effective(true)).toBe('orbit');
    expect(v.next(true)).toBe('follow');
    v.onParked();
    expect(v.effective(false)).toBe('follow');
  });
  it('从镜头当前位置起转：orbitFrom 反推的环绕参数再算回来就是原位置（跟随镜头在环绕范围内，不跳）', () => {
    const t: Target = { x: 3, y: -4, yaw: 0.7, h: 1.5 };
    const f = camFor('follow', t, orbitBehind(t.yaw), hoodMount(ALL_VARIANTS[0]));
    const o = orbitFrom(f.pos, t);
    const back = orbitCam(t, o).pos;
    for (let i = 0; i < 3; i++) expect(back[i]).toBeCloseTo(f.pos[i], 6);
    // 方位就在车后方
    expect(Math.cos(o.azimuth - (t.yaw + Math.PI))).toBeCloseTo(1, 6);
    // 俯瞰太高太远：夹到上下限，但方位不变
    const ov = camFor('overview', t, o, hoodMount(ALL_VARIANTS[0]));
    const o2 = orbitFrom(ov.pos, t);
    expect(o2.dist).toBeLessThanOrEqual(ORBIT.maxDist);
    expect(o2.pitch).toBeLessThanOrEqual(ORBIT.maxPitch);
  });
  it('切换视图只换相机，不改车的位姿与速度（camFor 是纯函数，输入不变）', () => {
    const t: Target = { x: 3, y: -4, yaw: 0.7, h: 1.5 };
    const o = orbitBehind(t.yaw);
    const snap = JSON.stringify([t, o]);
    for (const v of VIEWS) camFor(v, t, o, hoodMount(ALL_VARIANTS[0]));
    expect(JSON.stringify([t, o])).toBe(snap);
  });
});

/** three 坐标的相机位置 → 与目标的水平距离、高度 */
const t0: Target = { x: 5, y: -9, yaw: 0.3, h: 1.5 };

describe('环绕相机', () => {
  it('最近距离快速拖过半圈时，逐帧相机沿弧线移动并留在每款车的车身外', () => {
    const start: Orbit = { azimuth: 0, pitch: ORBIT.minPitch, dist: ORBIT.minDist };
    const g = new OrbitGesture();
    g.down(1, 0, 0);
    const goal = g.move(1, -Math.PI / ORBIT.radPerPx, 0, start)!;
    for (const v of ALL_VARIANTS) {
      // 以相机看向点为球心，包围盒最远的角限定了安全距离。
      const bodyRadius = Math.hypot(v.lengthM / 2, v.widthM / 2, Math.max(1, v.heightM - 1));
      let displayed = start;
      for (let frame = 1; frame <= 60; frame++) {
        const dt = 1 / 60;
        displayed = smoothOrbit(displayed, goal, dt);
        const c = orbitCam(t0, displayed);
        // scene.ts 必须直接使用已平滑的轨道坐标，二次世界坐标平滑会沿弦穿过车身。
        expect(c.rate).toBe(Infinity);
        const actual = applyShake(c.pos, c.look, c.shake, frame * dt, 1);
        expect(Math.hypot(...actual.pos.map((axis, i) => axis - c.look[i]))).toBeGreaterThan(bodyRadius + c.near);
        if (frame === 1) expect(displayed.azimuth).toBeGreaterThan(0);
        if (frame === 1) expect(displayed.azimuth).toBeLessThan(goal.azimuth);
      }
      expect(displayed.azimuth).toBeCloseTo(goal.azimuth, 3);
    }
  });
  it('跨过 ±π 时取短弧，并平滑拉远与抬高镜头', () => {
    const from: Orbit = { azimuth: Math.PI - 0.1, pitch: ORBIT.minPitch, dist: ORBIT.minDist };
    const to: Orbit = { azimuth: -Math.PI + 0.1, pitch: ORBIT.maxPitch, dist: ORBIT.maxDist };
    const mid = smoothOrbit(from, to, Math.log(2) / ORBIT.rate);
    expect(Math.abs(mid.azimuth)).toBeCloseTo(Math.PI, 10);
    expect(mid.pitch).toBeCloseTo((from.pitch + to.pitch) / 2, 10);
    expect(mid.dist).toBeCloseTo((from.dist + to.dist) / 2, 10);
  });
  it('任意方位角、俯仰、距离：看向车身中心，距离与俯仰在上下限内，相机始终在地面以上', () => {
    for (let i = 0; i < 2000; i++) {
      const o: Orbit = { azimuth: (uniform(i, 'a') - 0.5) * 40, pitch: (uniform(i, 'p') - 0.5) * 6, dist: uniform(i, 'd') * 200 - 50 };
      const c = orbitCam(t0, o);
      expect(c.look).toEqual([t0.x, 1, -t0.y]);
      const d = Math.hypot(c.pos[0] - c.look[0], c.pos[1] - c.look[1], c.pos[2] - c.look[2]);
      expect(d).toBeGreaterThanOrEqual(ORBIT.minDist - 1e-9);
      expect(d).toBeLessThanOrEqual(ORBIT.maxDist + 1e-9);
      expect(c.pos[1]).toBeGreaterThanOrEqual(ORBIT.minHeight);
      expect(c.pos[1]).toBeGreaterThan(1); // 俯仰下限 > 0：相机永远高于看向点，不会从地下往上看
    }
  });
  it('水平 360° 无死角：方位角连续转一圈，相机绕车一周，车始终在视线中心', () => {
    let o = orbitBehind(0);
    const g = new OrbitGesture();
    g.down(1, 0, 0);
    let swept = 0;
    let prevAz = o.azimuth;
    for (let x = 1; x <= 1000; x++) {
      o = g.move(1, -x, 0, o)!;
      swept += Math.atan2(Math.sin(o.azimuth - prevAz), Math.cos(o.azimuth - prevAz));
      prevAz = o.azimuth;
      expect(orbitCam(t0, o).look).toEqual([t0.x, 1, -t0.y]);
    }
    expect(swept).toBeGreaterThan(2 * Math.PI);
  });
  it('方位角世界固定：车转向时环绕相机不跟着转（旋转只动相机、不动车）', () => {
    const o = orbitBehind(0);
    const a = orbitCam({ ...t0, yaw: 0 }, o);
    const b = orbitCam({ ...t0, yaw: 2 }, o);
    expect(a.pos).toEqual(b.pos);
  });
  it('单指拖拽：横向改方位角、纵向改俯仰，距离不变；俯仰到上下限后不再变', () => {
    const g = new OrbitGesture();
    const o0 = orbitBehind(0);
    g.down(7, 100, 100);
    const o1 = g.move(7, 150, 100, o0)!;
    expect(o1.azimuth).toBeCloseTo(clampOrbit({ ...o0, azimuth: o0.azimuth - 50 * ORBIT.radPerPx }).azimuth, 9);
    expect(o1.pitch).toBe(o0.pitch);
    expect(o1.dist).toBe(o0.dist);
    const o2 = g.move(7, 150, 100000, o1)!;
    expect(o2.pitch).toBe(ORBIT.maxPitch);
    const o3 = g.move(7, 150, -100000, o2)!;
    expect(o3.pitch).toBe(ORBIT.minPitch);
  });
  it('双指：张开拉近、捏合拉远，不旋转；缩放到上下限为止；抬起一指后剩下那指不跳', () => {
    const g = new OrbitGesture();
    const o0 = orbitBehind(0);
    g.down(1, 100, 100);
    g.down(2, 200, 100); // 间距 100
    const o1 = g.move(2, 300, 100, o0)!; // 间距 200 → 距离减半
    expect(o1.dist).toBeCloseTo(o0.dist / 2, 9);
    expect(o1.azimuth).toBe(o0.azimuth);
    expect(o1.pitch).toBe(o0.pitch);
    const o2 = g.move(2, 100000, 100, o1)!;
    expect(o2.dist).toBe(ORBIT.minDist);
    const o3 = g.move(2, 110, 100, o2)!; // 间距 99900 → 10：拉远到上限
    expect(o3.dist).toBe(ORBIT.maxDist);
    g.up(2);
    const o4 = g.move(1, 100, 100, o3)!; // 剩下那指原地不动：不改角度
    expect(o4).toEqual(o3);
    expect(g.move(99, 0, 0, o3)).toBeNull(); // 不认识的指针不处理
  });
  it('滚轮缩放有上下限', () => {
    const o = orbitBehind(0);
    expect(wheelZoom(o, 1e6).dist).toBe(ORBIT.maxDist);
    expect(wheelZoom(o, -1e6).dist).toBe(ORBIT.minDist);
    expect(wheelZoom(o, 100).dist).toBeGreaterThan(o.dist);
  });
});

describe('引擎盖视角', () => {
  it.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('%s：相机在车身外（风挡前方、机盖上方），能看到机盖前沿与前方路面', (_id, v) => {
    const lay = computeLayout(v);
    const m = hoodMount(v);
    const [wbz, wby] = lay.windshield.bottom;
    const [wtz, wty] = lay.windshield.top;
    // 相机高度处风挡的 z（风挡从底边向后上方倾斜）
    const wsZAtCam = wbz + ((m.height - wby) / (wty - wby)) * (wtz - wbz);
    expect(m.height).toBeGreaterThan(wby); // 高于机盖 / 风挡底边
    expect(m.height).toBeLessThan(wty);
    expect(m.forward - wsZAtCam).toBeGreaterThan(HOOD.near); // 风挡在近裁剪面之外，不会切进车身
    expect(m.forward).toBeLessThan(lay.zFront); // 在车头之后（“车头上方略后”）
    // 机盖前沿（车头端、机盖顶面）在垂直视场内
    const pitch = (-HOOD.pitchDownDeg * Math.PI) / 180;
    const half = ((HOOD.fov / 2) * Math.PI) / 180;
    const hoodTopY = wby - 0.1;
    const edge = Math.atan2(hoodTopY - m.height, lay.zFront - m.forward);
    expect(edge).toBeGreaterThan(pitch - half);
    expect(edge).toBeLessThan(pitch + half);
    // 越过机盖前沿的视线落地点在 10 m 以内：近处路面看得到
    const groundHit = (m.height * (lay.zFront - m.forward)) / (m.height - hoodTopY);
    expect(groundHit).toBeLessThan(10);
  });
  it('世界坐标：相机在车身中心前方 forward 处、朝车头方向看、略向下；直接到位不平滑', () => {
    const v = ALL_VARIANTS[0];
    const m = hoodMount(v);
    const c = hoodCam(t0, m);
    expect(c.pos[0]).toBeCloseTo(t0.x + Math.cos(t0.yaw) * m.forward, 9);
    expect(c.pos[2]).toBeCloseTo(-(t0.y + Math.sin(t0.yaw) * m.forward), 9);
    const dir = [c.look[0] - c.pos[0], c.look[2] - c.pos[2]];
    expect(Math.atan2(-dir[1], dir[0])).toBeCloseTo(t0.yaw, 9);
    expect(c.look[1]).toBeLessThan(c.pos[1]);
    expect(c.rate).toBe(Infinity);
  });
  /** 机盖顶面在车身局部 forward 处的高度：车头 (zFront, 机盖顶) 到风挡底边的斜线（layout.ts 车身侧轮廓） */
  const hoodSurfaceY = (v: (typeof ALL_VARIANTS)[number], f: number) => {
    const lay = computeLayout(v);
    const [wbz, wby] = lay.windshield.bottom;
    const front = wby - 0.1;
    const k = Math.min(1, Math.max(0, (lay.zFront - f) / (lay.zFront - wbz)));
    return front + (wby - front) * k;
  };
  /** three 坐标 → 车身局部 forward（相对车身中心） */
  const localForward = (p: readonly number[], tg: Target) => (p[0] - tg.x) * Math.cos(tg.yaw) + (-p[2] - tg.y) * Math.sin(tg.yaw);
  it.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('%s：满强度碰撞震屏时，最终相机仍在机盖上方（只抖看向点）', (_id, v) => {
    const m = hoodMount(v);
    for (const yaw of [0, Math.PI / 2, Math.PI, -0.7]) {
      const tg = { x: 3, y: -2, yaw, h: 1 };
      const c = hoodCam(tg, m);
      expect(c.shake).toBe('look');
      for (let t = 0; t <= 5; t += 0.01) {
        const r = applyShake(c.pos, c.look, c.shake, t, 1);
        expect(r.pos).toEqual(c.pos); // 相机位置不动：仍是上面逐款验证过的车外位置
        expect(r.pos[1] - hoodSurfaceY(v, localForward(r.pos, tg))).toBeGreaterThan(HOOD.aboveHoodM - 0.1);
      }
    }
  });
  it('GPT 审核 #48 反例：首款车朝东、t = 3 s、满强度——旧做法（抖位置）相机低于机盖面，新做法不会', () => {
    const v = ALL_VARIANTS[0];
    const m = hoodMount(v);
    const tg = { x: 0, y: 0, yaw: 0, h: 1 };
    const c = hoodCam(tg, m);
    const old = applyShake(c.pos, c.look, 'pos', 3, 1); // 改动前对所有视图都抖位置
    expect(old.pos[1]).toBeLessThan(hoodSurfaceY(v, localForward(old.pos, tg)));
    const now = applyShake(c.pos, c.look, c.shake, 3, 1);
    expect(now.pos[1]).toBeGreaterThan(hoodSurfaceY(v, localForward(now.pos, tg)) + HOOD.near);
    // 看向点仍有抖动（保留碰撞反馈）：20 m 外最大 0.35 m ≈ 1°
    expect(Math.hypot(...now.look.map((x, i) => x - c.look[i]))).toBeGreaterThan(0.01);
  });
  it('其他视图仍抖位置，幅度不超过 SHAKE_MAX_M，强度 0 时不抖', () => {
    const t = { x: 0, y: 0, yaw: 0.3, h: 1 };
    for (const view of ['overview', 'follow', 'orbit'] as const) {
      const c = camFor(view, t, orbitBehind(0.3), hoodMount(ALL_VARIANTS[0]));
      expect(c.shake).toBe('pos');
      for (let s = 0; s <= 2; s += 0.05) {
        const r = applyShake(c.pos, c.look, c.shake, s, 1);
        expect(r.look).toEqual(c.look);
        for (let i = 0; i < 3; i++) expect(Math.abs(r.pos[i] - c.pos[i])).toBeLessThanOrEqual(SHAKE_MAX_M + 1e-12);
      }
      expect(applyShake(c.pos, c.look, c.shake, 1, 0)).toEqual({ pos: c.pos, look: c.look });
    }
  });
  it('scene.ts 每帧的相机经 applyShake 叠加震屏，并按 CamWant.shake 选择方式', () => {
    expect(sceneSrc).toMatch(/applyShake\(camPos.*shakeMode/);
    expect(sceneSrc).toMatch(/shakeMode = w\.shake/);
    expect(sceneSrc).not.toMatch(/camera\.position\.[xyz] \+=/);
  });
  it('跟随视图参数与改动前一致（车后 13 + h、上方 7 + h）', () => {
    const c = followCam({ x: 0, y: 0, yaw: 0, h: 2 });
    expect(c.pos).toEqual([-15, 9, -0]);
    expect(c.look).toEqual([4, 1, -0]);
  });
});

describe('车灯不影响原有车体预算', () => {
  it.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('%s：bbox 仍为公告三围', (_id, v) => {
    const { root } = buildPlaceholderVehicle(v);
    const size = new THREE.Box3().setFromObject(root).getSize(new THREE.Vector3());
    expect(Math.round(size.z * 1000)).toBe(Math.round(v.lengthM * 1000));
    expect(Math.round(size.x * 1000)).toBe(Math.round(v.widthM * 1000));
  });
});

describe('底栏窄屏布局（GPT 审核 #48）', () => {
  // 测试环境没有布局引擎，这里只锁住静态约束；真机窄屏效果待真人试玩核验（见 docs/DRIVING_VIEW.md 待核实）
  const rule = (sel: string) => {
    const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.#]/g, '\\$&')} \\{([^}]*)\\}`));
    expect(m, `style.css 缺少 ${sel} 规则`).not.toBeNull();
    return m![1];
  };
  it('底栏宽度不超过视口，放不下时换行', () => {
    const dock = rule('.dock');
    expect(dock).toMatch(/max-width:\s*calc\(100vw - \d+px\)/);
    expect(dock).toMatch(/flex-wrap:\s*wrap/);
  });
  it('指南针和菜单钮固定尺寸不撑宽底栏；驾驶控件组能换行；快捷键提示不再禁止换行', () => {
    expect(rule('#views')).toMatch(/flex:\s*none/);
    for (const sel of ['#compass', '#hub']) {
      const w = Number(rule(sel).match(/width:\s*(\d+)px/)?.[1]);
      expect(w, sel).toBeGreaterThan(0);
      expect(w, sel).toBeLessThanOrEqual(96);
    }
    expect(rule('#controls')).toMatch(/flex-wrap:\s*wrap/);
    expect(rule('.keys')).not.toMatch(/nowrap/);
  });
});

