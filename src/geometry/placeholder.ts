/**
 * 占位几何车辆生成器：按 layout.ts 的数值生成低多边形车体。
 * 每种材质合并为一个网格 → 车体 4 个 draw call（预算 ≤6，MODEL_PACKAGE 第一节第 3 条）。
 * 锚点以名为 `anchor_<name>` 的空节点挂在车辆根节点下，正式模型替换时保持同名。
 *
 * 造型精修（#69）：只按 CLEANROOM_SPEC 第五节的文字特征 + models.json 三围构造，没有打开第八节禁入文件，
 * 也不引入外部模型或贴图。分色、灯具外形、窗框都用顶点色画在已有网格里，不新增网格：
 * - 车身按腰线切成上下两段分别挤出，下段主色、上段奶白；两段各自倒一刀切角，接缝处自然形成一道腰线凹槽；
 * - 车身侧轮廓在每个车轴上方挖出圆形轮拱，让车轮露出来，拱边是黑色；
 * - 黑色件网格（trim）带顶点色：轮胎、拱边、裙边、格栅、窗框为深色，大灯、尾灯、牌照为浅色 / 红色色块（静态，不发光，
 *   车灯亮灭由 #44 另做）。
 */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Variant } from '../data/models';
import { computeLayout, PLACEHOLDER, type AnchorName } from './layout';

/** 车身两段式涂装（提案值，#69）：主色在腰线以下，奶白在腰线以上 */
export const PAINT = {
  main: 0x6a9fc6,
  cream: 0xf1e9d8,
} as const;

/** 黑色件网格上的顶点色（提案值） */
export const TRIM_COLORS = {
  dark: 0x2b2b2e,
  tire: 0x232326,
  headlight: 0xfff1c2,
  taillight: 0xc8423a,
  plate: 0xe6e1d4,
  bar: 0x9aa0a8,
  /** 窗框衬板：深蓝灰，半透明玻璃叠在上面读作车窗 */
  window: 0x2c3742,
} as const;

/** 腰线高度 = 机盖高度（占位）：车头面、侧围下段为主色，风挡及以上为奶白 */
const beltY = () => PLACEHOLDER.hoodTopM;
/** 车身棱边切角：侧向宽度 / 进深（占位） */
const CHAMFER = { side: 0.05, depth: 0.05 } as const;
/** 车身前后面相对公告车长内缩，给贴在车头 / 车尾面上的灯、格栅、牌照留厚度（这些件的外表面正好 = ±L/2） */
const FACE_INSET = 0.012;
/** 车身侧围相对公告车宽内缩（每侧），给窗框留厚度；最外沿由侧窗玻璃与后视镜给出 = W/2 */
const SIDE_INSET = 0.012;
/** 轮拱半径 = 轮胎半径 + 间隙（占位） */
const ARCH_GAP = 0.07;
const ARCH_RIM = 0.05;
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

/** 多边形（z, y）按水平线 y = cut 裁剪：keepBelow = true 保留下方（Sutherland–Hodgman，单条边界） */
export function clipPolygonY(poly: Array<[number, number]>, cut: number, keepBelow: boolean): Array<[number, number]> {
  const inside = (p: [number, number]) => (keepBelow ? p[1] <= cut : p[1] >= cut);
  const out: Array<[number, number]> = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const ia = inside(a);
    const ib = inside(b);
    if (ia) out.push(a);
    if (ia !== ib) {
      const t = (cut - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, cut]);
    }
  }
  // 去掉相邻重合点（顶点正好在裁剪线上时会重复）
  return out.filter((p, i) => {
    const q = out[(i + 1) % out.length];
    return Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4;
  });
}

/** 车身轮廓：在底边上为每个车轴挖出圆形轮拱（从车尾往车头走，逆时针不变） */
function archedProfile(
  profile: Array<[number, number]>,
  axles: number[],
  axleY: number,
  archR: number,
  yB: number,
  zFrontBody: number,
): Array<[number, number]> {
  const [rear, , ...rest] = profile; // profile[0] = 后下角，profile[1] = 前下角
  const bottom: Array<[number, number]> = [rear];
  const dy = yB - axleY;
  const theta = Math.asin(Math.max(-1, Math.min(1, dy / archR)));
  const seg = 9;
  for (const z of [...axles].sort((a, b) => a - b)) {
    for (let i = 0; i <= seg; i++) {
      const a = Math.PI - theta - ((Math.PI - 2 * theta) * i) / seg;
      bottom.push([z + archR * Math.cos(a), axleY + archR * Math.sin(a)]);
    }
  }
  bottom.push([zFrontBody, yB]);
  return [...bottom, ...rest];
}

