import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS } from '../src/data/models';
import { buildPlaceholderVehicle } from '../src/geometry/placeholder';

describe.each(ALL_VARIANTS.map(v => [v.id, v] as const))('%s 前部', (_id, v) => {
  const { root } = buildPlaceholderVehicle(v);
  const half = v.widthM / 2, front = v.lengthM / 2;
  const ahead = new THREE.Vector3(0, 0, -1);
  // Intersect the assembled vehicle, not just trim: paint must not block any of these parts.
  const hitAt = (x: number, y: number) => new THREE.Raycaster(new THREE.Vector3(x, y, front + 0.1), ahead).intersectObject(root)[0];
  const colorAt = (x: number, y: number) => {
    const hit = hitAt(x, y);
    if (!hit?.face || hit.object.name !== 'trim') return null;
    const colors = (hit.object as THREE.Mesh).geometry.getAttribute('color');
    const i = hit.face.a;
    return new THREE.Color(colors.getX(i), colors.getY(i), colors.getZ(i)).getHex();
  };

  it('从前方可见宽于主格栅的下进气口和三根横条', () => {
    for (const x of [-0.45, 0.45]) {
      const backing = colorAt(x, 0.44);
      expect(backing).not.toBeNull();
      expect(backing).not.toBe(colorAt(x, 0.42));
      let bars = 0;
      let previous = backing;
      for (let y = 0.45; y < 0.70; y += 0.005) {
        const color = colorAt(x, y);
        expect(color).not.toBeNull();
        if (color !== backing && previous === backing) bars++;
        previous = color;
      }
      expect(bars).toBe(3);
      expect(previous).toBe(backing);
    }
  });

  it('下包围绕过两角，中央孔底、横条与雾灯座所在的唇面分三层', () => {
    for (const side of [-1, 1]) {
      const cheek = side * (half - 0.17), fog = side * (half - 0.30);
      expect(colorAt(cheek, 0.54)).toBe(0x292a2d);
      expect(colorAt(side * (half - 0.05), 0.54)).toBe(colorAt(cheek, 0.54)); // chamfer, not paint
      expect(colorAt(fog, 0.54)).toBe(0xbbaf92);
      expect(colorAt(fog + side * 0.08, 0.54)).toBe(0x494c4c);
      const rim = hitAt(cheek, 0.60).point.z;
      const bar = hitAt(side * 0.45, 0.565).point.z;
      const back = hitAt(side * 0.45, 0.60).point.z;
      expect(rim - bar).toBeGreaterThan(0.015);
      expect(bar - back).toBeGreaterThan(0.04);
    }
  });

  it('椭圆环与横杠在两灯之间；整条横带没有露出的车漆间隙', () => {
    expect(colorAt(0.003, 1.048)).toBe(0x292a2d); // centre of the oval
    expect(colorAt(0.105, 1.048)).toBe(0xe4dfd4); // its rim
    expect(colorAt(0.25, 1.026)).toBe(0xe4dfd4); // chrome rail outside the oval
    for (let x = -half + 0.14; x <= half - 0.14; x += 0.015) {
      const hit = hitAt(x, 1.06);
      expect(['trim', 'lamps']).toContain(hit?.object.name);
      expect(hit.point.z).toBeGreaterThan(front - 0.02);
    }
  });

  it('短斜机盖中脊高于两肩，两侧分面法线向外', () => {
    const down = new THREE.Vector3(0, -1, 0);
    const sample = (x: number, depth: number) => new THREE.Raycaster(
      new THREE.Vector3(x, 1.7, front - depth * v.frontOverhangM), down,
    ).intersectObject(root)[0];
    for (const depth of [0.19, 0.37]) {
      const crest = sample(0.002, depth);
      expect(crest.object.name).toBe('body');
      for (const side of [-1, 1]) {
        expect(crest.point.y - sample(side * half * 0.56, depth).point.y).toBeGreaterThan(0.03);
        expect(sample(side * 0.1, depth).face!.normal.x * side).toBeGreaterThan(0.06);
      }
    }
    expect(sample(0.002, 0.37).point.y).toBeGreaterThan(sample(0.002, 0.19).point.y);
  });
});
