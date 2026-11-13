/**
 * 泼溅与占位房车的共存点验页。只从这里被 lab/splat.html 引用，游戏入口 src/client/main.ts 不导入本文件。
 * 房车用场景里同一条 makeVehicle（内部是 buildPlaceholderVehicle）。泼溅是 Spark 官方示例，运行时拉取，不入库。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { findVariant } from '../data/models';
import { makeVehicle } from '../client/scene';
import { drawCallCount, triangleCount } from '../geometry/placeholder';

/** Spark 官方示例山谷，见 spark 仓库 examples/assets.json 的 valley.spz。 */
export const SPLAT_URL = 'https://sparkjs.dev/assets/splats/valley.spz';
/** 章程里的主角车候选：SH5043，公告高 3116 mm。 */
const VARIANT_ID = 'SH5043XLJH9DB-C_3116';

// 车停在溪沟 −x 侧的草坡上。相机沿沟的开阔方向（+z，略偏 −x）看，避免钻进两侧树冠。
const VIEWS = {
  overview: { pos: [-2, 8, 20], look: [0, 1.2, 0], bury: 0 },
  front: { pos: [-1.2, 2.5, 11], look: [0, 1.4, 0.4], bury: 0 },
  side: { pos: [-7, 2.7, 2], look: [0, 1.3, 0], bury: 0 },
  rear: { pos: [-2, 3, -9], look: [0, 1.4, 0], bury: 0 },
  low: { pos: [-1.4, 0.8, 6.5], look: [0, 0.5, 0.8], bury: 0 },
  bury: { pos: [-2.4, 0.65, 3.8], look: [-0.2, 0.28, 0.3], bury: 0.7 },
} as const;

type ViewName = keyof typeof VIEWS;

interface FrameSample {
  elapsedMs: number;
  frames: number;
  fps: number;
  frameMs: { p50: number; p95: number; max: number };
  calls: { min: number; p50: number; max: number };
  trianglesP50: number;
}

interface LabFacts {
  gpu: string;
  antialias: boolean;
  shadowMap: boolean;
  splatCount: number;
  splatUrl: string;
  splatTransferBytes: number | null;
  bbox: { min: [number, number, number]; max: [number, number, number] };
  ground: { x: number; y: number; z: number; samples: number };
  vehicle: { id: string; triangles: number; meshDrawCalls: number };
  canvas: { cssWidth: number; cssHeight: number; pixelWidth: number; pixelHeight: number; pixelRatio: number };
}

const params = new URLSearchParams(location.search);
const antialias = params.get('aa') !== '0';
const showHud = params.get('hud') !== '0';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const stage = $('stage');
const hud = $('hud');
const readout = $('readout');
const statusEl = $('status');
const buryInput = $('bury') as HTMLInputElement;
const buryLabel = $('bury-label');
if (!showHud) hud.hidden = true;

function setStatus(text: string) {
  statusEl.hidden = false;
  statusEl.textContent = text;
}

const variant = findVariant(VARIANT_ID);
if (!variant) throw new Error(`找不到车型 ${VARIANT_ID}`);
const vehicle = makeVehicle(variant);
const vehicleTris = triangleCount(vehicle.root);
const vehicleDraws = drawCallCount(vehicle.root);

const renderer = new THREE.WebGLRenderer({ antialias, alpha: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.setClearColor(0x8ea4b0, 1);
renderer.shadowMap.enabled = false;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, 1, 0.05, 2000);
scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3d5a40, 1.15));
const sun = new THREE.DirectionalLight(0xffe2b8, 2.2);
sun.position.set(-30, 50, 20);
scene.add(sun);

const spark = new SparkRenderer({ renderer });
scene.add(spark);

const splat = new SplatMesh({
  url: SPLAT_URL,
  raycastable: true,
  onProgress: (event) => {
    if (!event.lengthComputable || event.total <= 0) return;
    splatBytes = event.total;
    setStatus(`正在拉取泼溅 ${Math.floor((100 * event.loaded) / event.total)}%`);
  },
});
// 与 Spark 官方 mobile-joystick / valley 示例相同：绕 X 轴 180°，把扫描坐标翻成 Y 朝上。
splat.quaternion.set(1, 0, 0, 0);
splat.position.set(0, 0, -3);
scene.add(splat);
scene.add(vehicle.root);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
controls.target.set(0, 1.4, -3);

