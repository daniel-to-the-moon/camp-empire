import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ALL_VARIANTS, findVariant } from '../src/data/models';
import { buildPlaceholderVehicle } from '../src/geometry/placeholder';

describe('SH5043 眉檐窗', () => {
  const v = findVariant('SH5043XLJH9DB-C_3116')!;
  const { root } = buildPlaceholderVehicle(v);
  const glass = root.getObjectByName('glass') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  const pos = glass.geometry.getAttribute('position');
  const ray = (origin: THREE.Vector3, direction: THREE.Vector3) =>
    new THREE.Raycaster(origin, direction).intersectObject(root);

  it('上层玻璃都位于前伸段，左右窗贴本侧斜壁，天窗贴平顶', () => {
    const windTopZ = v.lengthM / 2 - 0.68 * v.frontOverhangM - 0.69;
    const planes = new Set<string>();
    for (let i = 0; i < pos.count; i++) {
      const p = new THREE.Vector3().fromBufferAttribute(pos, i);
      if (p.y < 2.20) continue; // 驾驶室及乘客窗
      expect(p.z).toBeGreaterThan(windTopZ);
      if (Math.abs(p.y - v.heightM) < 1e-5) {
        planes.add('roof');
        expect(Math.abs(p.x)).toBeLessThan(v.widthM / 2 - 0.181);
        expect(p.z).toBeLessThan(windTopZ + 0.69 + 0.17 - 0.14 - 0.12); // 顶板切角之前
      } else {
        const side = Math.sign(p.x);
        planes.add(side > 0 ? 'left' : 'right');
        expect(p.y).toBeGreaterThan(2.47); // 唇边与上檐之间
        expect(p.y).toBeLessThan(v.heightM - 0.105);
        // 用同高度窗后方未裁过的钣金做基准，而不是只检查玻璃没超整车 bbox。
        const hit = ray(new THREE.Vector3(side * 2, p.y, windTopZ - 0.1), new THREE.Vector3(-side, 0, 0))[0];
        expect(hit.object.name).toBe('body');
        expect(p.x).toBeCloseTo(hit.point.x, 5);
        expect(p.z).toBeLessThan(windTopZ + 0.69 + 0.17 - 0.155);
      }
    }
    expect([...planes].sort()).toEqual(['left', 'right', 'roof']);
  });

  it.each(['left', 'right', 'roof'] as const)('%s 的开口只有一扇，窗框两端接车漆', (plane) => {
    const side = plane === 'left' ? 1 : -1;
    const sequence: string[] = [];
    for (let z = 1.50; z < 2.31; z += 0.01) {
      const hits = plane === 'roof'
        ? ray(new THREE.Vector3(0.037, 4, z), new THREE.Vector3(0, -1, 0))
        : ray(new THREE.Vector3(side * 2, 2.74, z), new THREE.Vector3(-side, 0, 0));
      const first = hits[0];
      const name = first.object.name;
      if (sequence.at(-1) !== name) sequence.push(name);
    }
    expect(sequence).toEqual(['body', 'trim', 'glass', 'trim', 'body']);
  });

  it('眉檐侧窗与天窗透入内部，双面玻璃仍只用一个渲染通道', () => {
    expect(glass.material.transparent).toBe(true);
    expect(glass.material.depthWrite).toBe(false);
    expect(glass.material.side).toBe(THREE.DoubleSide);
    expect(glass.material.forceSinglePass).toBe(true);

    const fromSide = ray(new THREE.Vector3(2, 2.74, 1.95), new THREE.Vector3(-1, 0, 0));
    const fromRoof = ray(new THREE.Vector3(0.037, 4, 1.95), new THREE.Vector3(0, -1, 0));
    expect(fromSide[0].object).toBe(glass);
    expect(fromSide.some(hit => hit.object === glass && hit.point.x < -1)).toBe(true);
    expect(fromRoof[0].object).toBe(glass);
    for (const hits of [fromSide, fromRoof]) {
      expect(hits.some(hit => hit.object !== glass && hit.distance - hits[0].distance < 0.12)).toBe(false);
    }

    const colors = glass.geometry.getAttribute('color');
    expect(colors.itemSize).toBe(4);
    for (let i = 0; i < colors.count; i++) {
      if (pos.getY(i) > 2.20) expect(colors.getW(i)).toBe(0.25);
    }
  });

  it('front34 和 side 机位到近侧窗中心的视线不被眉檐遮挡', () => {
    for (const eye of [new THREE.Vector3(-5.5, 2.6, 7), new THREE.Vector3(9, 2.6, 0)]) {
      const target = new THREE.Vector3(Math.sign(eye.x) * 1.12, 2.74, 1.95);
      const first = ray(eye, target.clone().sub(eye).normalize())[0];
      expect(first.object).toBe(glass);
      expect(first.point.distanceTo(target)).toBeLessThan(0.02);
    }
  });
});

it.each(ALL_VARIANTS.filter(v => v.model !== 'SH5043XLJH9DB-C').map(v => [v.id, v] as const))(
  '%s 无眉檐：所有玻璃仍在原窗带内', (_id, v) => {
    const glass = buildPlaceholderVehicle(v).root.getObjectByName('glass')!;
    expect(new THREE.Box3().setFromObject(glass).max.y).toBeLessThan(v.heightM - 0.21);
  },
);
