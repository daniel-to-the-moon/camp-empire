/**
 * 单车性能探针页面（/perf.html）。
 * 只渲染一辆占位车，读取 WebGLRenderer.info，并和网格计数对照。
 * 不接新参数，不加载正式样件，不改营地场景。
 */
import * as THREE from 'three';
import { ALL_VARIANTS, findVariant, type Variant } from '../data/models';
import {
  PIXEL_RATIO_CAP,
  PROBE_VARIANT_ID,
  SCENE_SHADOW,
  finishSample,
  median,
  probeRow,
  readRuntime,
  type DeviceReading,
  type FrameTiming,
  type PerfReport,
  type PerfSample,
  type VariantProbeRow,
} from '../geometry/perf';
import { buildPlaceholderVehicle, buildSideAwning } from '../geometry/placeholder';
import { SIDE_AWNING } from '../shared/config';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const mat of mats) mat.dispose();
  });
}

function reveal(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) mesh.frustumCulled = false;
  });
}

function createRenderer(host: HTMLElement): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true, failIfMajorPerformanceCaveat: false });
  renderer.setClearColor(0xa9cbc3);
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const raw = window.devicePixelRatio || 1;
  renderer.setPixelRatio(Math.min(raw, PIXEL_RATIO_CAP));
  const width = Math.max(host.clientWidth, 64);
  const height = Math.max(host.clientHeight, 64);
  renderer.setSize(width, height, false);
  host.appendChild(renderer.domElement);
  return renderer;
}

function createStage(aspect: number): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; sun: THREE.DirectionalLight } {
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff4e0, 0x3d5a40, 1.15));
  const sun = new THREE.DirectionalLight(0xffe2b8, 2.2);
  sun.position.set(-30, 50, 20);
  sun.castShadow = true;
  sun.shadow.mapSize.set(SCENE_SHADOW.mapSize, SCENE_SHADOW.mapSize);
  Object.assign(sun.shadow.camera, { left: -45, right: 45, top: 45, bottom: -45, far: 150 });
  scene.add(sun);
  const camera = new THREE.PerspectiveCamera(35, aspect, 0.1, 100);
  camera.position.set(7, 3.2, 8);
  camera.lookAt(0, 1.3, 0);
  return { scene, camera, sun };
}

function deviceReading(renderer: THREE.WebGLRenderer): DeviceReading {
  const gl = renderer.getContext();
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const webglRenderer = ext
    ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL))
    : String(gl.getParameter(gl.RENDERER));
  const visual = window.visualViewport;
  return {
    userAgent: navigator.userAgent,
    inner: { width: window.innerWidth, height: window.innerHeight },
    viewport: { width: document.documentElement.clientWidth, height: document.documentElement.clientHeight },
    screen: { width: window.screen.width, height: window.screen.height },
    visualViewport: visual ? { width: visual.width, height: visual.height, scale: visual.scale } : null,
    devicePixelRatio: window.devicePixelRatio || 1,
    pixelRatioUsed: renderer.getPixelRatio(),
    hardwareConcurrency: navigator.hardwareConcurrency || 0,
    webglRenderer,
  };
}

function renderSample(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  sun: THREE.DirectionalLight,
  root: THREE.Object3D,
  label: string,
  shadows: boolean,
  awning: boolean,
): PerfSample {
  renderer.shadowMap.enabled = shadows;
  sun.castShadow = shadows;
  renderer.info.reset();
  renderer.render(scene, camera);
  return finishSample(label, shadows, awning, root, readRuntime(renderer.info));
}

function timeFrames(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  frames: number,
): FrameTiming {
  const warmup = 5;
  for (let i = 0; i < warmup; i++) renderer.render(scene, camera);
  const samples: number[] = [];
  for (let i = 0; i < frames; i++) {
    const t0 = performance.now();
    renderer.render(scene, camera);
    samples.push(performance.now() - t0);
  }
  return {
    warmup,
    samples: samples.length,
    medianMs: median(samples),
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
  };
}

