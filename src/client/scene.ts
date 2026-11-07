/**
 * Three.js 营地场景：只负责显示，不含玩法逻辑。
 * 坐标映射（逻辑数学平面系 → three）：three.x = x，three.z = −y；车辆 rotation.y = yaw + π/2
 *（占位车模车头朝 +z，见 src/geometry/layout.ts）。
 * 场景美术是占位（低多边形色块），正式方向由 GPT Image 的 A1 场景图给出后替换。
 */
import * as THREE from 'three';
import type { Variant } from '../data/models';
import { GATE, ROAD, STALLS, TREES, WORLD, type Stall } from '../shared/camp';
import { SIDE_AWNING } from '../shared/config';
import { bodyCenter, type Pose, type VehicleSpec } from '../shared/kinematics';
import { buildPlaceholderVehicle, buildSideAwning } from '../geometry/placeholder';
import { SNAPSHOT_FOV_DEG } from '../shared/cardcam';
import { takeSnapshot } from './snapshot';

const flat = (color: number) => new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.9 });

export function toThree(x: number, y: number, h = 0): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

export function placeVehicle(obj: THREE.Object3D, s: VehicleSpec, p: Pose): void {
  const [cx, cy] = bodyCenter(s, p);
  obj.position.copy(toThree(cx, cy));
  obj.rotation.y = p.yaw + Math.PI / 2;
}

export interface VehicleView {
  root: THREE.Group;
  setAwning(on: boolean): void;
}

export function makeVehicle(v: Variant, tint?: number): VehicleView {
  const { root, anchors } = buildPlaceholderVehicle(v);
  if (tint !== undefined) {
    const body = root.getObjectByName('body') as THREE.Mesh;
    (body.material as THREE.MeshStandardMaterial).color.setHex(tint);
  }
  let awning: THREE.Group | null = null;
  return {
    root,
    setAwning(on) {
      if (on && !awning) {
        awning = buildSideAwning(v, SIDE_AWNING.depthM);
        anchors.side_awning.add(awning);
      } else if (!on && awning) {
        anchors.side_awning.remove(awning);
        disposeTree(awning);
        awning = null;
      }
    },
  };
}

export function disposeTree(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      const mat = m.material;
      (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
    }
  });
}

function stadium(path: THREE.Path, halfStraight: number, r: number, hole = false): void {
  // 逻辑平面上的跑道形，按 three 的 (x, −y) 写进 Shape（Shape 在 xy 平面，之后绕 x 轴转到地面）
  const A = halfStraight;
  const pts: THREE.Vector2[] = [];
  const seg = 24;
  for (let i = 0; i <= seg; i++) {
    const a = -Math.PI / 2 + (Math.PI * i) / seg;
    pts.push(new THREE.Vector2(A + r * Math.cos(a), r * Math.sin(a)));
  }
  for (let i = 0; i <= seg; i++) {
    const a = Math.PI / 2 + (Math.PI * i) / seg;
    pts.push(new THREE.Vector2(-A + r * Math.cos(a), r * Math.sin(a)));
  }
  if (hole) pts.reverse();
  path.setFromPoints(pts);
}

/** 平面 Shape（逻辑 x, y）→ 贴地网格 */
function groundMesh(shape: THREE.Shape, mat: THREE.Material, h: number): THREE.Mesh {
  const g = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
  const m = new THREE.Mesh(g, mat);
  m.position.y = h;
  m.receiveShadow = true;
  return m;
}

function labelSprite(text: string, color = '#f5efe0'): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = 'rgba(15,26,21,0.72)';
  ctx.beginPath();
  ctx.roundRect(4, 8, 248, 48, 12);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 28px "PingFang SC", "Microsoft YaHei", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false }));
  s.scale.set(4, 1, 1);
  s.renderOrder = 10;
  return s;
}

