import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import specText from '../CLEANROOM_SPEC.md?raw';
import packageText from '../MODEL_PACKAGE.md?raw';
import layoutText from '../src/geometry/layout.ts?raw';
import raw from '../models.json';
import { makeVehicle } from '../src/client/scene';
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

function bodyPaint(root: THREE.Group) {
  const body = root.getObjectByName('body') as THREE.Mesh<THREE.BufferGeometry, THREE.MeshStandardMaterial>;
  const positions = body.geometry.getAttribute('position');
  const colors = body.geometry.getAttribute('color');
  expect(body.material.vertexColors).toBe(true);
  expect(colors).toBeDefined();
  expect(colors.count).toBe(positions.count);

  const rgb = new THREE.Color();
  const paint = Array.from({ length: colors.count }, (_, index) =>
    rgb.setRGB(colors.getX(index), colors.getY(index), colors.getZ(index)).getHex(),
  );
  return { body, positions, paint };
}

it('车身使用两段顶点色，tint 只替换下半部主色', () => {
  const variant = ALL_VARIANTS[0];
  const tint = 0x7a4bc7;
  const base = bodyPaint(makeVehicle(variant).root);
  const recolored = bodyPaint(makeVehicle(variant, tint).root);
  const roofIndex = base.paint.findIndex((_, index) => base.positions.getY(index) >= variant.heightM - 0.001);
  expect(roofIndex).toBeGreaterThanOrEqual(0);

  const cream = base.paint[roofIndex];
  const baseColors = new Set(base.paint);
  expect(baseColors.size).toBe(2);
  expect(baseColors.has(tint)).toBe(false);
  expect(recolored.body.material.color).toEqual(base.body.material.color);
  expect(recolored.paint).toEqual(base.paint.map((color) => color === cream ? cream : tint));
});

function hasSolidSection(mesh: THREE.Mesh, start: THREE.Vector3, end: THREE.Vector3): boolean {
  const direction = end.clone().sub(start);
  const length = direction.length();
  direction.normalize();
  const approach = 2;
  const far = approach + length;
  const ray = new THREE.Raycaster(start.clone().addScaledVector(direction, -approach), direction, 0, far);
  let solidCount = 0;
  let previous = approach;
  for (const hit of ray.intersectObject(mesh)) {
    if (solidCount <= 0 && hit.distance - Math.max(previous, approach) > 0.001) return false;
    // Each front-facing hit enters a solid and each back-facing hit exits it.
    solidCount -= Math.sign(hit.face!.normal.dot(direction));
    previous = hit.distance;
  }
  return solidCount > 0 || far - Math.max(previous, approach) <= 0.001;
}