/**
 * 车身一段：轮廓沿 x 挤出并倒切角。切角用 bevelOffset = −bevelSize：侧壁正好落在原轮廓上，
 * 两端盖面内缩，所以长、高不超出轮廓，宽 = depth + 2×bevelThickness。
 */
function bodySlab(profile: Array<[number, number]>, width: number): THREE.BufferGeometry {
  const shape = new THREE.Shape(profile.map(([z, y]) => new THREE.Vector2(z, y)));
  const t = CHAMFER.depth;
  const depth = width - 2 * t;
  const g = new THREE.ExtrudeGeometry(shape, {
    depth,
    bevelEnabled: true,
    bevelThickness: t,
    bevelSize: CHAMFER.side,
    bevelOffset: -CHAMFER.side,
    bevelSegments: 1,
    curveSegments: 1,
  });
  // 绕 y 轴转 −90°：形状 u → z，v → y，挤出轴 +z → −x。
  // 必须用旋转而不是交换坐标轴的矩阵：后者行列式为 −1（镜像），会把三角面绕序翻过来，外表面被背面剔除。
  g.rotateY(-Math.PI / 2);
  g.translate(depth / 2, 0, 0);
  g.clearGroups();
  g.deleteAttribute('uv');
  return g.index ? g.toNonIndexed() : g;
}

/** 给非索引几何体整体刷一种顶点色 */
function paint(g: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) arr.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  if (g.attributes.uv) g.deleteAttribute('uv');
  if (g.attributes.normal) g.deleteAttribute('normal');
  return g;
}