/** 阴影开、无侧边帐的一行，给全变体对照表用。 */
function measureShadowRow(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  sun: THREE.DirectionalLight,
  variant: Variant,
): VariantProbeRow {
  const { root } = buildPlaceholderVehicle(variant);
  reveal(root);
  scene.add(root);
  const sample = renderSample(renderer, scene, camera, sun, root, variant.id, true, false);
  const row = probeRow(variant, sample);
  scene.remove(root);
  disposeObject(root);
  return row;
}

function measureSelected(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  sun: THREE.DirectionalLight,
  variant: Variant,
  frames: number,
): { samples: PerfSample[]; frameTiming: FrameTiming } {
  const { root, anchors } = buildPlaceholderVehicle(variant);
  reveal(root);
  scene.add(root);
  const bareOff = renderSample(renderer, scene, camera, sun, root, '车体，阴影关', false, false);
  const bareOn = renderSample(renderer, scene, camera, sun, root, '车体，阴影开', true, false);
  const frameTiming = timeFrames(renderer, scene, camera, frames);
  const awning = buildSideAwning(variant, SIDE_AWNING.depthM);
  reveal(awning);
  anchors.side_awning.add(awning);
  const awningOff = renderSample(renderer, scene, camera, sun, root, '车体 + 侧边帐，阴影关', false, true);
  const awningOn = renderSample(renderer, scene, camera, sun, root, '车体 + 侧边帐，阴影开', true, true);
  anchors.side_awning.remove(awning);
  disposeObject(awning);
  scene.remove(root);
  disposeObject(root);
  return { samples: [bareOff, bareOn, awningOff, awningOn], frameTiming };
}

function fmt(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch] ?? ch);
}

function paint(report: PerfReport): void {
  const banner = $('banner');
  const headless = /Headless|SwiftShader|llvmpipe|Mesa/i.test(
    `${report.device?.userAgent ?? ''} ${report.device?.webglRenderer ?? ''}`,
  );
  if (!report.ok) {
    banner.textContent = report.error ?? '探针失败';
    return;
  }
  if (headless) {
    banner.textContent = '这是 headless 或软件光栅的读数，不能填进 MacBook / Pixel 6 真机栏。占位几何，不是正式样件。';
  }
  const copy = report.samples.find((s) => s.shadows && !s.awning);
  const copyEl = $('copy');
  if (copy) {
    copyEl.innerHTML = `
      <dt>运行时三角面（renderer.info.render.triangles）</dt><dd>${fmt(copy.runtime.triangles)}</dd>
      <dt>运行时 draw call（renderer.info.render.calls）</dt><dd>${fmt(copy.runtime.calls)}</dd>
      <dt>加载体积（几何缓冲字节）</dt><dd>${copy.bytes.total} 字节</dd>
      <dt>网格计数（对照，不是 draw call）</dt><dd>${copy.census.meshes} 个网格，${fmt(copy.census.triangles)} 三角面</dd>`;
  }
  $('compare').innerHTML = report.samples
    .map(
      (s) => `<section class="sample"><h3>${esc(s.label)}</h3>
        <p>运行时 ${fmt(s.runtime.triangles)} 三角面，${fmt(s.runtime.calls)} draw call</p>
        <p>网格计数 ${s.census.meshes} 个网格，${fmt(s.census.triangles)} 三角面</p>
        <p>加载体积 ${s.bytes.total} 字节</p>
        <p>与「阴影再画一次」的差：calls ${fmt(s.deltaCalls)}，三角面 ${fmt(s.deltaTriangles)}</p></section>`,
    )
    .join('');
  const d = report.device;
  const frame = report.frameTiming;
  $('device').innerHTML = d
    ? `       <dt>UA</dt><dd>${esc(d.userAgent)}</dd>
       <dt>布局视口</dt><dd>${d.viewport.width} × ${d.viewport.height} CSS 像素${d.inner.width === d.viewport.width && d.inner.height === d.viewport.height ? '' : `（innerWidth ${d.inner.width} × ${d.inner.height}，与布局视口不同）`}</dd>
       <dt>screen</dt><dd>${d.screen.width} × ${d.screen.height}</dd>
       <dt>devicePixelRatio / 实际使用</dt><dd>${d.devicePixelRatio} / ${d.pixelRatioUsed}（上限 ${PIXEL_RATIO_CAP}）</dd>
       <dt>hardwareConcurrency</dt><dd>${d.hardwareConcurrency}</dd>
       <dt>WebGL 渲染器</dt><dd>${esc(d.webglRenderer)}</dd>
       <dt>主线程 render() 中位帧时间</dt><dd>${frame ? `${frame.medianMs.toFixed(2)} ms（预热 ${frame.warmup} 帧后 ${frame.samples} 帧，最小 ${frame.minMs.toFixed(2)}，最大 ${frame.maxMs.toFixed(2)}）` : '—'}。这是墙钟，不是 GPU 计时，也不是真机帧时间。</dd>`
    : '';
}

