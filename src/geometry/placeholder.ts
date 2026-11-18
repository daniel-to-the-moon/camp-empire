/**
 * 占位几何车辆生成器：按 layout.ts 的数值生成低多边形车体。
 * 每种材质合并为一个网格 → 车体 4 个 draw call（预算 ≤6，MODEL_PACKAGE 第一节第 3 条）。
 * 锚点以名为 `anchor_<name>` 的空节点挂在车辆根节点下，正式模型替换时保持同名。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Variant } from '../data/models';
import { computeLayout, PLACEHOLDER, type AnchorName } from './layout';

const TRIM_COLOR = 0x2b2b2e;

export const MATERIALS = {
  body: () => new THREE.MeshStandardMaterial({ color: 0xe9e4d8, flatShading: true, roughness: 0.7 }),
  trim: () => new THREE.MeshStandardMaterial({ color: TRIM_COLOR, flatShading: true, roughness: 0.9 }),
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

  const lamps = lampMesh(v);
  root.add(lamps);

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

/**
 * 车灯（issue #44）：原创占位色块，贴在车头 / 车尾面上的薄片。全部灯合并为一个网格、一种自发光（不受光照）材质，
 * 亮灭靠改顶点颜色 → 每车只多 1 个 draw call、16 个三角面，不加实时光源。
 * 车头朝 +z，车辆右侧为 −x、左侧为 +x（layout.ts）。
 */
export type LampRole = 'turnL' | 'turnR' | 'brake' | 'reverse';

export const LAMP_COLORS: Record<LampRole, { on: number; off: number }> = {
  turnL: { on: 0xffa21a, off: 0x5c4320 },
  turnR: { on: 0xffa21a, off: 0x5c4320 },
  brake: { on: 0xff2a1f, off: 0x5a1c1a },
  reverse: { on: 0xfdfbf2, off: 0x8a8a86 },
};

export interface LampQuad {
  role: LampRole;
  /** 薄片中心（车身局部坐标）与朝向：+1 朝车头、−1 朝车尾 */
  x: number;
  y: number;
  z: number;
  facing: 1 | -1;
  w: number;
  h: number;
}

export function lampLayout(v: Variant): LampQuad[] {
  const lay = computeLayout(v);
  const W = v.widthM;
  const P = PLACEHOLDER;
  // 车头：机盖下沿两角，在前下包围（离地 0.32–0.60 m）之上；贴在车头面上（z = 车头端，不超出公告车长）
  const fy = P.hoodTopM - 0.18;
  const fz = lay.zFront;
  // 车尾：后保险杠（0.32–0.62 m）之上，从外到内：转向（琥珀）、刹车（红）、倒车（白）；尾面在 zRear + 0.006，薄片贴在其外 3 mm
  const ry = P.bodyBottomM + 0.5;
  const rz = lay.zRear + 0.003;
  const q: LampQuad[] = [];
  for (const [sx, turn] of [
    [1, 'turnL'],
    [-1, 'turnR'],
  ] as const) {
    q.push({ role: turn, x: sx * (W / 2 - 0.2), y: fy, z: fz, facing: 1, w: 0.22, h: 0.1 });
    q.push({ role: turn, x: sx * (W / 2 - 0.12), y: ry, z: rz, facing: -1, w: 0.12, h: 0.18 });
    q.push({ role: 'brake', x: sx * (W / 2 - 0.29), y: ry, z: rz, facing: -1, w: 0.18, h: 0.18 });
    q.push({ role: 'reverse', x: sx * (W / 2 - 0.45), y: ry, z: rz, facing: -1, w: 0.1, h: 0.18 });
  }
  return q;
}

/** 每个薄片 2 个三角面、6 个顶点（非索引），顶点颜色初始为熄灭色 */
function lampMesh(v: Variant): THREE.Mesh {
  const quads = lampLayout(v);
  const pos: number[] = [];
  const col: number[] = [];
  const c = new THREE.Color();
  for (const l of quads) {
    const hw = l.w / 2;
    const hh = l.h / 2;
    // 逆时针朝外：朝 +z 时 x 从左（−x 屏幕左）到右；朝 −z 时反过来
    const s = l.facing;
    const p = (dx: number, dy: number) => pos.push(l.x + dx * s, l.y + dy, l.z);
    p(-hw, -hh);
    p(hw, -hh);
    p(hw, hh);
    p(-hw, -hh);
    p(hw, hh);
    p(-hw, hh);
    c.setHex(LAMP_COLORS[l.role].off);
    for (let i = 0; i < 6; i++) col.push(c.r, c.g, c.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.userData.roles = quads.map((q) => q.role);
  // 贴在车身面上：多边形偏移让灯片总在车身面之前，不闪烁
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const m = new THREE.Mesh(g, mat);
  m.name = 'lamps';
  return m;
}

/** 按每种灯的亮灭改顶点颜色（只在状态变化时调用即可） */
export function setLamps(root: THREE.Object3D, on: Record<LampRole, boolean>): void {
  const m = root.getObjectByName('lamps') as THREE.Mesh | undefined;
  if (!m) return;
  const roles = m.geometry.userData.roles as LampRole[];
  const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute;
  const c = new THREE.Color();
  roles.forEach((r, i) => {
    c.setHex(on[r] ? LAMP_COLORS[r].on : LAMP_COLORS[r].off);
    for (let k = 0; k < 6; k++) attr.setXYZ(i * 6 + k, c.r, c.g, c.b);
  });
  attr.needsUpdate = true;
}

/** 侧边帐（展开态）：挂在 anchor_side_awning，向车辆右侧（−x）展开。额外 1 个 draw call。 */
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

  const poleH = mountY - dropY;
  const poles = merge([
    box(0.04, poleH, 0.04, -depthM, -dropY - poleH / 2, len / 2 - 0.05),
    box(0.04, poleH, 0.04, -depthM, -dropY - poleH / 2, -len / 2 + 0.05),
    box(0.08, 0.08, len, 0, -0.04, 0), // 收纳盒
  ]);

  // 同一材质用顶点色保留橙色帐布与深色框架，双面显示帐布。
  poles.deleteAttribute('uv');
  for (const [part, hex] of [[fabric, 0xd9822b], [poles, TRIM_COLOR]] as const) {
    const color = new THREE.Color(hex);
    const colors = new Float32Array(part.attributes.position.count * 3);
    for (let i = 0; i < colors.length; i += 3) color.toArray(colors, i);
    part.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  }
  const awning = new THREE.Mesh(
    merge([fabric, poles]),
    new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide, flatShading: true }),
  );
  awning.castShadow = true;
  g.add(awning);
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
