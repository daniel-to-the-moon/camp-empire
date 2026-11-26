/** #97 黄昏麦田。原创程序几何，只读营地边界，不参与导航、时钟或车灯判定。
 * 颜色依据 docs/visual/STYLE.md；以下布景尺寸（米）、光照和色调参数均为美术提案 / 待核实。
 * 坐标为 three 世界坐标：北是 −z。所有地貌在建场时生成一次。
 */
import * as THREE from 'three';
import { GATE, WORLD } from '../shared/camp';

const west = WORLD.minX, east = WORLD.maxX, north = -WORLD.maxY, south = -WORLD.minY;
const PLAIN = 80; // 方形平原半宽；其外缘就是第一层丘陵的坡脚
const HORIZON = 0xf3cfa0;
const SUN = new THREE.Vector3(-58, 27, -34);
type Point = [number, number, number];

/** 不同色的三角面/凸多边形烘在同一张不透明网格，不按田块、穗或山坡切材质组。 */
class Facets {
  private positions: number[] = [];
  private colors: number[] = [];
  private rgb = new THREE.Color();

  face(hex: number, ...pts: Point[]) {
    this.rgb.setHex(hex); // 设计色是 sRGB；顶点色写线性值
    for (let j = 1; j < pts.length - 1; j++) {
      for (const p of [pts[0], pts[j], pts[j + 1]]) {
        this.positions.push(...p);
        this.colors.push(this.rgb.r, this.rgb.g, this.rgb.b);
      }
    }
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeVertexNormals();
    return g;
  }
}