describe.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('驾驶室 %s', (_id, v) => {
  const { root } = buildPlaceholderVehicle(v);
  const trim = root.getObjectByName('trim') as THREE.Mesh;
  const section = new THREE.Mesh(trim.geometry, new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
  const glass = root.getObjectByName('glass') as THREE.Mesh;
  const positions = glass.geometry.getAttribute('position');
  const normals = glass.geometry.getAttribute('normal');
  const halfWidth = v.widthM / 2;
  const down = new THREE.Vector3(0, -1, 0);
  const glassBase = new THREE.Vector3(0, 0, -Infinity);
  for (let index = 0; index < positions.count; index++) {
    if (normals.getZ(index) > 0.5 && positions.getZ(index) > glassBase.z) {
      glassBase.fromBufferAttribute(positions, index);
    }
  }

  it('仪表台从风挡后方覆盖驾驶室左右两端', () => {
    const ray = new THREE.Raycaster();
    const z = glassBase.z - 0.17;
    for (const fraction of [-0.88, -0.44, 0, 0.44, 0.88]) {
      ray.set(new THREE.Vector3(fraction * halfWidth, glassBase.y + 0.24, z), down);
      const top = ray.intersectObject(trim)[0]?.point.y ?? -Infinity;
      expect(top, `x / 半车宽 = ${fraction}`).toBeGreaterThan(glassBase.y + 0.02);
    }
  });

  it('方向盘轮毂沿斜置转向柱与仪表台连为一体', () => {
    const x = halfWidth * 0.47 + 0.008;
    // Probe into the hub and dash beyond the ends of the column itself.
    const wheelHub = new THREE.Vector3(x, 1.592, glassBase.z - 0.691);
    const dash = new THREE.Vector3(x, 1.285, glassBase.z - 0.343);
    expect(hasSolidSection(section, wheelHub, dash)).toBe(true);
  });

  it('左舵仪表舱从台面升起，中央面板从两座之间的地台接到台面以上', () => {
    const z = glassBase.z - 0.322;
    const topAt = (x: number) => new THREE.Raycaster(new THREE.Vector3(x, 1.68, z), down).intersectObject(trim)[0].point.y;
    const base = topAt(-halfWidth * 0.47);
    const cowl = topAt(halfWidth * 0.47);
    expect(cowl - base).toBeGreaterThan(0.04);
    expect(cowl - base).toBeLessThan(0.10);
    expect(topAt(0)).toBeGreaterThan(base);
    const foot = new THREE.Vector3(0.023, 0.45, glassBase.z - 0.55);
    expect(hasSolidSection(section, foot, new THREE.Vector3(foot.x, 1.51, foot.z))).toBe(true);
  });

  it('左右座椅通过底座与驾驶室地板相接', () => {
    const z = glassBase.z - 0.75;
    // Sample the exposed deck between the new centre stack and the seat rails.
    const floorRay = new THREE.Raycaster(new THREE.Vector3(0.20, 0.7, z), down);
    const floorTop = floorRay.intersectObject(trim)[0]?.point.y ?? -Infinity;
    expect(floorTop).toBeCloseTo(0.47, 4);
    const underside = new THREE.Raycaster(new THREE.Vector3(0.20, 0.31, z), down.clone().negate());
    expect(underside.intersectObject(trim)[0].point.y).toBeCloseTo(0.4, 5);
    for (const side of [-1, 1]) {
      const x = side * (halfWidth * 0.47 + 0.135);
      const deck = new THREE.Vector3(x, floorTop - 0.015, z);
      const cushion = new THREE.Vector3(x, 0.825, z);
      expect(hasSolidSection(section, deck, cushion), side > 0 ? '左侧座椅' : '右侧座椅').toBe(true);
    }
  });
});

describe.each(ALL_VARIANTS.map((v) => [v.id, v] as const))('占位几何 %s', (_id, v) => {
  const { root, anchors } = buildPlaceholderVehicle(v);
  const layout = computeLayout(v);
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
  it('整车只包含车身、饰件、玻璃、轮毂与车灯五个网格，面数 ≤ 2472', () => {
    const meshes: string[] = [];
    root.traverse((object) => {
      if (object instanceof THREE.Mesh) meshes.push(object.name);
    });
    expect(meshes.sort()).toEqual(['body', 'glass', 'hub', 'lamps', 'trim']);
    expect(triangleCount(root)).toBeLessThanOrEqual(2472);
  });
  it('每个车轮正上方都有可见的圆拱边，并且饰件在公告尺寸内', () => {
    const hub = root.getObjectByName('hub') as THREE.Mesh;
    const trim = root.getObjectByName('trim') as THREE.Mesh;
    const hubPositions = hub.geometry.getAttribute('position');
    const zMid = (layout.frontAxleZ + layout.rearAxleZ) / 2;
    const epsilon = 1e-6;
    const halfWidth = v.widthM / 2;
    const halfLength = v.lengthM / 2;
    const allowed = new THREE.Box3(
      new THREE.Vector3(-halfWidth, 0, -halfLength),
      new THREE.Vector3(halfWidth, v.heightM, halfLength),
    ).expandByScalar(epsilon);
    expect(allowed.containsBox(new THREE.Box3().setFromObject(trim))).toBe(true);

    const ray = new THREE.Raycaster();
    const position = new THREE.Vector3();
    root.updateMatrixWorld(true);
    for (const side of [-1, 1]) {
      const direction = new THREE.Vector3(-side, 0, 0);
      for (const front of [false, true]) {
        const wheel = `${side > 0 ? '左' : '右'}${front ? '前' : '后'}轮`;
        const hubBox = new THREE.Box3();
        for (let index = 0; index < hubPositions.count; index += 1) {
          position.fromBufferAttribute(hubPositions, index);
          if (side * position.x > 0 && (position.z > zMid) === front) hubBox.expandByPoint(position);
        }
        expect(hubBox.isEmpty(), wheel).toBe(false);
        const center = hubBox.getCenter(new THREE.Vector3());
        const tireTop = center.y * 2; // 接地轮胎关于轮心上下对称
        const shoulderOffset = center.y * 0.65;
        const archHeight = (z: number) => {
          for (let y = tireTop + 0.15; y > center.y; y -= 0.005) {
            position.set(side * (halfWidth + 0.1), y, z);
            ray.set(position, direction);
            if (ray.intersectObject(trim, false).some((hit) => side * hit.point.x >= side * center.x - 0.08)) {
              return y;
            }
          }
          return -Infinity;
        };

        const crown = archHeight(center.z);
        expect(crown, wheel).toBeGreaterThan(tireTop + 0.01);
        for (const offset of [-shoulderOffset, shoulderOffset]) {
          const shoulder = archHeight(center.z + offset);
          expect(shoulder, wheel).toBeGreaterThan(center.y);
          expect(shoulder, wheel).toBeLessThan(crown - 0.025);
        }
      }
    }
  });
  it('车灯点亮且侧边帐展开时，整车仍在性能预算内', () => {
    const vehicle = makeVehicle(v);
    vehicle.setLights({ turnL: true, turnR: true, brake: true, reverse: true, head: true, tail: true, marker: true });
    vehicle.setAwning(true);

    expect(drawCallCount(vehicle.root)).toBe(6);
    expect(triangleCount(vehicle.root)).toBeLessThanOrEqual(2510);
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
    expect(layout.frontAxleZ - layout.rearAxleZ).toBeCloseTo(v.wheelbaseM, 6);
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
