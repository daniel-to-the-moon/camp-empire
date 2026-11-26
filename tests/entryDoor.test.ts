import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { findVariant } from '../src/data/models';
import { buildPlaceholderVehicle } from '../src/geometry/placeholder';

describe('SH5043XLJH9DB-C 右侧乘客门与窗列', () => {
  const variant = findVariant('SH5043XLJH9DB-C_3116')!;
  const { root } = buildPlaceholderVehicle(variant);
  const ray = new THREE.Raycaster();

  function surface(side: -1 | 1, y: number, z: number): string | undefined {
    ray.set(new THREE.Vector3(side * variant.widthM, y, z), new THREE.Vector3(-side, 0, 0));
    const hit = ray.intersectObject(root)[0];
    return hit && side * hit.point.x > 0 ? hit.object.name : undefined;
  }

  function runs(from: number, to: number, matches: (at: number) => boolean): [number, number][] {
    const spans: [number, number][] = [];
    let span: [number, number] | undefined;
    for (let at = from; at <= to; at += 0.005) {
      if (!matches(at)) {
        span = undefined;
      } else if (span) {
        span[1] = at;
      } else {
        span = [at, at];
        spans.push(span);
      }
    }
    return spans;
  }

  const windowRow = (side: -1 | 1) => runs(-variant.lengthM / 2, variant.lengthM / 2,
    z => surface(side, 1.88, z) === 'glass').reverse();
  const length = ([start, end]: [number, number]) => end - start;
  const center = ([start, end]: [number, number]) => (start + end) / 2;
  function windowProfile(side: -1 | 1, span: [number, number]): [number, number] {
    const profile = runs(1.32, 2.20, y => surface(side, y, center(span)) === 'glass');
    expect(profile).toHaveLength(1);
    return profile[0];
  }

  it('右侧从前到后分为驾驶窗、窄门窗、较小乘客窗和宽后窗', () => {
    const windows = windowRow(-1);
    expect(windows).toHaveLength(4);
    const [cab, door, small, rear] = windows;
    expect(length(door)).toBeLessThan(length(cab));
    expect(length(door)).toBeLessThan(length(small));
    expect(length(small)).toBeLessThan(length(rear));
    const doorProfile = windowProfile(-1, door);
    const smallSill = windowProfile(-1, small)[0];
    expect(length(doorProfile)).toBeGreaterThan(length(door));
    expect(smallSill).toBeGreaterThan(doorProfile[0]);
    expect(smallSill).toBeGreaterThan(windowProfile(-1, rear)[0]);
  });

  it('左侧驾驶窗之后分为中窗、位置较高的小窗和最宽的后窗', () => {
    const windows = windowRow(1);
    expect(windows).toHaveLength(4);
    const [, front, small, rear] = windows;
    expect(length(small)).toBeLessThan(length(front));
    expect(length(front)).toBeLessThan(length(rear));
    const smallSill = windowProfile(1, small)[0];
    expect(smallSill).toBeGreaterThan(windowProfile(1, front)[0]);
    expect(smallSill).toBeGreaterThan(windowProfile(1, rear)[0]);
  });

  it('窄门窗落在右侧门的两条贯通立边之间，门有上下框和独立把手', () => {
    const windows = windowRow(-1);
    expect(windows).toHaveLength(4);
    const [cab, door, small] = windows;
    const sill = runs(0.50, 0.62, y => surface(-1, y, center(door)) === 'trim');
    expect(sill).toHaveLength(1);
    const jambs = runs(small[1], cab[0], z => surface(-1, 0.82, z) === 'trim'
      && surface(-1, center(sill[0]), z) === 'trim');
    expect(jambs).toHaveLength(2);
    const [aft, fore] = jambs;
    expect(aft[1]).toBeLessThan(door[0]);
    expect(fore[0]).toBeGreaterThan(door[1]);

    for (const jamb of jambs) {
      for (const y of [0.65, 0.96, 1.28, 1.50, 1.88, 2.10]) {
        expect(surface(-1, y, center(jamb)), '贯通门框').toBe('trim');
      }
      expect(surface(1, 0.82, center(jamb)), '左侧对应位置').toBe('body');
    }

    for (const [bottom, top] of [[0.50, 0.62], [2.12, 2.20]]) {
      const rails = runs(bottom, top, y => [center(aft), center(door), center(fore)].every(
        z => surface(-1, y, z) === 'trim',
      ));
      expect(rails, '门框横边').toHaveLength(1);
    }
    const handles = runs(aft[1] + 0.02, fore[0] - 0.02, z => surface(-1, 1.12, z) === 'trim');
    expect(handles).toHaveLength(1);
    expect(length(handles[0])).toBeGreaterThan(0.05);
    expect(length(handles[0])).toBeLessThan(length(door));
    expect(surface(1, 1.12, center(handles[0])), '左侧对应位置的把手').toBe('body');
  });

  it('全部窗玻璃的顶点 alpha 保持可透视', () => {
    const glass = root.getObjectByName('glass') as THREE.Mesh;
    const colors = glass.geometry.getAttribute('color');
    expect(colors.itemSize).toBe(4);
    expect(colors.count).toBeGreaterThan(0);
    const alphas = Array.from({ length: colors.count }, (_, i) => colors.getW(i));
    expect(Math.min(...alphas)).toBeGreaterThan(0);
    expect(Math.max(...alphas)).toBeLessThanOrEqual(0.4 + 1e-6);
  });
});