function publish(report: PerfReport): void {
  $('perf-report').textContent = JSON.stringify(report);
  document.documentElement.dataset.perfReady = '1';
}

function fail(message: string): void {
  const report: PerfReport = {
    ok: false,
    error: message,
    probe: 'placeholder-vehicle',
    threeRevision: THREE.REVISION,
    measuredAt: new Date().toISOString(),
    variantId: PROBE_VARIANT_ID,
    frameTiming: null,
    device: null,
    samples: [],
  };
  paint(report);
  publish(report);
}

function main(): void {
  const params = new URLSearchParams(location.search);
  const variantId = params.get('variant') ?? PROBE_VARIANT_ID;
  const frames = Math.min(120, Math.max(1, Number(params.get('frames')) || 30));
  const wantAll = params.has('all');
  const select = $('variant') as HTMLSelectElement;
  for (const variant of ALL_VARIANTS) {
    const option = document.createElement('option');
    option.value = variant.id;
    option.textContent = `${variant.model} ${variant.roofLabel}`;
    option.selected = variant.id === variantId;
    select.appendChild(option);
  }
  select.addEventListener('change', () => {
    const next = new URLSearchParams(location.search);
    next.set('variant', select.value);
    next.delete('all');
    location.search = next.toString();
  });

  const variant = findVariant(variantId);
  if (!variant) {
    fail(`没有这个车型：${variantId}`);
    return;
  }
  const host = $('view');
  let renderer: THREE.WebGLRenderer;
  try {
    renderer = createRenderer(host);
  } catch (err) {
    fail(`WebGL 创建失败：${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!renderer.getContext()) {
    fail('这个环境没有 WebGL，renderer.info 读不到。');
    return;
  }
  const { scene, camera, sun } = createStage(Math.max(host.clientWidth, 64) / Math.max(host.clientHeight, 64));
  const { samples, frameTiming } = measureSelected(renderer, scene, camera, sun, variant, frames);
  let variants: VariantProbeRow[] | undefined;
  if (wantAll) {
    variants = ALL_VARIANTS.map((item) => measureShadowRow(renderer, scene, camera, sun, item));
  }
  const shown = buildPlaceholderVehicle(variant);
  reveal(shown.root);
  scene.add(shown.root);
  renderer.shadowMap.enabled = true;
  sun.castShadow = true;
  renderer.render(scene, camera);
  const report: PerfReport = {
    ok: true,
    probe: 'placeholder-vehicle',
    threeRevision: THREE.REVISION,
    measuredAt: new Date().toISOString(),
    variantId: variant.id,
    frameTiming,
    device: deviceReading(renderer),
    samples,
    variants,
  };
  paint(report);
  publish(report);
}

main();