function buildWorld(scene: THREE.Scene): Map<string, THREE.Sprite> {
  const { minX, maxX, minY, maxY } = WORLD;
  // 草地
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200).rotateX(-Math.PI / 2), flat(0x7c9a5a));
  ground.receiveShadow = true;
  scene.add(ground);
  // 营地内地面（略浅）
  const yard = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxY - minY).rotateX(-Math.PI / 2), flat(0x8fae66));
  yard.position.copy(toThree((minX + maxX) / 2, (minY + maxY) / 2, 0.002));
  yard.receiveShadow = true;
  scene.add(yard);

  // 环路：外跑道形挖掉内跑道形
  const roadMat = flat(0x6f6a62);
  const outer = new THREE.Shape();
  stadium(outer, ROAD.halfStraight, ROAD.centerR + ROAD.width / 2);
  const hole = new THREE.Path();
  stadium(hole, ROAD.halfStraight, ROAD.centerR - ROAD.width / 2, true);
  outer.holes.push(hole);
  scene.add(groundMesh(outer, roadMat, 0.01));
  // 中心虚线（逆时针单向，画箭头感的短段）
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xf2e6c4 });
  for (let x = -ROAD.halfStraight + 1; x < ROAD.halfStraight; x += 4) {
    for (const [y, dir] of [
      [-ROAD.centerR, 1],
      [ROAD.centerR, -1],
    ] as const) {
      const d = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 0.14).rotateX(-Math.PI / 2), dashMat);
      d.position.copy(toThree(x + dir * 0.8, y, 0.015));
      scene.add(d);
    }
  }
  // 大门道路
  const gateLen = -ROAD.centerR - minY + 1;
  const gateRoad = new THREE.Mesh(new THREE.PlaneGeometry(GATE.width, gateLen).rotateX(-Math.PI / 2), roadMat);
  gateRoad.position.copy(toThree(GATE.x, minY - 1 + gateLen / 2, 0.009));
  gateRoad.receiveShadow = true;
  scene.add(gateRoad);

  // 篝火岛：草坪 + 篝火 + 几根原木
  const island = new THREE.Shape();
  stadium(island, ROAD.halfStraight, ROAD.centerR - ROAD.width / 2);
  scene.add(groundMesh(island, flat(0x6b8f4e), 0.012));
  const fire = new THREE.Group();
  const stones = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.22, 5, 10).rotateX(Math.PI / 2), flat(0x8c8a84));
  stones.position.y = 0.15;
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.55, 1.4, 6), new THREE.MeshStandardMaterial({ color: 0xff8a2a, emissive: 0xff5a00, emissiveIntensity: 1.2, flatShading: true }));
  flame.position.y = 0.75;
  flame.name = 'flame';
  fire.add(stones, flame);
  for (let i = 0; i < 4; i++) {
    const log = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 2, 6).rotateZ(Math.PI / 2), flat(0x7a5232));
    const a = (i * Math.PI) / 2 + Math.PI / 4;
    log.position.set(Math.cos(a) * 3, 0.22, Math.sin(a) * 3);
    log.rotation.y = -a + Math.PI / 2;
    log.castShadow = true;
    fire.add(log);
  }
  const fireLight = new THREE.PointLight(0xff9a40, 8, 14);
  fireLight.position.y = 1.4;
  fire.add(fireLight);
  scene.add(fire);

  // 车位：地面色块 + 白线 + 标牌
  const labels = new Map<string, THREE.Sprite>();
  for (const st of STALLS) {
    const color = st.kind === 'home' ? 0xc7a76d : st.kind === 'love' ? 0xd99a9a : 0xb8ad97;
    const pad = new THREE.Mesh(new THREE.PlaneGeometry(st.length, st.width).rotateX(-Math.PI / 2), flat(color));
    pad.position.copy(toThree(st.cx, st.cy, 0.008));
    pad.rotation.y = st.yaw;
    pad.receiveShadow = true;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(st.length, st.width).rotateX(-Math.PI / 2)),
      new THREE.LineBasicMaterial({ color: 0xf5efe0 }),
    );
    edges.position.copy(toThree(st.cx, st.cy, 0.02));
    edges.rotation.y = st.yaw;
    scene.add(pad, edges);
    const label = labelSprite(st.kind === 'home' ? '家位' : st.kind === 'love' ? '爱心车位' : st.label.replace('私家车位', '号位'));
    const inward = st.length / 2 + 0.8;
    label.position.copy(toThree(st.cx + Math.cos(st.yaw) * inward, st.cy + Math.sin(st.yaw) * inward, 1.4));
    scene.add(label);
    labels.set(st.id, label);
  }

  // 围栏：木桩 + 横杆（南墙在大门处断开）
  const postMat = flat(0x8b5e3c);
  const postGeo = new THREE.BoxGeometry(0.18, 1.1, 0.18);
  const posts = new THREE.InstancedMesh(postGeo, postMat, 400);
  let n = 0;
  const m4 = new THREE.Matrix4();
  const addPost = (x: number, y: number) => {
    m4.makeTranslation(x, 0.55, -y);
    posts.setMatrixAt(n++, m4);
  };
  for (let x = minX; x <= maxX; x += 2) {
    addPost(x, maxY);
    if (Math.abs(x - GATE.x) > GATE.width / 2 + 0.5) addPost(x, minY);
  }
  for (let y = minY; y <= maxY; y += 2) {
    addPost(minX, y);
    addPost(maxX, y);
  }
  posts.count = n;
  posts.castShadow = true;
  scene.add(posts);
  // 大门门柱 + 横梁 + 牌子
  for (const sx of [-1, 1]) {
    const p = new THREE.Mesh(new THREE.BoxGeometry(0.4, 4.4, 0.4), postMat);
    p.position.copy(toThree(GATE.x + sx * (GATE.width / 2 + 0.4), minY, 2.2));
    p.castShadow = true;
    scene.add(p);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(GATE.width + 1.6, 0.35, 0.35), postMat);
  beam.position.copy(toThree(GATE.x, minY, 4.2));
  scene.add(beam);
  const sign = labelSprite('营地大门', '#f2c14e');
  sign.position.copy(toThree(GATE.x, minY, 5));
  scene.add(sign);

  // 树
  const trunkMat = flat(0x6b4a2f);
  const leafMat = flat(0x2f5a3a);
  for (const t of TREES) {
    const g = new THREE.Group();
    const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.22, 1.2, 5), trunkMat);
    trunk.position.y = 0.6;
    const h = 3 + t.r * 2;
    const leaves = new THREE.Mesh(new THREE.ConeGeometry(t.r * 1.4, h, 6), leafMat);
    leaves.position.y = 1.2 + h / 2;
    leaves.castShadow = true;
    g.add(trunk, leaves);
    g.position.copy(toThree(t.x, t.y));
    scene.add(g);
  }
  // 营地外的远景树（无碰撞，围栏外）
  let seed = 11;
  const r = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < 70; i++) {
    const a = r() * Math.PI * 2;
    const d = 48 + r() * 40;
    const h = 4 + r() * 5;
    const leaves = new THREE.Mesh(new THREE.ConeGeometry(h * 0.3, h, 6), leafMat);
    leaves.position.set(Math.cos(a) * d, h / 2, Math.sin(a) * d - 7);
    scene.add(leaves);
  }
  return labels;
}