function terrain() {
  const land = new Facets();
  function soil(x0: number, x1: number, z0: number, z1: number) {
    land.face(0xbc985f, [x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0]);
  }
  // 中间留孔，由现有营地地坪填满；不在营地路面下面叠一整张平面。
  soil(-PLAIN, PLAIN, -PLAIN, north);
  soil(-PLAIN, PLAIN, south, PLAIN);
  soil(-PLAIN, west, north, south);
  soil(east, PLAIN, north, south);

  // 连续的坡面：田边 → 近脊 → 谷底 → 远脊 → 背坡。首环沿方田四边（含四角），没有浮在地平线上的山片。
  // 东侧留一道低鞍部：朝东的环路直道上，跟随镜头也能越过田垄看到一线天空。
  const sectors = 40;
  const bands = [0xb2a178, 0xa9a07e, 0xab9694, 0xb5a1a0];
  const sections = Array.from({ length: sectors }, (_, i): Point[] => {
    const a = i * 2 * Math.PI / sectors, x = Math.cos(a), z = Math.sin(a);
    const at = (r: number, h: number): Point => [x * r, h, z * r];
    return [at(PLAIN / Math.max(Math.abs(x), Math.abs(z)), 0),
      at(123 + 5 * Math.sin(3 * a), 4 + 2 * Math.sin(3 * a + 0.6) + 2.7 * (1 - x)),
      at(142, 1.5), at(167 + 8 * Math.cos(2 * a), 5 + 2 * Math.sin(4 * a) + 5.5 * (1 - x)), at(188, 0)];
  });
  sections.forEach((s, i) => {
    const next = sections[(i + 1) % sectors];
    bands.forEach((color, k) => land.face(color, s[k], next[k], next[k + 1], s[k + 1]));
  });
  const mesh = new THREE.Mesh(land.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  mesh.name = 'field-earth-and-ridges';
  mesh.receiveShadow = true;
  return mesh;
}

function wheat() {
  const crop = new Facets();
  const gold = [0xdeac57, 0xe2b361, 0xeabc68];
  // 每垄是从泥土长起的两侧、穗面和收口；近端散出有茎、有旗叶的单穗。
  function plot(start: number, end: number, boundary: number, outward: number, alongX: boolean) {
    const rows = Math.floor((end - start) / 4);
    const pitch = (end - start) / rows;
    const depth = PLAIN - Math.abs(boundary) - 4;
    for (let row = 0; row < rows; row++) {
      const mid = start + (row + 0.5) * pitch;
      const phase = mid * 0.28 + boundary;
      const point = (u: number, h: number, d: number): Point => {
        const v = boundary + outward * (2 + d);
        return alongX ? [mid + u, h, v] : [v, h, mid + u];
      };
      const sections = [0, 0.54, 1].map((t) => {
        const d = t * depth + 0.22 * Math.cos(phase);
        // 成片弯向一侧，田边把弯幅收为零，不把垄挤进田径。
        const drift = pitch * 0.48 * Math.sin(Math.PI * (row + 0.5) / rows) * Math.sin(t * 4 + mid * 0.04);
        const h = 0.68 + 0.12 * Math.cos(phase + t * 5);
        return [point(drift - pitch * 0.42, 0, d), point(drift - pitch * 0.34, h, d),
          point(drift + pitch * 0.29, h + 0.14, d), point(drift + pitch * 0.42, 0, d)];
      });
      for (let i = 1; i < sections.length; i++) {
        const a = sections[i - 1], b = sections[i];
        const colors = [0xd9a24a, gold[(row + i) % gold.length], 0xd5a350];
        for (let j = 0; j < 3; j++) crop.face(colors[j], a[j], b[j], b[j + 1], a[j + 1]);
      }
      crop.face(0xcda052, ...sections[0]);
      crop.face(0xcda052, ...sections[sections.length - 1]);

      // 稍向同一侧弯：麦穗的棱脊落到茎顶，旗叶从茎身分叉；两侧穗芒从穗肩挑出。
      for (const u of [-pitch * 0.22, pitch * 0.13]) {
        const h = 0.83 + 0.10 * Math.sin(phase + u), d = -0.45 - 0.10 * Math.cos(phase + u);
        const root = point(u, 0, d), collar = point(u + 0.12, h, d);
        crop.face(0xbb893e, root, point(u + 0.07, 0, d), collar);
        crop.face(0xdeac55, point(u + 0.07, h * 0.46, d), point(u - 0.10, h * 0.66, d), point(u - 0.17, h * 0.85, d));
        const l = point(u + 0.06, h + 0.20, d), r = point(u + 0.28, h + 0.22, d);
        const keel = point(u + 0.17, h + 0.22, d - 0.07), tip = point(u + 0.27, h + 0.48, d);
        crop.face(0xeaba61, collar, l, keel); crop.face(0xeaba61, keel, l, tip);
        crop.face(0xf0c46a, collar, keel, r); crop.face(0xf0c46a, r, keel, tip);
        crop.face(0xeaba61, l, point(u + 0.144, h + 0.312, d), point(u - 0.03, h + 0.44, d));
        crop.face(0xf0c46a, r, point(u + 0.275, h + 0.35, d), point(u + 0.38, h + 0.46, d));
      }
    }
  }
  plot(-PLAIN, PLAIN, north, -1, true);
  // 南田分成两畦，一直留出与大门同轴的田径；不堵进场口。
  plot(-PLAIN, GATE.x - GATE.width / 2 - 1, south, 1, true);
  plot(GATE.x + GATE.width / 2 + 1, PLAIN, south, 1, true);
  plot(north, south, west, -1, false);
  plot(north, south, east, 1, false);
  const mesh = new THREE.Mesh(crop.geometry(), new THREE.MeshStandardMaterial({
    vertexColors: true, side: THREE.DoubleSide, roughness: 1, flatShading: true,
  }));
  mesh.name = 'wheat-rows';
  mesh.receiveShadow = true;
  return mesh;
}

function cloudBanks() {
  const cloud = new Facets();
  // 一片云是一条封闭的云带，不叠球：截面的云底较平，云肩有两个隆起，截面之间共边。
  const profile = [[-1, 0.12], [-0.78, 0.64], [-0.44, 0.48], [-0.08, 1], [0.26, 0.72], [0.61, 0.53], [1, 0.10]];
  const sections = profile.map(([x, v]): Point[] => [
    [x, -0.35 * v, 0.58 * v], [x, 0.22 * v, v], [x, v, 0.22 * v],
    [x, 0.81 * v, -0.58 * v], [x, 0.06 * v, -v], [x, -0.38 * v, -0.60 * v],
  ]);
  const colors = [0xf2b3a8, 0xfbd7c8, 0xfbe3dc, 0xf9c9c3, 0xe5adb4, 0xd9a1aa];
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1], b = sections[i];
    colors.forEach((color, j) => {
      const k = (j + 1) % colors.length;
      cloud.face(color, a[j], b[j], b[k], a[k]);
    });
  }
  cloud.face(colors[0], ...sections[0]);
  cloud.face(colors[0], ...sections[sections.length - 1].slice().reverse());
  const banks = new THREE.InstancedMesh(cloud.geometry(), new THREE.MeshStandardMaterial({
    vertexColors: true, flatShading: true, roughness: 1, emissive: 0xc7929c, emissiveIntensity: 0.52, fog: false,
  }), 11);
  banks.name = 'pink-cloud-banks';
  const pose = new THREE.Object3D();
  for (let i = 0; i < banks.count; i++) {
    const a = (i + 0.22 * Math.sin(i * 3.7)) * 2 * Math.PI / banks.count;
    const r = 216 + 10 * Math.cos(i * 5);
    const low = i % 3 === 0; // 错开贴地平线的薄云与高一些的云团，坡脊自然遮住低云的下缘
    pose.position.set(r * Math.cos(a), low ? 8.3 : 23 + 7 * Math.sin(i * 4.2), r * Math.sin(a));
    pose.rotation.y = Math.PI / 2 - a + 0.18 * Math.sin(i);
    pose.scale.set(16 + 8 * Math.cos(i * 1.8), low ? 2.5 : 4.8 + 2 * Math.sin(i * 2), 6 + Math.cos(i));
    pose.updateMatrix();
    banks.setMatrixAt(i, pose.matrix);
  }
  return banks;
}

