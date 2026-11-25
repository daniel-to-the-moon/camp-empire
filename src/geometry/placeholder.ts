/** Procedural vehicle meshes, attachment anchors and upgrades. */
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Variant } from '../data/models';
import { computeLayout, type AnchorName } from './layout';
import type { LampQuad, LampRole } from './lampFixtures';
import { MAIN_PAINT, vehicleGeometries } from './vehicleBody';

export { lampLayout, type LampQuad, type LampRole } from './lampFixtures';
export type LampState = Partial<Record<LampRole, boolean>>;

/** 发光材质表（off → on 均为 sRGB 提案色，待视觉验收）。只有透镜用 MeshBasic 顶点色，灯壳仍受光照。
 * head / tail / marker：夜间常亮，分别为暖白、暗红和琥珀；白天不亮。
 * turnL / turnR：本侧前、后及翼子板随转向同相闪烁。brake：制动；reverse：倒车。不添加实时光源。
 */
export const LAMP_COLORS: Record<LampRole, { off: number; on: number }> = {
  head: { off: 0xc6bc9e, on: 0xfff1c2 },
  tail: { off: 0x602d32, on: 0xb43239 },
  marker: { off: 0x836038, on: 0xffbb56 },
  turnL: { off: 0x74512c, on: 0xffa21a },
  turnR: { off: 0x74512c, on: 0xffa21a },
  brake: { off: 0x5a1c1a, on: 0xff2a1f },
  reverse: { off: 0x8a8a86, on: 0xfdfbf2 },
};
const roles = Object.keys(LAMP_COLORS) as LampRole[];
const TRIM_COLOR = 0x2b2b2e;

export const MATERIALS = {
  body: () => new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, flatShading: true, roughness: 0.72,
  }),
  trim: () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.85 }),
  glass: () => new THREE.MeshStandardMaterial({
    vertexColors: true, transparent: true, roughness: 0.22, depthWrite: false,
  }),
  hub: () => new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.58 }),
};

const box = (w: number, h: number, d: number, x: number, y: number, z: number) =>
  new THREE.BoxGeometry(w, h, d).translate(x, y, z).toNonIndexed();

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts.map((p) => (p.index ? p.toNonIndexed() : p)), false);
  if (!g) throw new Error('mergeGeometries failed');
  g.computeVertexNormals();
  return g;
}

export interface VehicleBuild {
  root: THREE.Group;
  anchors: Record<AnchorName, THREE.Object3D>;
}

export function buildPlaceholderVehicle(v: Variant, tint = MAIN_PAINT): VehicleBuild {
  const lay = computeLayout(v);
  const { body, trim, glass, hub, lenses } = vehicleGeometries(v, lay, tint);

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
    root.add(mesh);
  }

  root.add(lampMesh(lenses));
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

/** 每片透镜 2 个三角面，初始为熄灭色。polygonOffset 让共面的透镜绘在壳体之前。 */
function lampMesh(quads: LampQuad[]): THREE.Mesh {
  const pos: number[] = [];
  const col: number[] = [];
  const color = new THREE.Color();
  for (const { role, corners: [a, b, c, d] } of quads) {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    color.setHex(LAMP_COLORS[role].off);
    for (let i = 0; i < 6; i++) col.push(color.r, color.g, color.b);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.userData.roles = quads.map((q) => q.role);
  g.userData.litMask = 0;
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const m = new THREE.Mesh(g, mat);
  m.name = 'lamps';
  return m;
}

/** 传旧的四角色状态仍有效；未指定的角色一律熄灭。缓存包括常亮灯，昼夜交界也会更新。 */
export function setLamps(root: THREE.Object3D, on: LampState): void {
  const m = root.getObjectByName('lamps') as THREE.Mesh | undefined;
  if (!m) return;
  const mask = roles.reduce((bits, role, i) => on[role] ? bits | (1 << i) : bits, 0);
  if (m.geometry.userData.litMask === mask) return;
  m.geometry.userData.litMask = mask;
  const layout = m.geometry.userData.roles as LampRole[];
  const attr = m.geometry.getAttribute('color') as THREE.BufferAttribute;
  const c = new THREE.Color();
  layout.forEach((r, i) => {
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