const anchor = new THREE.Vector3();
let buryM = 0;
let splatCount = 0;
let splatBytes: number | null = null;
let ground = { x: 0, y: 0, z: -3, samples: 0 };
let bbox = { min: [0, 0, 0] as [number, number, number], max: [0, 0, 0] as [number, number, number] };

function resize() {
  const w = stage.clientWidth || window.innerWidth;
  const h = stage.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / Math.max(h, 1);
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(stage);
resize();

function applyVehicleHeight() {
  vehicle.root.position.set(anchor.x, anchor.y - buryM, anchor.z);
}

function setView(name: ViewName) {
  const view = VIEWS[name];
  buryM = view.bury;
  buryInput.value = String(buryM);
  buryLabel.textContent = `${buryM.toFixed(2)} m`;
  applyVehicleHeight();
  camera.position.set(anchor.x + view.pos[0], anchor.y + view.pos[1], anchor.z + view.pos[2]);
  controls.target.set(anchor.x + view.look[0], anchor.y + view.look[1], anchor.z + view.look[2]);
  camera.near = 0.05;
  camera.far = Math.max(2000, camera.position.distanceTo(controls.target) * 40);
  camera.updateProjectionMatrix();
  controls.update();
}

function setSplatVisible(on: boolean) {
  const toggle = $('splat-toggle');
  toggle.setAttribute('aria-pressed', on ? 'true' : 'false');
  toggle.textContent = on ? '泼溅开' : '泼溅关';
  if (on) {
    if (!splat.parent) scene.add(splat);
    splat.visible = true;
  } else if (splat.parent) {
    scene.remove(splat);
  }
}

function vec3(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}

/**
 * 抽稀扫一遍泼溅中心。原点附近是溪沟，整片平均会把车悬在水上，所以按 2 m 格子挑一块
 * 比最低处高出一截、又比较平的地面，把车原点（轮胎接地点）放上去。
 */
function placeOnSplatGround() {
  const total = splat.splats?.getNumSplats() ?? 0;
  splatCount = total;
  const step = Math.max(1, Math.floor(total / 60000));
  splat.updateMatrixWorld(true);
  const world = splat.matrixWorld;
  const p = new THREE.Vector3();
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  const cells = new Map<string, Array<{ x: number; y: number; z: number }>>();
  splat.forEachSplat((index, center, _scales, _quaternion, opacity) => {
    if (index % step !== 0 || opacity < 0.15) return;
    p.copy(center).applyMatrix4(world);
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) return;
    min.min(p);
    max.max(p);
    if (Math.hypot(p.x, p.z) > 18) return;
    const key = `${Math.round(p.x / 2)}:${Math.round(p.z / 2)}`;
    const bucket = cells.get(key);
    const point = { x: p.x, y: p.y, z: p.z };
    if (bucket) bucket.push(point);
    else cells.set(key, [point]);
  });
  bbox = { min: vec3(min), max: vec3(max) };
  const flats: Array<{ x: number; y: number; z: number; n: number }> = [];
  for (const points of cells.values()) {
    if (points.length < 20) continue;
    const ys = points.map((point) => point.y).sort((a, b) => a - b);
    const y = ys[Math.floor(ys.length * 0.2)];
    const spread = ys[Math.floor(ys.length * 0.8)] - y;
    if (spread > 1.2) continue;
    const on = points.filter((point) => Math.abs(point.y - y) <= 0.3);
    const used = on.length > 0 ? on : points;
    flats.push({
      x: used.reduce((sum, point) => sum + point.x, 0) / used.length,
      y,
      z: used.reduce((sum, point) => sum + point.z, 0) / used.length,
      n: used.length,
    });
  }
  if (flats.length > 0) {
    const lowest = Math.min(...flats.map((cell) => cell.y));
    const banks = flats.filter((cell) => cell.y >= lowest + 0.35);
    const pool = banks.length > 0 ? banks : flats;
    // 原点落在溪沟里。开阔草坡在 −x，挑那一侧最近的一格，避免车悬在水面上。
    const meadow = pool.filter((cell) => cell.x <= -3 && cell.x >= -8);
    const ranked = (meadow.length > 0 ? meadow : pool).sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z));
    const pick = ranked[0];
    ground = { x: pick.x, y: pick.y, z: pick.z, samples: pick.n };
  } else {
    ground = { x: 0, y: 0, z: -3, samples: 0 };
  }
  anchor.set(ground.x, ground.y, ground.z);
  const diag = Number.isFinite(min.x) ? min.distanceTo(max) : 100;
  controls.maxDistance = Math.max(80, diag);
  camera.far = Math.max(2000, diag * 4);
  camera.updateProjectionMatrix();
}

