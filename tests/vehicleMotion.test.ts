import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS } from '../src/data/models';
import { makeVehicle, pathMotion } from '../src/client/vehicleView';
import { computeLayout } from '../src/geometry/layout';
import { vehicleGeometries, MAIN_PAINT } from '../src/geometry/vehicleBody';
import { bindSuspension, groundOffset, LEAN_LIMIT, PITCH_LIMIT, STEER_LIMIT, still, tireRadius, TIRE_WIDTH, VehicleMotion } from '../src/geometry/vehicleMotion';

it('轮转角积分有符号里程/r；冻结不推进，原地打方向不滚轮', () => {
  const m = new VehicleMotion(0.36, 3.76);
  m.step(0.1, 3.6, 0);
  expect(m.pose.spin).toBeCloseTo(1, 10);
  m.step(0.1, -1.8, 0);
  expect(m.pose.spin).toBeCloseTo(0.5, 10);
  const freeze = { ...m.pose };
  m.step(0, 5, 1);
  expect(m.pose).toEqual(freeze);
  for (const sign of [-1, 1]) {
    m.step(0.1, 0, sign);
    expect(m.pose.steer).toBeCloseTo(sign * 20 * Math.PI / 180, 10);
    expect(m.pose.spin).toBeCloseTo(0.5, 10);
    expect(m.pose.pitch).toBe(0);
    expect(m.pose.lean).toBe(0);
  }
  m.reset();
  expect(m.pose).toEqual(still);
});

it('起步抬头、制动点头，左弯向右倾；倒车的横向加速度仍为 v²κ', () => {
  const m = new VehicleMotion(0.36, 3.76);
  const frame = (speed: number, curvature: number) => {
    m.step(0.05, speed, curvature);
    expect(Math.abs(m.pose.pitch)).toBeLessThanOrEqual(PITCH_LIMIT);
    expect(Math.abs(m.pose.lean)).toBeLessThanOrEqual(LEAN_LIMIT);
  };
  frame(8, 1);
  expect(m.pose.pitch).toBeLessThan(0);
  expect(m.pose.lean).toBeGreaterThan(0);
  frame(4, 1);
  expect(m.pose.pitch).toBeGreaterThan(0);
  for (let i = 0; i < 60; i++) frame(-2.5, -1);
  expect(m.pose.lean).toBeCloseTo(-LEAN_LIMIT, 6);
  frame(0, 0);
  expect(m.pose.pitch).toBe(0);
  expect(m.pose.lean).toBe(0);
});

it('路径显示用本步里程，处理倒车、跨 ±π、让行和冻结', () => {
  const a = { x: 0, y: 0, yaw: Math.PI - 0.01 };
  const b = { x: 0.2, y: 0, yaw: -Math.PI + 0.01 };
  const m = pathMotion(a, b, 0.1);
  expect(m.speed).toBeCloseTo(-2);
  expect(m.curvature).toBeCloseTo(-0.1);
  expect(pathMotion(a, a, 0.1)).toEqual({ speed: 0, curvature: 0 });
  expect(pathMotion(a, b, 0)).toEqual({ speed: 0, curvature: 0 });
});

it('加载/换车无历史动作；灯和挂接面随簧上层，停车恢复绑定姿态，位姿根从不摇动', () => {
  const view = makeVehicle(ALL_VARIANTS[0]);
  const mesh = view.root.getObjectByName('trim') as THREE.Mesh;
  const pos = mesh.geometry.getAttribute('position');
  const rest = Array.from(pos.array);
  expect(view.pose).toEqual(still);
  view.updateMotion(0.05, 4, -0.12);
  view.setLights({ head: true });
  expect(mesh.parent!.rotation.z).toBeLessThan(0);
  expect(view.root.rotation.z).toBe(0);
  expect(view.root.getObjectByName('lamps')!.parent).toBe(mesh.parent);
  view.resetMotion();
  view.setAwning(true);
  expect(view.root.getObjectByName('upgrade_side_awning')!.parent!.parent).toBe(mesh.parent);
  expect(view.pose).toEqual(still);
  expect(Array.from(pos.array)).toEqual(rest);
});

// Clip a body triangle against a circumscribed cylinder in kingpin coordinates. A vertex
// check alone would miss a broad floor triangle passing right through the tread.
const planes: THREE.Vector3[] = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0)];
for (let i = 0; i < 32; i++) planes.push(new THREE.Vector3(0, Math.cos(i * Math.PI / 16), Math.sin(i * Math.PI / 16)));
function cutsTire(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, r: number) {
  let polygon = [a, b, c];
  for (const [i, n] of planes.entries()) {
    const limit = i < 2 ? TIRE_WIDTH / 2 : r;
    if (polygon.every(p => p.dot(n) > limit)) return false;
    if (polygon.every(p => p.dot(n) <= limit)) continue;
    const out: THREE.Vector3[] = [];
    let prev = polygon[polygon.length - 1];
    for (const next of polygon) {
      const da = prev.dot(n) - limit, db = next.dot(n) - limit;
      if ((da <= 0) !== (db <= 0)) out.push(prev.clone().lerp(next, da / (da - db)));
      if (db <= 0) out.push(next);
      prev = next;
    }
    polygon = out;
    if (!polygon.length) return false;
  }
  return true;
}

