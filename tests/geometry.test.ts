import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import specText from '../CLEANROOM_SPEC.md?raw';
import packageText from '../MODEL_PACKAGE.md?raw';
import layoutText from '../src/geometry/layout.ts?raw';
import raw from '../models.json';
import { ALL_VARIANTS, CATALOG } from '../src/data/models';
import { computeLayout, PLACEHOLDER } from '../src/geometry/layout';
import { buildPlaceholderVehicle, drawCallCount, triangleCount } from '../src/geometry/placeholder';

describe('车型数据', () => {
  it('9 款基础车型、25 个高度变体（与 models.json variant_count 一致）', () => {
    expect(CATALOG).toHaveLength(9);
    expect(ALL_VARIANTS).toHaveLength(raw.variant_count);
  });
  it('顶高标签：最低为低顶、最高为高顶、中间只显示数值', () => {
    const ns = CATALOG.find((m) => m.model === 'SH6591H4DB-NS')!;
    expect(ns.variants.map((v) => v.roofLabel)).toEqual(['低顶 2480 mm', '2525 mm', '2700 mm', '高顶 2740 mm']);
  });
});

describe.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('占位几何 %s', (_id, v) => {
  const { root, anchors } = buildPlaceholderVehicle(v);
  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const mm = (m: number) => Math.round(m * 1000);

  it('bbox 与公告三围一致（毫米取整 0 误差）', () => {
    expect(mm(size.z)).toBe(mm(v.lengthM));
    expect(mm(size.x)).toBe(mm(v.widthM));
    expect(mm(size.y)).toBe(mm(v.heightM));
  });
  it('接地：最低点 y = 0；左右对称；前后端 = ±L/2', () => {
    expect(mm(box.min.y)).toBe(0);
    expect(mm(box.min.x)).toBe(-mm(box.max.x));
    expect(box.max.z).toBeCloseTo(v.lengthM / 2, 5); // 半长可能是 .5 mm，直接比米
    expect(box.min.z).toBeCloseTo(-v.lengthM / 2, 5);
  });
  it('性能预算：draw call ≤ 6，面数 ≤ 2600', () => {
    expect(drawCallCount(root)).toBeLessThanOrEqual(6);
    expect(triangleCount(root)).toBeLessThanOrEqual(2600);
  });
  it('车身三角面朝外（有向体积 > 0，防止镜像变换翻转绕序导致外表面被剔除）', () => {
    const body = root.getObjectByName('body') as THREE.Mesh;
    const pos = body.geometry.attributes.position;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    let vol = 0;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      vol += a.dot(b.clone().cross(c)) / 6;
    }
    expect(vol).toBeGreaterThan(0);
  });
  it('锚点齐全且位于公告尺寸约定位置', () => {
    expect(Object.keys(anchors).sort()).toEqual(['bull_bar', 'rear_mount', 'roof', 'side_awning', 'snorkel', 'suspension']);
    expect(anchors.roof.position.y).toBeCloseTo(v.heightM, 6);
    expect(Math.abs(anchors.side_awning.position.x)).toBeCloseTo(v.widthM / 2, 6);
    const lay = computeLayout(v);
    expect(lay.frontAxleZ - lay.rearAxleZ).toBeCloseTo(v.wheelbaseM, 6);
  });
});

describe('涉水喉符号（规格字面 +W/2 与代码 −x，未改锚点）', () => {
  const specLine = specText.split('\n').find((line) => line.includes('涉水喉'));
  const packageLine = packageText.split('\n').find((line) => line.includes('涉水喉'));
  const layout = layoutText;

  it('规格把「右前翼子板」和 x=+W/2 写在同一句；代码按右手系把右侧放在 −x', () => {
    expect(specLine).toContain('右前翼子板');
    expect(specLine).toContain('x = +W/2');
    expect(packageLine).toContain('右前翼子板');
    expect(packageLine).toContain('x = +W/2');
    expect(layout).toContain('车辆右侧为 −x');
    expect(layout).toContain('snorkel: { x: -W / 2');
  });

  it('现状锁在 −x：与侧边帐同一侧，高度在机盖，z 在车头半边。符号冲突等维护者定', () => {
    for (const variant of ALL_VARIANTS) {
      const lay = computeLayout(variant);
      expect(lay.anchors.snorkel.x).toBeCloseTo(-variant.widthM / 2, 6);
      expect(lay.anchors.snorkel.x).toBeCloseTo(lay.anchors.side_awning.x, 6);
      expect(lay.anchors.snorkel.y).toBeCloseTo(PLACEHOLDER.hoodTopM, 6);
      expect(lay.anchors.snorkel.z).toBeGreaterThan(0);
      expect(lay.anchors.snorkel.z).toBeLessThan(lay.zFront);
    }
  });
});