export interface CampScene {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  render(dt: number): void;
  /** 相机跟随目标（车身中心 + 朝向）；overview = 俯瞰全营地 */
  follow(target: { x: number; y: number; yaw: number; h: number } | null, overview: boolean): void;
  stallLabel(id: string): THREE.Sprite | undefined;
  /** 碰撞烟尘：point 为接触点（逻辑坐标），n 为推开方向，strength 为法向撞击速度 m/s */
  dust(point: [number, number], n: [number, number], strength: number): void;
  /** 震屏：amount 0..1 */
  shake(amount: number): void;
  /**
   * 截图（露营卡片 #30）：临时相机（垂直视场 SNAPSHOT_FOV_DEG）渲染一帧并拷进 2D 画布，流程与状态恢复见 snapshot.ts。
   * pos / look 为 three 坐标；opts.fog = false 时这一帧不加雾（俯视全景距离远，雾会把营地罩白）；
   * opts.labels = false 时隐藏车位标牌（标牌不做深度测试，特写时会挡住车）。
   */
  snapshot(pos: THREE.Vector3, look: THREE.Vector3, w: number, h: number, opts?: { fog?: boolean; labels?: boolean }): HTMLCanvasElement;
  dispose(): void;
}

/** 软边圆形贴图（烟尘粒子共用） */
function puffTexture(): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.55)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

interface Puff {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  max: number;
  size0: number;
  size1: number;
  alpha: number;
}

/** 烟尘粒子池：固定 160 个精灵循环复用，不在运行时分配几何体 */
function createDust(scene: THREE.Scene) {
  const tex = puffTexture();
  const pool: Puff[] = [];
  for (let i = 0; i < 160; i++) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0 }));
    sprite.visible = false;
    scene.add(sprite);
    pool.push({ sprite, vel: new THREE.Vector3(), life: 0, max: 1, size0: 0.5, size1: 1.5, alpha: 0.6 });
  }
  let next = 0;
  const dustColor = new THREE.Color(0xc9bba0);
  const smokeColor = new THREE.Color(0x6e6a64);
  return {
    burst(point: [number, number], n: [number, number], strength: number) {
      const count = Math.round(Math.min(28, 4 + strength * 5));
      const hard = Math.min(1, strength / 5); // 撞得越狠，烟越深、越大
      for (let i = 0; i < count; i++) {
        const p = pool[next];
        next = (next + 1) % pool.length;
        const a = Math.random() * Math.PI * 2;
        const out = 0.6 + Math.random() * (1 + strength * 0.5);
        // 主方向沿推开方向 n，带随机散开；three 坐标 z = −y
        p.vel.set(
          n[0] * out + Math.cos(a) * 0.8,
          0.6 + Math.random() * (0.8 + hard * 1.2),
          -(n[1] * out) + Math.sin(a) * 0.8,
        );
        p.sprite.position.set(point[0] + (Math.random() - 0.5) * 0.4, 0.2 + Math.random() * 0.8, -point[1] + (Math.random() - 0.5) * 0.4);
        p.max = p.life = 0.7 + Math.random() * (0.6 + hard * 0.8);
        p.size0 = 0.4 + Math.random() * 0.4;
        p.size1 = 1.4 + Math.random() * 1.2 + hard * 1.6;
        p.alpha = 0.45 + hard * 0.35;
        (p.sprite.material as THREE.SpriteMaterial).color.copy(dustColor).lerp(smokeColor, hard * Math.random());
        p.sprite.visible = true;
      }
    },
    update(dt: number) {
      for (const p of pool) {
        if (!p.sprite.visible) continue;
        p.life -= dt;
        if (p.life <= 0) {
          p.sprite.visible = false;
          continue;
        }
        const k = 1 - p.life / p.max; // 0 → 1
        p.vel.multiplyScalar(Math.exp(-dt * 2.2)); // 空气阻力
        p.vel.y += dt * 0.25; // 热烟上浮
        p.sprite.position.addScaledVector(p.vel, dt);
        const size = p.size0 + (p.size1 - p.size0) * Math.sqrt(k);
        p.sprite.scale.set(size, size, 1);
        (p.sprite.material as THREE.SpriteMaterial).opacity = p.alpha * (1 - k) * Math.min(1, k * 8);
      }
    },
  };
}