describe.each(ALL_VARIANTS.map(v => [v.id, v] as const))('%s 动态轮窝', (_id, v) => {
  const r = tireRadius(v);
  const layout = computeLayout(v);
  const g = vehicleGeometries(v, layout, MAIN_PAINT);
  const sprung = new THREE.Group();
  const apply = bindSuspension(sprung, g.wheels, g.trim, g.hub, v.widthM / 2);

  it('轮胎与毂盖是同一刚体：前轮绕主销偏转，后轮只绕轴滚动', () => {
    apply(still);
    const rest = { hub: g.hub.getAttribute('position').clone(), trim: g.trim.getAttribute('position').clone() };
    const pose = { spin: -0.87, steer: STEER_LIMIT, pitch: -PITCH_LIMIT, lean: LEAN_LIMIT };
    apply(pose);
    const x = new THREE.Vector3(1, 0, 0), y = new THREE.Vector3(0, 1, 0);
    const want = new THREE.Vector3(), actual = new THREE.Vector3();
    let error = 0;
    for (const w of g.wheels) {
      const axle = new THREE.Vector3(w.x, r, w.front ? layout.frontAxleZ : layout.rearAxleZ);
      for (const name of ['trim', 'hub'] as const) {
        const pos = g[name].getAttribute('position');
        for (let i = w[name].first; i < w[name].end; i++) {
          want.fromBufferAttribute(rest[name], i).sub(axle).applyAxisAngle(x, pose.spin);
          if (w.front) want.applyAxisAngle(y, pose.steer);
          want.add(axle).y += groundOffset(r, pose.spin);
          actual.fromBufferAttribute(pos, i).applyMatrix4(sprung.matrix);
          error = Math.max(error, actual.distanceTo(want));
        }
      }
    }
    expect(error).toBeLessThan(1e-6);
  });

  it('实网格接地 ≤ 1 mm，同轴左右同高，转向与悬挂不带跑轮心', () => {
    const pos = g.trim.getAttribute('position');
    const p = new THREE.Vector3();
    let worst = 0, width = 0;
    // 每个切面周期相同；含顶点朝下、边朝下，以及非整圈的正反相位。
    for (let i = -16; i <= 16; i++) {
      const spin = Math.PI * (2 + i / 128);
      apply({ spin, steer: STEER_LIMIT * Math.cos(i), pitch: PITCH_LIMIT, lean: -LEAN_LIMIT });
      for (const w of g.wheels) {
        let min = Infinity, max = -Infinity;
        for (let k = w.trim.first; k < w.trim.end; k++) {
          p.fromBufferAttribute(pos, k).applyMatrix4(sprung.matrix);
          min = Math.min(min, p.y);
          max = Math.max(max, p.y);
          width = Math.max(width, Math.abs(p.x));
        }
        worst = Math.max(worst, Math.abs(min), Math.abs((max + min) / 2 - (w.y + groundOffset(r, spin))));
      }
    }
    expect(worst).toBeLessThanOrEqual(0.001);
    expect(width).toBeLessThanOrEqual(v.widthM / 2);
  });

  it('双侧前胎扫掠：含正反满舵、俯仰与侧倾端点，不与实际车身、饰件或地台三角面相交', () => {
    const first = g.wheels[0].trim.first, end = g.wheels[g.wheels.length - 1].trim.end;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
    for (const steer of [-STEER_LIMIT, -STEER_LIMIT / 2, 0, STEER_LIMIT / 2, STEER_LIMIT]) {
      for (const sign of [-1, 1]) {
        const spin = sign > 0 ? 0 : Math.PI / 16;
        apply({ spin, steer, pitch: sign * PITCH_LIMIT, lean: Math.sign(steer) * LEAN_LIMIT });
        for (const w of g.wheels.filter(w => w.front)) {
          const toWheel = new THREE.Matrix4().makeRotationY(steer)
            .setPosition(w.x, w.y + groundOffset(r, spin), w.z).invert().multiply(sprung.matrix);
          for (const geo of [g.body, g.trim]) {
            const p = geo.getAttribute('position');
            for (let k = 0; k < p.count; k += 3) {
              if (geo === g.trim && k >= first && k < end) continue;
              a.fromBufferAttribute(p, k).applyMatrix4(toWheel);
              b.fromBufferAttribute(p, k + 1).applyMatrix4(toWheel);
              c.fromBufferAttribute(p, k + 2).applyMatrix4(toWheel);
              if (Math.min(a.y, b.y, c.y) > r || Math.min(a.z, b.z, c.z) > r || Math.max(a.z, b.z, c.z) < -r) continue;
              if (cutsTire(a, b, c, r)) throw new Error(`车身面 ${k / 3} 与前胎相交：x=${w.x}, steer=${steer}, pitch sign=${sign}`);
            }
          }
        }
      }
    }
  });
});