function gpuString(): string {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  if (!ext) return 'WEBGL_debug_renderer_info 不可用';
  const vendor = gl.getParameter(ext.UNMASKED_VENDOR_WEBGL);
  const name = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  return `${vendor} | ${name}`;
}

function splatTransferBytes(): number | null {
  return splatBytes;
}

function facts(): LabFacts {
  return {
    gpu: gpuString(),
    antialias,
    shadowMap: renderer.shadowMap.enabled,
    splatCount,
    splatUrl: SPLAT_URL,
    splatTransferBytes: splatTransferBytes(),
    bbox,
    ground,
    vehicle: { id: VARIANT_ID, triangles: vehicleTris, meshDrawCalls: vehicleDraws },
    canvas: {
      cssWidth: stage.clientWidth,
      cssHeight: stage.clientHeight,
      pixelWidth: renderer.domElement.width,
      pixelHeight: renderer.domElement.height,
      pixelRatio: renderer.getPixelRatio(),
    },
  };
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

interface RenderInfo {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
}

let lastInfo: RenderInfo = { calls: 0, triangles: 0, points: 0, lines: 0 };
let frameHook: ((now: number) => void) | null = null;
let frames = 0;
let fpsStamp = performance.now();
let fpsFrames = 0;
let rollingFps = 0;

renderer.setAnimationLoop((now: number) => {
  controls.update();
  renderer.render(scene, camera);
  const render = renderer.info.render;
  lastInfo = { calls: render.calls, triangles: render.triangles, points: render.points, lines: render.lines };
  frames += 1;
  fpsFrames += 1;
  const span = now - fpsStamp;
  if (span >= 500) {
    rollingFps = (fpsFrames * 1000) / span;
    fpsFrames = 0;
    fpsStamp = now;
    paintHud();
  }
  frameHook?.(now);
});

function paintHud() {
  if (!showHud || statusEl.hidden === false) return;
  const info = lastInfo;
  readout.textContent = [
    `车型 ${VARIANT_ID}`,
    `占位网格 ${vehicleTris} 三角面 / ${vehicleDraws} 个网格`,
    `泼溅 ${splatCount} 个`,
    `地面约 (${ground.x.toFixed(2)}, ${ground.y.toFixed(2)}, ${ground.z.toFixed(2)})`,
    `帧率 ${rollingFps.toFixed(1)}（滚动 0.5 s）`,
    `renderer.info 调用 ${info.calls} / 三角 ${info.triangles} / 点 ${info.points}`,
    `画布 ${renderer.domElement.width}×${renderer.domElement.height} 像素，比例 ${renderer.getPixelRatio()}`,
  ].join('\n');
}

const minFramesParam = Number(params.get('minFrames'));
function sample(ms: number, orbit: boolean, minFrames = Number.isFinite(minFramesParam) && minFramesParam > 0 ? minFramesParam : 8): Promise<FrameSample> {
  return new Promise((resolve) => {
    const savedPos = camera.position.clone();
    const savedTarget = controls.target.clone();
    const frameMs: number[] = [];
    const calls: number[] = [];
    const triangles: number[] = [];
    let last = performance.now();
    let start = 0;
    let warmed = 0;
    controls.autoRotate = orbit;
    controls.autoRotateSpeed = 1;
    frameHook = (now) => {
      const dt = now - last;
      last = now;
      if (warmed < 2) {
        warmed += 1;
        return;
      }
      if (start === 0) start = now;
      frameMs.push(dt);
      calls.push(lastInfo.calls);
      triangles.push(lastInfo.triangles);
      const slow = dt > 250;
      if (frameMs.length >= minFrames && (now - start >= ms || slow)) {
        frameHook = null;
        controls.autoRotate = false;
        camera.position.copy(savedPos);
        controls.target.copy(savedTarget);
        controls.update();
        const elapsedMs = now - start;
        resolve({
          elapsedMs,
          frames: frameMs.length,
          fps: frameMs.length / (elapsedMs / 1000),
          frameMs: { p50: quantile(frameMs, 0.5), p95: quantile(frameMs, 0.95), max: Math.max(...frameMs) },
          calls: { min: Math.min(...calls), p50: quantile(calls, 0.5), max: Math.max(...calls) },
          trianglesP50: quantile(triangles, 0.5),
        });
      }
    };
  });
}

interface FrameRow {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  splat: boolean;
}

/** 逐帧记下 renderer.info。先空等若干帧，避开切换泼溅后排序还没更新的那几帧。 */
function trace(n: number): Promise<FrameRow[]> {
  return new Promise((resolve) => {
    const rows: FrameRow[] = [];
    frameHook = () => {
      rows.push({ ...lastInfo, splat: splat.parent != null });
      if (rows.length >= n) {
        frameHook = null;
        resolve(rows);
      }
    };
  });
}

function summarizeRows(rows: FrameRow[]) {
  const calls = rows.map((row) => row.calls);
  const triangles = rows.map((row) => row.triangles);
  return {
    frames: rows,
    calls: { min: Math.min(...calls), p50: quantile(calls, 0.5), max: Math.max(...calls) },
    trianglesP50: quantile(triangles, 0.5),
  };
}

async function measureDraws() {
  setView('front');
  setSplatVisible(true);
  await waitFrames(6);
  const withSplat = summarizeRows(await trace(4));
  setSplatVisible(false);
  await waitFrames(6);
  const withoutSplat = summarizeRows(await trace(4));
  setSplatVisible(true);
  return { withSplat, withoutSplat };
}

function waitFrames(n: number): Promise<void> {
  const seen = frames;
  return new Promise((resolve) => {
    frameHook = () => {
      if (frames - seen >= n) {
        frameHook = null;
        resolve();
      }
    };
  });
}

hud.addEventListener('click', (event) => {
  const button = (event.target as HTMLElement).closest('button');
  if (!button) return;
  const view = button.dataset.view as ViewName | undefined;
  if (view) setView(view);
  if (button.id === 'splat-toggle') setSplatVisible(button.getAttribute('aria-pressed') !== 'true');
});
buryInput.addEventListener('input', () => {
  buryM = Number(buryInput.value);
  buryLabel.textContent = `${buryM.toFixed(2)} m`;
  applyVehicleHeight();
});

const initialView = (params.get('view') ?? 'front') as ViewName;
const startView: ViewName = initialView in VIEWS ? initialView : 'front';

const ready = splat.initialized.then(async () => {
  setStatus('正在把房车放到泼溅地面上…');
  placeOnSplatGround();
  setView(startView);
  if (params.has('bury') && startView !== 'bury') {
    buryM = Number(params.get('bury'));
    buryInput.value = String(buryM);
    buryLabel.textContent = `${buryM.toFixed(2)} m`;
    applyVehicleHeight();
  }
  await waitFrames(8);
  statusEl.hidden = true;
  paintHud();
}).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`泼溅加载失败：${message}`);
  throw error;
});

const lab = {
  ready,
  facts,
  setView,
  setSplatVisible,
  setBury(meters: number) {
    buryM = meters;
    buryInput.value = String(meters);
    buryLabel.textContent = `${meters.toFixed(2)} m`;
    applyVehicleHeight();
  },
  sample,
  measureDraws,
  settle: () => waitFrames(4),
};
Object.assign(window, { __lab: lab });

declare global {
  interface Window {
    __lab: typeof lab;
  }
}