export function createCampScene(container: HTMLElement): CampScene {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xa9cbc3);
  scene.fog = new THREE.Fog(0xa9cbc3, 70, 140);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 400);
  camera.position.set(0, 60, 40);

  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3d5a40, 1.15));
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.2);
  sun.position.set(-30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, far: 150 });
  scene.add(sun);

  const labels = buildWorld(scene);
  const flame = scene.getObjectByName('flame');

  const camPos = new THREE.Vector3(0, 60, 40);
  const camLook = new THREE.Vector3(0, 0, 0);
  let want = { pos: camPos.clone(), look: camLook.clone() };
  let t = 0;
  let shakeAmt = 0;
  const dust = createDust(scene);

  function follow(target: { x: number; y: number; yaw: number; h: number } | null, overview: boolean) {
    if (overview || !target) {
      want = { pos: new THREE.Vector3(0, 62, 38), look: new THREE.Vector3(0, 0, 4) };
      return;
    }
    const back = 13 + target.h;
    const c = toThree(target.x, target.y);
    const dir = new THREE.Vector3(Math.cos(target.yaw), 0, -Math.sin(target.yaw));
    want = {
      pos: c.clone().addScaledVector(dir, -back).add(new THREE.Vector3(0, 7 + target.h, 0)),
      look: c.clone().addScaledVector(dir, 4).add(new THREE.Vector3(0, 1, 0)),
    };
  }

  function resize() {
    const w = container.clientWidth;
    const h = container.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(h, 1);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(container);
  resize();

  return {
    scene,
    camera,
    follow,
    stallLabel: (id) => labels.get(id),
    dust: (point, n, strength) => dust.burst(point, n, strength),
    shake(amount) {
      shakeAmt = Math.min(1, Math.max(shakeAmt, amount));
    },
    render(dt) {
      t += dt;
      const k = 1 - Math.exp(-dt * 3.5);
      camPos.lerp(want.pos, k);
      camLook.lerp(want.look, k);
      camera.position.copy(camPos);
      // 震屏：衰减的高频抖动，幅度最大约 0.35 m
      if (shakeAmt > 0.001) {
        const a = shakeAmt * shakeAmt * 0.35;
        camera.position.x += Math.sin(t * 61) * a;
        camera.position.y += Math.sin(t * 47 + 1.3) * a;
        camera.position.z += Math.cos(t * 53) * a;
        shakeAmt *= Math.exp(-dt * 7);
      }
      camera.lookAt(camLook);
      dust.update(dt);
      if (flame) {
        flame.scale.set(1 + Math.sin(t * 9) * 0.06, 1 + Math.sin(t * 13) * 0.12, 1 + Math.cos(t * 7) * 0.06);
      }
      renderer.render(scene, camera);
    },
    snapshot(pos, look, w, h, opts) {
      const cam = new THREE.PerspectiveCamera(SNAPSHOT_FOV_DEG, w / h, 0.1, 400);
      cam.position.copy(pos);
      cam.lookAt(look);
      return takeSnapshot<THREE.Scene, THREE.Camera, HTMLCanvasElement>(
        { renderer, scene, mainCamera: camera, labels: labels.values(), createCanvas: () => document.createElement('canvas') },
        cam,
        w,
        h,
        opts,
      );
    },
    dispose() {
      ro.disconnect();
      renderer.dispose();
    },
  };
}

export type { Stall };
