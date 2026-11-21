import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import raw from '../models.json';
import { ALL_VARIANTS, CATALOG } from '../src/data/models';
import { computeLayout, PLACEHOLDER } from '../src/geometry/layout';
import { buildPlaceholderVehicle, clipPolygonY, drawCallCount, PAINT, setBodyTint, triangleCount, TRIM_COLORS } from '../src/geometry/placeholder';

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

describe.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('造型精修（#69）%s', (_id, v) => {
  const { root } = buildPlaceholderVehicle(v);
  const lay = computeLayout(v);
  const body = root.getObjectByName('body') as THREE.Mesh;
  const trim = root.getObjectByName('trim') as THREE.Mesh;
  const hex = (attr: THREE.BufferAttribute, i: number) => new THREE.Color(attr.getX(i), attr.getY(i), attr.getZ(i)).getHex();

  it('车辆基础网格仍为 4 个（body / trim / glass / hub），不新增 draw call', () => {
    expect(root.children.filter((c) => (c as THREE.Mesh).isMesh).map((c) => c.name).sort()).toEqual(['body', 'glass', 'hub', 'trim']);
  });

  it('车身两段式涂装：同时有主色与奶白顶点色；换主色只改下段，奶白不变', () => {
    const col = body.geometry.getAttribute('color') as THREE.BufferAttribute;
    expect(col).toBeTruthy();
    const before = new Set(Array.from({ length: col.count }, (_, i) => hex(col, i)));
    expect(before.has(PAINT.main)).toBe(true);
    expect(before.has(PAINT.cream)).toBe(true);
    const creamBefore = Array.from({ length: col.count }, (_, i) => hex(col, i) === PAINT.cream).filter(Boolean).length;
    setBodyTint(root, 0x7fa37a);
    const after = Array.from({ length: col.count }, (_, i) => hex(col, i));
    expect(after.includes(PAINT.main)).toBe(false);
    expect(after.includes(0x7fa37a)).toBe(true);
    expect(after.filter((h) => h === PAINT.cream).length).toBe(creamBefore);
  });

  it('主色只出现在腰线以下，奶白只在腰线以上', () => {
    const col = body.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pos = body.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (let i = 0; i < pos.count; i++) {
      const h = hex(col, i);
      if (h === PAINT.main) expect(pos.getY(i)).toBeLessThanOrEqual(PLACEHOLDER.hoodTopM + 1e-6);
      if (h === PAINT.cream) expect(pos.getY(i)).toBeGreaterThanOrEqual(PLACEHOLDER.hoodTopM - 1e-6);
    }
  });

  it('车身在每个车轴正上方挖出轮拱：轴心正上方、车身底边以上一段高度内没有车身侧壁', () => {
    const pos = body.geometry.getAttribute('position') as THREE.BufferAttribute;
    for (const z of [lay.frontAxleZ, lay.rearAxleZ]) {
      // 拱内（轮胎顶 + 2 cm 以内）不应有车身顶点
      for (let i = 0; i < pos.count; i++) {
        const dz = pos.getZ(i) - z;
        const dy = pos.getY(i) - lay.wheelRadius;
        expect(Math.hypot(dz, dy)).toBeGreaterThan(lay.wheelRadius + 0.02);
      }
    }
  });

  it('黑色件带顶点色：有大灯、尾灯色块，且灯具贴在车头 / 车尾面内（不超出公告车长）', () => {
    const col = trim.geometry.getAttribute('color') as THREE.BufferAttribute;
    const pos = trim.geometry.getAttribute('position') as THREE.BufferAttribute;
    let head = 0;
    let tail = 0;
    for (let i = 0; i < col.count; i++) {
      const h = hex(col, i);
      if (h === TRIM_COLORS.headlight) {
        head++;
        expect(pos.getZ(i)).toBeGreaterThan(v.lengthM / 2 - 0.05);
        expect(pos.getZ(i)).toBeLessThanOrEqual(v.lengthM / 2 + 1e-6);
      }
      if (h === TRIM_COLORS.taillight) {
        tail++;
        expect(pos.getZ(i)).toBeLessThan(-v.lengthM / 2 + 0.05);
        expect(pos.getZ(i)).toBeGreaterThanOrEqual(-v.lengthM / 2 - 1e-6);
      }
    }
    expect(head).toBeGreaterThan(0);
    expect(tail).toBeGreaterThan(0);
  });
});

describe('clipPolygonY', () => {
  it('按水平线裁剪矩形，上下两半面积相加 = 原面积', () => {
    const sq: Array<[number, number]> = [[0, 0], [2, 0], [2, 2], [0, 2]];
    const area = (p: Array<[number, number]>) => Math.abs(p.reduce((s, [x, y], i) => s + x * p[(i + 1) % p.length][1] - p[(i + 1) % p.length][0] * y, 0)) / 2;
    expect(area(clipPolygonY(sq, 0.5, true))).toBeCloseTo(1, 9);
    expect(area(clipPolygonY(sq, 0.5, false))).toBeCloseTo(3, 9);
  });
});
