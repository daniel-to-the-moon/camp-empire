/**
 * 占位几何车辆生成器：按 layout.ts 的数值生成低多边形车体。
 * 每种材质合并为一个网格 → 车体 4 个 draw call（预算 ≤6，MODEL_PACKAGE 第一节第 3 条）。
 * 锚点以名为 `anchor_<name>` 的空节点挂在车辆根节点下，正式模型替换时保持同名。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Variant } from '../data/models';
import { computeLayout, PLACEHOLDER, type AnchorName } from './layout';

export const MATERIALS = {
  body: () => new THREE.MeshStandardMaterial({ color: 0xe9e4d8, flatShading: true, roughness: 0.7 }),
  trim: () => new THREE.MeshStandardMaterial({ color: 0x2b2b2e, flatShading: true, roughness: 0.9 }),
  glass: () =>
    new THREE.MeshStandardMaterial({
      color: 0x223344,
      transparent: true,
      opacity: 0.4,
      roughness: 0.1,
      depthWrite: false,
    }),
  hub: () => new THREE.MeshStandardMaterial({ color: 0xc9ccd1, flatShading: true, roughness: 0.5 }),
};

const box = (w: number, h: number, d: number, x: number, y: number, z: number) =>
  new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  if (!g) throw new Error('mergeGeometries failed');
  g.computeVertexNormals();
  return g;
}

/** 车身：侧视轮廓沿 x 挤出（宽度留 1 cm 给侧窗玻璃，使整车最外沿正好 = 公告车宽） */
function bodyGeometry(v: Variant, profile: Array<[number, number]>): THREE.BufferGeometry {
  // Shape 在 (u, v) 平面：u = z, v = y；挤出方向 +w。之后旋转到 x 方向。
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const depth = v.widthM - 0.01;
  const g = new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false });
  // 绕 y 轴转 −90°：形状 u → z，v → y，挤出轴 +z → −x。
  // 必须用旋转而不是交换坐标轴的矩阵：后者行列式为 −1（镜像），会把三角面绕序翻过来，外表面被背面剔除。
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  g.clearGroups();
  return g.index ? g.toNonIndexed() : g;
}

export interface VehicleBuild {
  root: THREE.Group;
  anchors: Record<AnchorName, THREE.Object3D>;
}

