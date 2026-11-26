/** #97 黄昏麦田。原创程序几何，只读营地边界，不参与导航、时钟或车灯判定。
 * 颜色依据 docs/visual/STYLE.md；以下布景尺寸（米）、光照和色调参数均为美术提案 / 待核实。
 * 坐标为 three 世界坐标：北是 −z。所有地貌在建场时生成一次。
 */
import * as THREE from 'three';
import { GATE, WORLD } from '../shared/camp';

const west = WORLD.minX, east = WORLD.maxX, north = -WORLD.maxY, south = -WORLD.minY;
const PLAIN = 80; // 方形平原半宽；其外缘就是第一层丘陵的坡脚
const EARTH = 0xc3a66b;
const HORIZON = 0xf3cfa0;
const SUN = new THREE.Vector3(-58, 27, -34);
type Point = [number, number, number];

/** 不同色的三角面/凸多边形烘在同一张不透明网格，不按田块、穗或山坡切材质组。 */
class Facets {
  private positions: number[] = [];
  private colors: number[] = [];
  private rgb = new THREE.Color();

  triangle(a: Point, b: Point, c: Point, ca: number, cb = ca, cc = ca) {
    this.positions.push(...a, ...b, ...c);
    for (const hex of [ca, cb, cc]) {
      this.rgb.setHex(hex); // 设计色是 sRGB；顶点色写线性值
      this.colors.push(this.rgb.r, this.rgb.g, this.rgb.b);
    }
  }

  face(hex: number, ...pts: Point[]) {
    for (let j = 1; j < pts.length - 1; j++) this.triangle(pts[0], pts[j], pts[j + 1], hex);
  }

  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, 3));
    g.computeVertexNormals();
    return g;
  }
}

/** 替换原场坪，不叠色片。中心是压暗的暖赭土，走到围栏时渐变为围栏外的田土色。 */
export function createDuskYard() {
  const yard = new Facets();
  const core = 0xb49366;
  const ring = (inset: number): Point[] => [
    [west + inset, 0, north + inset], [west + inset, 0, south - inset],
    [east - inset, 0, south - inset], [east - inset, 0, north + inset],
  ];
  const inner = ring(7), outer = ring(0);
  yard.face(core, ...inner);
  outer.forEach((p, i) => {
    const j = (i + 1) % outer.length;
    yard.triangle(p, outer[j], inner[j], EARTH, EARTH, core);
    yard.triangle(p, inner[j], inner[i], EARTH, core, core);
  });
  const mesh = new THREE.Mesh(yard.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1 }));
  mesh.position.y = 0.002; // 沿用原场坪层高，在道路与车位以下
  mesh.receiveShadow = true;
  return mesh;
}

function terrain() {
  const land = new Facets();
  function soil(x0: number, x1: number, z0: number, z1: number) {
    land.face(EARTH, [x0, 0, z0], [x0, 0, z1], [x1, 0, z1], [x1, 0, z0]);
  }
  // 中间留孔，由营地地坪填满；不在营地路面下面叠一整张平面。
  soil(-PLAIN, PLAIN, -PLAIN, north);
  soil(-PLAIN, PLAIN, south, PLAIN);
  soil(-PLAIN, west, north, south);
  soil(east, PLAIN, north, south);

  // 同样的 320 个坡地三角面，改分为 32 扇区 × 5 段坡 × 2 面。
  // 加入蜿蜒的坡肩，而不是用贯穿视野的一张长斜面接田边与近脊；东、北侧压低峰线。
  const sectors = 32;
  const sections = Array.from({ length: sectors }, (_, i): Point[] => {
    const a = i * 2 * Math.PI / sectors, x = Math.cos(a), z = Math.sin(a);
    const at = (r: number, h: number): Point => [x * r, h, z * r];
    const foot = PLAIN / Math.max(Math.abs(x), Math.abs(z));
    const crest = 123 + 5 * Math.sin(3 * a), h = 2.6 + 1.3 * Math.sin(3 * a + 0.6) + 2 * (1 - x);
    return [at(foot, 0), at(foot + (crest - foot) * (0.54 + 0.14 * Math.sin(5 * a)), h * (0.4 + 0.19 * Math.cos(3 * a))),
      at(crest, h), at(142, 0.8), at(167 + 8 * Math.cos(2 * a), 3 + 1.8 * Math.sin(4 * a) + 3.4 * (1 - x)), at(188, 0)];
  });
  // 土层本色：坡脚偏草褐，肩部露出蜜色干草，隔谷的下一条脊偏藕灰。
  // 同层以内按实际坡面相对平地多接到多少斜阳取色；不逐面掷随机数，以免像棋盘格。
  const bands = [[0xa99e7a, 0xc9ad79], [0xb4a183, 0xe0bd8a], [0xa29788, 0xc1ab92],
    [0xaf9da4, 0xd2b5a6], [0xab9ba2, 0xc3acac]];
  const sunDir = SUN.clone().normalize();
  const slopeFace = (a: Point, b: Point, c: Point, band: number[]) => {
    const normal = THREE.Triangle.getNormal(new THREE.Vector3(...a), new THREE.Vector3(...b), new THREE.Vector3(...c), new THREE.Vector3());
    const light = THREE.MathUtils.clamp(0.5 + 3 * (normal.dot(sunDir) - sunDir.y), 0, 1);
    const color = new THREE.Color(band[0]).lerp(new THREE.Color(band[1]), light);
    land.triangle(a, b, c, color.getHex());
  };
  sections.forEach((s, i) => {
    const next = sections[(i + 1) % sectors];
    bands.forEach((band, k) => {
      slopeFace(s[k], next[k], next[k + 1], band);
      slopeFace(s[k], next[k + 1], s[k + 1], band);
    });
  });
  const mesh = new THREE.Mesh(land.geometry(), new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, flatShading: true }));
  mesh.name = 'field-earth-and-ridges';
  mesh.receiveShadow = true;
  return mesh;
}

