import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { addDuskLandscape } from '../src/client/duskLandscape';
import { GATE, ROAD, STALLS, WORLD } from '../src/shared/camp';
import { followCam, overviewCam } from '../src/shared/camview';

// 只检查几何、布光与分批，不拿网格数冒充整帧 WebGL 计数或视觉评分。
const scene = new THREE.Scene();
const renderer: Pick<THREE.WebGLRenderer, 'toneMapping' | 'toneMappingExposure'> = {
  toneMapping: THREE.NoToneMapping, toneMappingExposure: 1,
};
addDuskLandscape(scene, renderer);
scene.updateMatrixWorld(true);
const earth = scene.getObjectByName('field-earth-and-ridges') as THREE.Mesh;
const wheat = scene.getObjectByName('wheat-rows') as THREE.Mesh;
const clouds = scene.getObjectByName('pink-cloud-banks') as THREE.InstancedMesh;
const down = new THREE.Vector3(0, -1, 0);
const groundAt = (x: number, z: number) =>
  new THREE.Raycaster(new THREE.Vector3(x, 100, z), down).intersectObject(earth, false)[0]?.point.y;

function* triangles(mesh: THREE.Mesh) {
  const { index } = mesh.geometry;
  const pos = mesh.geometry.getAttribute('position');
  const vertex = (i: number) => new THREE.Vector3().fromBufferAttribute(pos, index ? index.getX(i) : i).applyMatrix4(mesh.matrixWorld);
  for (let i = 0; i < (index?.count ?? pos.count); i += 3) yield new THREE.Triangle(vertex(i), vertex(i + 1), vertex(i + 2));
}

describe('黄昏麦田', () => {
  it('四面都有接地的麦垄，整片三角面都避开围栏内与大门外的通道', () => {
    const { minX, maxX, minY, maxY } = WORLD;
    const yard = new THREE.Box3(new THREE.Vector3(minX, -10, -maxY), new THREE.Vector3(maxX, 10, -minY));
    const approach = new THREE.Box3(new THREE.Vector3(GATE.x - GATE.width / 2, -10, -minY),
      new THREE.Vector3(GATE.x + GATE.width / 2, 10, 400));
    const roots = new Map<string, THREE.Vector3>();
    for (const tri of triangles(wheat)) {
      if (yard.intersectsTriangle(tri) || approach.intersectsTriangle(tri)) throw new Error(`麦垄侵入通行面：${tri.a.toArray()}`);
      for (const v of [tri.a, tri.b, tri.c]) {
        if (v.y < 0) throw new Error('麦垄穿过地表');
        if (v.y !== 0) continue;
        const side = v.z < -maxY ? '北' : v.z > -minY ? '南' : v.x < minX ? '西' : '东';
        roots.set(side, v);
      }
    }
    expect(roots.size).toBe(4);
    for (const [side, v] of roots) expect(groundAt(v.x, v.z), side).toBeCloseTo(v.y);
  });

  it('田外各方位都有上升的实坡面，田土不铺到车位上', () => {
    for (const s of STALLS) expect(groundAt(s.cx, -s.cy)).toBeUndefined();
    // 半径 130 m 在第一条脊和谷底之间；避开分段顶点，检验实际三角面而非顶点高度。
    for (let i = 0; i < 24; i++) {
      const a = (i + 0.5) * Math.PI / 12;
      expect(groundAt(130 * Math.cos(a), 130 * Math.sin(a))).toBeGreaterThan(0);
    }
  });

  it('斜阳投长影，雾不抹掉俯瞰位的车，天光不遮写前景深度', () => {
    expect(renderer.toneMapping).not.toBe(THREE.NoToneMapping);
    const sun = scene.children.find((o): o is THREE.DirectionalLight => o instanceof THREE.DirectionalLight)!;
    expect(sun.castShadow).toBe(true);
    expect(sun.color.r).toBeGreaterThan(sun.color.b);
    const toSun = sun.position.clone().sub(sun.target.position);
    expect(toSun.y).toBeGreaterThan(0);
    expect(Math.hypot(toSun.x, toSun.z)).toBeGreaterThan(toSun.y); // 竖直物体的地面投影长于本身
    const fog = scene.fog as THREE.Fog;
    const eye = new THREE.Vector3(...overviewCam().pos);
    for (const x of [WORLD.minX, WORLD.maxX]) for (const y of [WORLD.minY, WORLD.maxY]) {
      expect(eye.distanceTo(new THREE.Vector3(x, 0, -y))).toBeLessThan(fog.near);
    }
    const sky = scene.getObjectByName('dusk-sky') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(sky.material.depthWrite).toBe(false);
    expect(sky.material.uniforms.horizon.value).toEqual(fog.color);
    expect(sky.material.uniforms.zenith.value).not.toEqual(fog.color);
  });

  it('沿直道向东跟随时能越过缓丘看到云，不依赖换镜头或禁用雾', () => {
    const w = followCam({ x: 0, y: -ROAD.centerR, h: 1.5, yaw: 0 }); // 约 6 m 长车，与客户端一样取车长 / 4
    const cam = new THREE.PerspectiveCamera(w.fov, 1280 / 800, w.near, 400);
    cam.position.set(...w.pos);
    cam.lookAt(...w.look);
    cam.updateMatrixWorld();
    expect(clouds.isInstancedMesh).toBe(true);
    expect(clouds.count).toBeGreaterThan(1);
    let seen = false;
    for (let i = 0; i < clouds.count; i++) {
      const m = new THREE.Matrix4();
      clouds.getMatrixAt(i, m);
      const center = new THREE.Vector3().setFromMatrixPosition(m).applyMatrix4(clouds.matrixWorld);
      const ndc = center.clone().project(cam);
      if (Math.max(Math.abs(ndc.x), Math.abs(ndc.y), Math.abs(ndc.z)) > 1) continue;
      const ray = new THREE.Raycaster(cam.position, center.clone().sub(cam.position).normalize(), cam.near, cam.far);
      const hits = ray.intersectObjects([earth, clouds]);
      if (hits[0]?.object === clouds) seen = true;
    }
    expect(seen).toBe(true);
  });

  it('天空、坡地、麦田、云各一批，不重复投影；云面数按实例倍数计', () => {
    const meshes: THREE.Mesh[] = [];
    scene.traverse((o) => { if (o instanceof THREE.Mesh) meshes.push(o); });
    expect(meshes).toHaveLength(4);
    let total = 0;
    for (const mesh of meshes) {
      expect(Array.isArray(mesh.material)).toBe(false);
      expect(mesh.castShadow).toBe(false);
      const g = mesh.geometry;
      total += (g.index?.count ?? g.getAttribute('position').count) / 3 * (mesh instanceof THREE.InstancedMesh ? mesh.count : 1);
    }
    // 仅布景的回归上界（提案）：110 垄 × 32 面 + 11 云 × 80 面 + 地形 328 面 + 天空 12 面 = 4740。
    expect(total).toBeLessThanOrEqual(4800);
  });
});