export function buildPlaceholderVehicle(v: Variant): VehicleBuild {
  const lay = computeLayout(v);
  const P = PLACEHOLDER;
  const W = v.widthM;
  const glassT = 0.008;
  const glassX = W / 2 - glassT / 2; // 外沿正好 W/2

  // ---- 车身 ----
  const body = merge([bodyGeometry(v, lay.profile)]);

  // ---- 黑色件：轮胎、下裙边、前后保险杠、后视镜 ----
  const trimParts: THREE.BufferGeometry[] = [];
  const hubParts: THREE.BufferGeometry[] = [];
  // 低多边形轮胎是多边形而非正圆：把轮心抬到“最低顶点正好触地”的高度，保证接地点 y = 0
  const tireProto = new THREE.CylinderGeometry(lay.wheelRadius, lay.wheelRadius, P.wheelWidthM, 14)
    .rotateX(Math.PI / 2)
    .rotateY(Math.PI / 2);
  tireProto.computeBoundingBox();
  const axleY = -tireProto.boundingBox!.min.y;
  for (const z of [lay.frontAxleZ, lay.rearAxleZ]) {
    for (const sx of [-1, 1]) {
      const tire = tireProto.clone().translate(sx * lay.wheelCenterX, axleY, z);
      trimParts.push(tire.toNonIndexed());
      const hub = new THREE.CylinderGeometry(lay.wheelRadius * 0.55, lay.wheelRadius * 0.55, 0.02, 10)
        .rotateX(Math.PI / 2)
        .rotateY(Math.PI / 2)
        .translate(sx * (lay.wheelCenterX + P.wheelWidthM / 2 + 0.005), axleY, z);
      hubParts.push(hub.toNonIndexed());
    }
  }
  const bodyW = W - 0.01;
  trimParts.push(box(bodyW, 0.28, 0.12, 0, P.bodyBottomM + 0.14, lay.zFront - 0.06)); // 前下包围
  trimParts.push(box(bodyW, 0.3, 0.1, 0, P.bodyBottomM + 0.15, lay.zRear + 0.05)); // 后保险杠
  trimParts.push(box(bodyW + 0.004, 0.12, v.lengthM - 0.3, 0, P.bodyBottomM + 0.06, 0)); // 下裙边
  // 后视镜：贴门外侧，尖端不超过包围盒宽度；位于 A 柱底端
  const mirrorZ = lay.windshield.bottom[0] - 0.05;
  const mirrorY = P.hoodTopM + 0.35;
  for (const sx of [-1, 1]) trimParts.push(box(0.04, 0.22, 0.14, sx * (W / 2 - 0.02), mirrorY, mirrorZ));
  const trim = merge(trimParts);

  // ---- 玻璃：前风挡 + 驾驶窗 + 乘客窗带 + 后窗 ----
  const glassParts: THREE.BufferGeometry[] = [];
  const [wbz, wby] = lay.windshield.bottom;
  const [wtz, wty] = lay.windshield.top;
  const wsLen = Math.hypot(wbz - wtz, wty - wby);
  const wsAngle = -Math.atan2(wbz - wtz, wty - wby); // 顶端后倾（朝 −z）
  glassParts.push(
    new THREE.BoxGeometry(bodyW - 0.16, wsLen - 0.08, 0.01)
      .rotateX(wsAngle)
      .translate(0, (wby + wty) / 2, (wbz + wtz) / 2 + 0.006)
      .toNonIndexed(),
  );
  const winBottom = P.hoodTopM + 0.18;
  const winTop = Math.min(lay.cabRoofY, v.heightM) - 0.22;
  const drvLen = 0.7;
  const drvZ = wbz - 0.08 - drvLen / 2;
  const paxStart = lay.slidingDoor.zStart - 0.1;
  const paxEnd = lay.zRear + 0.35;
  const paxMid = (paxStart + paxEnd) / 2;
  for (const sx of [-1, 1]) {
    glassParts.push(box(glassT, winTop - winBottom, drvLen, sx * glassX, (winTop + winBottom) / 2, drvZ));
    glassParts.push(box(glassT, winTop - winBottom, paxStart - paxMid - 0.08, sx * glassX, (winTop + winBottom) / 2, (paxStart + paxMid) / 2));
    glassParts.push(box(glassT, winTop - winBottom, paxMid - paxEnd - 0.08, sx * glassX, (winTop + winBottom) / 2, (paxMid + paxEnd) / 2));
  }
  glassParts.push(box(bodyW - 0.4, (v.heightM - winBottom) * 0.35, glassT, 0, v.heightM - 0.45, lay.zRear + glassT / 2));
  const glass = merge(glassParts);

  const hub = merge(hubParts);

  const root = new THREE.Group();
  root.name = `vehicle_${v.id}`;
  const meshes: Array<[string, THREE.BufferGeometry, THREE.Material]> = [
    ['body', body, MATERIALS.body()],
    ['trim', trim, MATERIALS.trim()],
    ['glass', glass, MATERIALS.glass()],
    ['hub', hub, MATERIALS.hub()],
  ];
  for (const [name, g, mat] of meshes) {
    const mesh = new THREE.Mesh(g, mat);
    mesh.name = name;
    mesh.castShadow = name !== 'glass';
    mesh.receiveShadow = true;
    root.add(mesh);
  }

  const anchors = {} as Record<AnchorName, THREE.Object3D>;
  for (const [name, p] of Object.entries(lay.anchors) as Array<[AnchorName, { x: number; y: number; z: number }]>) {
    const o = new THREE.Object3D();
    o.name = `anchor_${name}`;
    o.position.set(p.x, p.y, p.z);
    root.add(o);
    anchors[name] = o;
  }
  return { root, anchors };
}

/** 侧边帐（展开态）：挂在 anchor_side_awning，向车辆右侧（−x）展开。额外 2 个 draw call。 */
export function buildSideAwning(v: Variant, depthM: number): THREE.Group {
  const lay = computeLayout(v);
  const len = lay.slidingDoor.zStart - lay.slidingDoor.zEnd;
  const mountY = lay.anchors.side_awning.y;
  const dropY = 0.35; // 外沿下垂，排水坡度：占位
  const g = new THREE.Group();
  g.name = 'upgrade_side_awning';

  const fabric = new THREE.BufferGeometry();
  // 帐面：从安装点 (x=0) 斜向外 (x=-depth)，局部坐标原点 = 锚点
  const verts = new Float32Array([
    0, 0, len / 2, -depthM, -dropY, len / 2, -depthM, -dropY, -len / 2,
    0, 0, len / 2, -depthM, -dropY, -len / 2, 0, 0, -len / 2,
  ]);
  fabric.setAttribute('position', new THREE.BufferAttribute(verts, 3));
  fabric.computeVertexNormals();
  const fabricMesh = new THREE.Mesh(
    fabric,
    new THREE.MeshStandardMaterial({ color: 0xd9822b, side: THREE.DoubleSide, flatShading: true }),
  );
  fabricMesh.name = 'awning_fabric';
  fabricMesh.castShadow = true;

  const poleH = mountY - dropY;
  const poles = merge([
    box(0.04, poleH, 0.04, -depthM, -dropY - poleH / 2, len / 2 - 0.05),
    box(0.04, poleH, 0.04, -depthM, -dropY - poleH / 2, -len / 2 + 0.05),
    box(0.08, 0.08, len, 0, -0.04, 0), // 收纳盒
  ]);
  const poleMesh = new THREE.Mesh(poles, MATERIALS.trim());
  poleMesh.name = 'awning_frame';
  g.add(fabricMesh, poleMesh);
  return g;
}

export function triangleCount(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) {
      const g = m.geometry;
      n += (g.index ? g.index.count : g.attributes.position.count) / 3;
    }
  });
  return n;
}

export function drawCallCount(obj: THREE.Object3D): number {
  let n = 0;
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) n += 1;
  });
  return n;
}