function wheat() {
  const crop = new Facets();
  // 色温留给斜阳；根部掺草黄，迎光穗尖用浅麦秆色，不把整垄刷成橙金色。
  const straw = [0xc3ab70, 0xcab278, 0xc9b675], grain = [0xe3be72, 0xefd084, 0xeaca77];
  function plot(start: number, end: number, boundary: number, outward: number, alongX: boolean) {
    const rows = Math.floor((end - start) / 4);
    const pitch = (end - start) / rows;
    const depth = PLAIN - Math.abs(boundary) - 4;
    for (let row = 0; row < rows; row++) {
      const mid = start + (row + 0.5) * pitch;
      const phase = mid * 0.83 + boundary;
      const point = (u: number, h: number, d: number): Point => {
        const v = boundary + outward * (2 + d);
        return alongX ? [mid + u, h, v] : [v, h, mid + u];
      };
      // 脊线依次经过「窄颈—偏向一侧的穗尖—窄颈」，两翼直接落地，不留木板状的平顶与端墙。
      // 近围栏的一端穗簇较密；各垄错开簇距、起点、宽度和高低，仍限制在自己的田垄宽内。
      const lobes = 5, lead = 0.72 * Math.sin(phase), vigor = 1 + 0.14 * Math.cos(phase);
      const necks = Array.from({ length: lobes + 1 }, (_, j) => {
        const endPoint = j === 0 || j === lobes;
        const t = (j + (endPoint ? 0 : 0.22 * Math.sin(phase + 2.3 * j))) / lobes;
        const d = depth * t * (0.58 + 0.42 * t) + lead * (1 - t);
        const u = pitch * 0.08 * Math.sin(phase + j * 1.6);
        const w = endPoint ? 0 : pitch * (0.32 + 0.07 * Math.cos(phase - j));
        return { u, w, d, left: point(u - w, 0, d), right: point(u + w, 0, d),
          neck: point(u, endPoint ? 0 : 0.29 + 0.1 * Math.sin(phase - j), d) };
      });
      for (let j = 0; j < lobes; j++) {
        const a = necks[j], b = necks[j + 1];
        const t = 0.53 + 0.15 * Math.sin(phase + 2 * j);
        const u = THREE.MathUtils.lerp(a.u, b.u, t) + 0.54 * Math.sin(phase + 3 * j) * THREE.MathUtils.lerp(a.w, b.w, t);
        const tip = point(u, vigor * (1.05 + 0.19 * Math.cos(phase + j)), THREE.MathUtils.lerp(a.d, b.d, t));
        const ear = grain[(row + j) % grain.length], leaf = straw[row % straw.length];
        for (const side of ['left', 'right'] as const) {
          crop.triangle(a[side], tip, b[side], leaf, ear, leaf);
          if (j > 0) crop.triangle(a[side], a.neck, tip, leaf, 0xd8b875, ear);
          if (j + 1 < lobes) crop.triangle(b[side], tip, b.neck, leaf, ear, 0xd8b875);
        }
      }

      // 近端一株供低视角读形：旗叶从茎边分叉，穗肩和穗尖共用同一道棱；它不插在穗面里。
      const u = necks[0].u, d = lead - 0.42, h = vigor * 0.87;
      const collar = point(u + 0.14, h, d);
      crop.face(0xc6aa64, point(u, 0, d), point(u + 0.09, 0, d), collar);
      crop.face(0xcbb672, point(u + 0.07, h * 0.5, d), point(u - 0.15, h * 0.62, d), point(u - 0.31, h * 0.93, d));
      const left = point(u + 0.06, h + 0.19, d), right = point(u + 0.32, h + 0.22, d);
      const keel = point(u + 0.19, h + 0.2, d - 0.09), tip = point(u + 0.31, h + 0.52, d);
      crop.face(0xe4bb6e, collar, left, keel); crop.face(0xe4bb6e, keel, left, tip);
      crop.face(0xf0c46a, collar, keel, right); crop.face(0xf0c46a, right, keel, tip);
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