function sunsetSky() {
  // 只用观察方向，不用相机平移；露营卡片的临时相机也看到同一地平线。不采纹理、不做后处理。
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      horizon: { value: new THREE.Color(HORIZON) }, rose: { value: new THREE.Color(0xd7b8b9) },
      zenith: { value: new THREE.Color(0x7f93c4) }, sunDir: { value: SUN.clone().normalize() },
      sunlight: { value: new THREE.Color(0xffe6bc) },
    },
    vertexShader: `varying vec3 ray;
      void main() {
        ray = position;
        vec4 p = projectionMatrix * vec4(mat3(viewMatrix) * position, 1.0);
        gl_Position = p.xyww;
      }`,
    fragmentShader: `varying vec3 ray;
      uniform vec3 horizon, rose, zenith, sunDir, sunlight;
      void main() {
        vec3 d = normalize(ray);
        vec3 c = mix(horizon, rose, smoothstep(0.0, 0.24, d.y));
        c = mix(c, zenith, smoothstep(0.09, 0.55, d.y));
        float facing = max(dot(d, sunDir), 0.0);
        c = mix(c, sunlight, 0.45 * pow(facing, 22.0) + 0.55 * smoothstep(0.9996, 0.9999, facing));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
    side: THREE.BackSide, depthWrite: false, toneMapped: false,
  });
  const sky = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), mat);
  sky.name = 'dusk-sky';
  sky.frustumCulled = false;
  sky.renderOrder = 1; // 远深度：已经画过车和地面的像素不必再算天空色
  return sky;
}

export function addDuskLandscape(scene: THREE.Scene, renderer: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'>): void {
  renderer.toneMapping = THREE.NeutralToneMapping;
  renderer.toneMappingExposure = 1.12;
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.Fog(HORIZON, 105, 225); // 越过营地才起雾，近景保留窗带/奶白顶的反差
  const fill = new THREE.HemisphereLight(0xfff4ef, 0xb7a8be, 1.65);
  const sun = new THREE.DirectionalLight(0xffddbc, 2.6);
  sun.position.copy(SUN);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -55, right: 55, top: 55, bottom: -55, far: 160 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.radius = 2;
  sun.shadow.intensity = 0.84;
  scene.add(fill, sun, sunsetSky(), terrain(), wheat(), cloudBanks());
}