/** 车身顶点是否属于主色（下段）：记在 userData.mainMask，换色时只改这些顶点 */
export function setBodyTint(root: THREE.Object3D, hex: number): void {
  const body = root.getObjectByName('body') as THREE.Mesh | undefined;
  if (!body) return;
  const mask = body.geometry.userData.mainMask as Uint8Array | undefined;
  const attr = body.geometry.getAttribute('color') as THREE.BufferAttribute | undefined;
  if (!mask || !attr) return;
  const c = new THREE.Color(hex);
  for (let i = 0; i < mask.length; i++) if (mask[i]) attr.setXYZ(i, c.r, c.g, c.b);
  attr.needsUpdate = true;
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

  // 低多边形轮胎是多边形而非正圆：把轮心抬到“最低顶点正好触地”的高度，保证接地点 y = 0
  const tireProto = new THREE.CylinderGeometry(lay.wheelRadius, lay.wheelRadius, P.wheelWidthM, 16)
    .rotateX(Math.PI / 2)
    .rotateY(Math.PI / 2);
  tireProto.computeBoundingBox();
  const axleY = -tireProto.boundingBox!.min.y;
  const archR = lay.wheelRadius + ARCH_GAP;
  const axles = [lay.frontAxleZ, lay.rearAxleZ];

  // ---- 车身：带轮拱的侧轮廓，按腰线切成上下两段，各自挤出并倒切角 ----
  const zFrontBody = lay.zFront - FACE_INSET;
  const zRearBody = lay.zRear + FACE_INSET;
  const baseProfile = lay.profile.map(([z, y]): [number, number] => [
    z >= lay.zFront - 1e-9 ? zFrontBody : z <= lay.zRear + 0.0061 ? zRearBody : z,
    y,
  ]);
  const profile = archedProfile(baseProfile, axles, axleY, archR, P.bodyBottomM, zFrontBody);
  const slabW = W - 2 * SIDE_INSET;
  const lower = paint(bodySlab(clipPolygonY(profile, beltY(), true), slabW), PAINT.main);
  const upper = paint(bodySlab(clipPolygonY(profile, beltY(), false), slabW), PAINT.cream);
  // 前风挡所在的斜面刷深色：风挡玻璃是半透明的，底下要深色才读得出是玻璃
  {
    const pos = upper.attributes.position;
    const col = upper.attributes.color;
    const dark = new THREE.Color(TRIM_COLORS.window);
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const n = new THREE.Vector3();
    const [wbz, wby] = lay.windshield.bottom;
    const [wtz, wty] = lay.windshield.top;
    for (let i = 0; i < pos.count; i += 3) {
      a.fromBufferAttribute(pos, i);
      b.fromBufferAttribute(pos, i + 1);
      c.fromBufferAttribute(pos, i + 2);
      n.subVectors(c, b).cross(a.clone().sub(b)).normalize();
      const cy = (a.y + b.y + c.y) / 3;
      const cz = (a.z + b.z + c.z) / 3;
      const onSlope = cz <= wbz + 0.01 && cz >= wtz - 0.01 && cy >= wby - 0.01 && cy <= wty + 0.01;
      if (onSlope && n.z > 0.3 && n.y > 0.2) for (let k = 0; k < 3; k++) col.setXYZ(i + k, dark.r, dark.g, dark.b);
    }
  }
  const lowerCount = lower.attributes.position.count;
  const body = merge([lower, upper]);
  const mainMask = new Uint8Array(body.attributes.position.count);
  mainMask.fill(1, 0, lowerCount);
  body.userData.mainMask = mainMask;

  // ---- 黑色件（带顶点色）：轮胎、轮拱边、轮罩、下裙边、前后保险杠、格栅、灯具外形、窗框、后视镜 ----
  const trimParts: THREE.BufferGeometry[] = [];
  const hubParts: THREE.BufferGeometry[] = [];
  const dark = (g: THREE.BufferGeometry) => trimParts.push(paint(g, TRIM_COLORS.dark));
  const tinted = (g: THREE.BufferGeometry, hex: number) => trimParts.push(paint(g, hex));
  for (const z of axles) {
    // 轮罩：两侧轮胎内侧之间的深色挡板，挡住轮拱里透出的另一侧
    const wellW = 2 * (lay.wheelCenterX - P.wheelWidthM / 2) - 0.02;
    dark(box(wellW, archR, 2 * archR, 0, axleY + archR / 2, z));
    // 轮拱边：贴在侧围上的半圆环，外沿不超过 W/2
    const rim = new THREE.Shape();
    rim.absarc(0, 0, archR + ARCH_RIM, Math.PI, 0, true);
    rim.lineTo(archR, 0);
    rim.absarc(0, 0, archR, 0, Math.PI, false);
    rim.lineTo(-archR - ARCH_RIM, 0);
    const rimGeo = new THREE.ExtrudeGeometry(rim, { depth: SIDE_INSET - 0.002, bevelEnabled: false, curveSegments: 9 });
    for (const sx of [-1, 1]) {
      // 形状在 (u, v) = (z, y) 平面，挤出沿 +w；转到 x 方向后贴在侧围外
      const g = rimGeo.clone().rotateY(sx > 0 ? Math.PI / 2 : -Math.PI / 2);
      const xIn = W / 2 - SIDE_INSET;
      g.translate(sx * xIn, axleY, z);
      // 只保留轮拱在车身底边以上的部分：拱心在底边附近，下半圆本就不画
      dark(g.toNonIndexed());
    }
    for (const sx of [-1, 1]) {
      const tire = tireProto.clone().translate(sx * lay.wheelCenterX, axleY, z);
      tinted(tire.toNonIndexed(), TRIM_COLORS.tire);
      const hub = new THREE.CylinderGeometry(lay.wheelRadius * 0.55, lay.wheelRadius * 0.55, 0.02, 10)
        .rotateX(Math.PI / 2)
        .rotateY(Math.PI / 2)
        .translate(sx * (lay.wheelCenterX + P.wheelWidthM / 2 + 0.005), axleY, z);
      hubParts.push(hub.toNonIndexed());
    }
  }
  const bodyW = W - 0.01;
  const yB = P.bodyBottomM;
  dark(box(bodyW - 0.1, 0.28, 0.12, 0, yB + 0.14, lay.zFront - 0.06)); // 前下包围
  dark(box(bodyW - 0.1, 0.3, 0.1, 0, yB + 0.15, lay.zRear + 0.05)); // 后保险杠
  // 下裙边：分三段，让开两个轮拱
  const skirtW = W - 2 * SIDE_INSET + 0.004;
  const spans: Array<[number, number]> = [
    [lay.zRear + 0.12, lay.rearAxleZ - archR - ARCH_RIM],
    [lay.rearAxleZ + archR + ARCH_RIM, lay.frontAxleZ - archR - ARCH_RIM],
    [lay.frontAxleZ + archR + ARCH_RIM, lay.zFront - 0.14],
  ];
  for (const [z0, z1] of spans) if (z1 - z0 > 0.05) dark(box(skirtW, 0.12, z1 - z0, 0, yB + 0.06, (z0 + z1) / 2));

  // 车头面（z ∈ [L/2 − FACE_INSET, L/2]）：横条格栅 + 一道浅色横杠 + 横扫式前大灯外形
  const fz = lay.zFront - FACE_INSET / 2;
  const grilleW = Math.min(1.0, W - 1.1);
  dark(box(grilleW, 0.2, FACE_INSET - 0.004, 0, 0.74, fz - 0.002)); // 格栅比横杠略凹
  tinted(box(grilleW - 0.1, 0.03, FACE_INSET, 0, 0.74, fz), TRIM_COLORS.bar);
  for (const sx of [-1, 1]) tinted(box(0.42, 0.09, FACE_INSET, sx * (W / 2 - 0.27), 1.0, fz), TRIM_COLORS.headlight);

  // 车尾面（z ∈ [−L/2, −L/2 + FACE_INSET]）：两侧竖直尾灯 + 牌照位
  const rz = lay.zRear + FACE_INSET / 2;
  for (const sx of [-1, 1]) tinted(box(0.11, 0.55, FACE_INSET, sx * (W / 2 - 0.1), 1.25, rz), TRIM_COLORS.taillight);
  tinted(box(0.5, 0.15, FACE_INSET, 0, 0.74, rz), TRIM_COLORS.plate);

  // 后视镜：贴门外侧，尖端不超过包围盒宽度；位于 A 柱底端
  const mirrorZ = lay.windshield.bottom[0] - 0.05;
  const mirrorY = P.hoodTopM + 0.35;
  for (const sx of [-1, 1]) dark(box(0.04, 0.22, 0.14, sx * (W / 2 - 0.02), mirrorY, mirrorZ));

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
  // 窗框：玻璃背后的深色衬板，四周比玻璃大一圈，形成黑色包边（侧窗在侧围外、玻璃内；后窗在尾面外、玻璃内）
  const frameT = SIDE_INSET - glassT - 0.001;
  const frameX = W / 2 - glassT - frameT / 2 - 0.0005;
  const winH = winTop - winBottom + 0.06;
  const winY = (winTop + winBottom) / 2;
  for (const sx of [-1, 1]) {
    // 每块侧窗一个窗框，窗与窗之间露出车身色窗柱
    const pane = (len: number, z: number) => tinted(box(frameT, winH - 0.03, len + 0.03, sx * frameX, winY, z), TRIM_COLORS.window);
    pane(drvLen, drvZ);
    pane(paxStart - paxMid - 0.08, (paxStart + paxMid) / 2);
    pane(paxMid - paxEnd - 0.08, (paxMid + paxEnd) / 2);
    // 滑门缝线：滑门段前后两条竖线
    for (const z of [lay.slidingDoor.zStart, lay.slidingDoor.zEnd]) dark(box(frameT, winBottom - yB - 0.2, 0.02, sx * frameX, (winBottom + yB + 0.2) / 2, z));
  }
  tinted(box(bodyW - 0.34, (v.heightM - winBottom) * 0.35 + 0.06, FACE_INSET - glassT - 0.001, 0, v.heightM - 0.45, lay.zRear + glassT + (FACE_INSET - glassT) / 2), TRIM_COLORS.window);
  const glass = merge(glassParts);
  const trim = merge(trimParts);

  const hub = merge(hubParts);

  const root = new THREE.Group();
  root.name = `vehicle_${v.id}`;
  const meshes: Array<[string, THREE.BufferGeometry, THREE.Material]> = [
    ['body', body, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, roughness: 0.65 })],
    ['trim', trim, new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, flatShading: true, roughness: 0.85 })],
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
