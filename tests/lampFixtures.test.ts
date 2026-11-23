import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS } from '../src/data/models';
import { computeLayout } from '../src/geometry/layout';
import { buildPlaceholderVehicle, lampLayout, LAMP_COLORS, type LampRole, type LampState } from '../src/geometry/placeholder';
import { makeVehicle } from '../src/client/scene';
import { runningLights } from '../src/shared/runningLights';

describe('车灯几何', () => {
  it.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('%s：每片透镜在公告三围内，朝外且贴在自己的框上', (_id, v) => {
    const lay = computeLayout(v);
    const { root } = buildPlaceholderVehicle(v);
    const trim = root.getObjectByName('trim') as THREE.Mesh;
    const lamps = root.getObjectByName('lamps') as THREE.Mesh;
    expect(lamps.material).toBeInstanceOf(THREE.MeshBasicMaterial);
    const q = lampLayout(v);
    expect(lamps.geometry.userData.roles).toEqual(q.map(l => l.role));
    const half = v.widthM / 2;
    const bounds = new THREE.Box3(new THREE.Vector3(-half, 0, lay.zRear), new THREE.Vector3(half, v.heightM, lay.zFront));
    const fixtures = q.map(({ role, corners }, i) => {
      const pts = corners.map(p => new THREE.Vector3(...p));
      const center = pts.reduce((acc, p) => acc.add(p), new THREE.Vector3()).multiplyScalar(0.25);
      const normal = pts[1].clone().sub(pts[0]).cross(pts[2].clone().sub(pts[0])).normalize();
      for (const p of pts) {
        expect(bounds.containsPoint(p)).toBe(true);
        // Sample just inside each corner. The lamp and the trim behind it must face the same ray.
        const probe = p.clone().lerp(center, 0.08);
        const ray = new THREE.Raycaster(probe.clone().addScaledVector(normal, 0.025), normal.clone().negate(), 0, 0.03);
        const hits = ray.intersectObject(lamps);
        expect(hits.length).toBeGreaterThan(0);
        expect(hits.every(hit => Math.floor(hit.faceIndex! / 2) === i)).toBe(true);
        expect(ray.intersectObject(trim)[0]?.distance).toBeCloseTo(0.025, 5);
      }
      return { role, center, normal, box: new THREE.Box3().setFromPoints(pts) };
    });
    for (const side of [1, -1]) {
      const turn = side === 1 ? 'turnL' : 'turnR';
      const group = fixtures.filter(l => side * l.center.x > 0);
      const front = group.filter(l => l.normal.z > 0.99);
      const rear = group.filter(l => l.normal.z < -0.99);
      expect(front.map(l => l.role).sort()).toEqual(['head', turn]);
      expect(rear.map(l => l.role).sort()).toEqual(['brake', 'reverse', 'tail', turn]);
      for (const light of front) expect(light.center.z).toBeGreaterThan(lay.zFront - 0.02);
      for (const light of rear) expect(light.center.z).toBeLessThan(lay.zRear + 0.02);
      const marker = group.filter(l => l.role === 'marker');
      expect(marker).toHaveLength(1);
      expect(marker[0].normal.x * side).toBeGreaterThan(0.5);
      expect(marker[0].normal.z).toBeGreaterThan(0.5);
      const fender = group.filter(l => l.role === turn && l.normal.x * side > 0.99);
      expect(fender).toHaveLength(1);
      expect(fender[0].center.x * side).toBeGreaterThan(half - 0.02);
      expect(fender[0].center.z).toBeCloseTo(lay.frontAxleZ, 3);
      expect(fender[0].box.min.y).toBeGreaterThan(v.lengthM * 0.061 * 2 + 0.088);
      expect(fender[0].box.max.y).toBeLessThan(1.19 - 0.037);
      for (const [i, a] of group.entries()) {
        for (const b of group.slice(i + 1)) expect(a.box.intersectsBox(b.box)).toBe(false);
      }
    }
  });
  it('setLights → setLamps：初始熄灭，常亮灯与驾驶灯互不影响，旧调用不保留夜间状态', () => {
    const view = makeVehicle(ALL_VARIANTS[0]);
    const m = view.root.getObjectByName('lamps') as THREE.Mesh;
    const roles = m.geometry.userData.roles as LampRole[];
    const col = m.geometry.getAttribute('color');
    const check = (state: LampState) => roles.forEach((r, i) => {
      const want = new THREE.Color(LAMP_COLORS[r][state[r] ? 'on' : 'off']);
      for (let k = i * 6; k < (i + 1) * 6; k++) {
        expect(col.getX(k)).toBeCloseTo(want.r, 5);
        expect(col.getY(k)).toBeCloseTo(want.g, 5);
        expect(col.getZ(k)).toBeCloseTo(want.b, 5);
      }
    });
    check({});
    const old = { turnL: true, turnR: false, brake: true, reverse: false };
    for (const state of [old, { ...old, head: true, tail: true, marker: true }, old]) {
      view.setLights(state);
      check(state);
    }
  });
  it('上海时钟 18:00 至次日 06:00 常亮，跨过昼夜边界无需方向输入', () => {
    const dusk = Date.UTC(2026, 10, 20, 10);
    const dawn = dusk + 12 * 3600_000;
    for (const [ms, on] of [[dusk - 1, false], [dusk, true], [dawn - 1, true], [dawn, false]] as const) {
      expect(runningLights(ms)).toEqual({ head: on, tail: on, marker: on });
    }
  });
});
