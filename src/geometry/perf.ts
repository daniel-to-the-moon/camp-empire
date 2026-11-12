/**
 * 单车性能口径（issue #55 第 1 步）。
 *
 * 两套数字必须分开报：
 * - 网格计数：遍历 Mesh，数网格个数和三角面。现有 tests/geometry.test.ts 用的是这套，
 *   drawCallCount 只是网格数，不是 GPU 上的 draw call。
 * - 运行时：WebGLRenderer.info.render 在 render() 之后的 calls / triangles。
 *   阴影 pass 会把 castShadow 的网格再画一次，所以可以大于网格计数。
 *
 * 加载体积：该车几何缓冲的字节，不是网络包、不是 GLB 文件、不是真机内存。
 * 正式样件未交付，这里只有占位几何。
 */
import * as THREE from 'three';
import type { Variant } from '../data/models';
import { drawCallCount, triangleCount } from './placeholder';

/** 游戏里像素比上限。与 src/client/scene.ts 的 Math.min(devicePixelRatio, 2) 相同。 */
export const PIXEL_RATIO_CAP = 2;

/** 与 src/client/scene.ts 的阴影设置相同：PCF、2048、一盏投射阴影的方向光。 */
export const SCENE_SHADOW = {
  type: 'PCFShadowMap',
  mapSize: 2048,
} as const;

/**
 * 桌面 headless 口径。用来在没有 MacBook 的环境里跑 renderer.info。
 * 不是盛俊的 MacBook（型号待核实），也不能把这里的帧时间写成那台机器的数字。
 */
export interface DeviceProfile {
  id: string;
  label: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  cpuThrottlingRate: number;
  userAgent?: string;
  screenWidth?: number;
  screenHeight?: number;
}

export const DESKTOP_HEADLESS: DeviceProfile = {
  id: 'desktop-headless',
  label: '桌面 headless',
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
  cpuThrottlingRate: 1,
  screenWidth: 1440,
  screenHeight: 900,
};

/**
 * Pixel 6 的 Chrome 模拟参数，不是真机读数。
 * 物理像素 1080×2400。CSS 视口取 1080/2.625≈411.4 → 412，2400/2.625≈914.3 → 915，DPR 2.625。
 * 检索日 2026-11-12，与 https://blisk.io/devices/details/google-pixel-6 的 CSS 视口一致。
 * 社区设备表另有 394×875、DPR 2.74 的写法，两套口径不一致，真机视口仍待核实。
 * CPU 4× 是 Chrome DevTools 的降速预设（Emulation.setCPUThrottlingRate），只拖慢主线程，
 * 不是 Pixel 6 Tensor 的实测倍率，也不代表 GPU。
 */
export const PIXEL6_SIM: DeviceProfile = {
  id: 'pixel6-sim',
  label: 'Pixel 6 模拟',
  width: 412,
  height: 915,
  deviceScaleFactor: 2.625,
  mobile: true,
  cpuThrottlingRate: 4,
  screenWidth: 1080,
  screenHeight: 2400,
  userAgent:
    'Mozilla/5.0 (Linux; Android 13; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
};

/** 探针默认车：issue 点名的 SH5043 同系占位变体，不是正式样件。 */
export const PROBE_VARIANT_ID = 'SH5043XLJH9DB-C_3116';

export interface MeshCensus {
  meshes: number;
  triangles: number;
  shadowCasters: number;
  shadowTriangles: number;
}

export interface RuntimeDraw {
  calls: number;
  triangles: number;
  lines: number;
  points: number;
}

export interface ByteBreakdown {
  total: number;
  byAttribute: Record<string, number>;
}

/** 网格计数口径，外加「会进阴影 pass」的网格和三角面。 */
export function meshCensus(root: THREE.Object3D): MeshCensus {
  let shadowCasters = 0;
  let shadowTriangles = 0;
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.castShadow) return;
    shadowCasters += 1;
    const g = mesh.geometry;
    shadowTriangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return {
    meshes: drawCallCount(root),
    triangles: triangleCount(root),
    shadowCasters,
    shadowTriangles,
  };
}

/**
 * 阴影关：运行时应等于网格计数。
 * 阴影开：每个 castShadow 网格在阴影 pass 再提交一次（同一份三角面）。
 * 这是探针要核对的关系；若 renderer.info 对不上，以实测为准，不要用本函数盖过实测。
 */
export function expectedRuntime(census: MeshCensus, shadows: boolean): { calls: number; triangles: number } {
  if (!shadows) return { calls: census.meshes, triangles: census.triangles };
  return {
    calls: census.meshes + census.shadowCasters,
    triangles: census.triangles + census.shadowTriangles,
  };
}

export function readRuntime(info: { render: { calls: number; triangles: number; lines: number; points: number } }): RuntimeDraw {
  return {
    calls: info.render.calls,
    triangles: info.render.triangles,
    lines: info.render.lines,
    points: info.render.points,
  };
}

/** 几何缓冲字节。同一 ArrayBuffer 只计一次。不含材质、纹理、JS 包体。 */
export function geometryBytes(root: THREE.Object3D): ByteBreakdown {
  const seen = new Set<ArrayBufferLike>();
  const byAttribute: Record<string, number> = {};
  let total = 0;
  const add = (name: string, array: ArrayBufferView) => {
    const n = array.byteLength;
    byAttribute[name] = (byAttribute[name] ?? 0) + n;
    if (seen.has(array.buffer)) return;
    seen.add(array.buffer);
    total += n;
  };
  const geometries = new Set<THREE.BufferGeometry>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const g = mesh.geometry;
    if (geometries.has(g)) return;
    geometries.add(g);
    for (const [name, attr] of Object.entries(g.attributes)) add(name, attr.array);
    if (g.index) add('index', g.index.array);
  });
  return { total, byAttribute };
}

/**
 * 与 placeholder.ts 轮胎 / 轮毂相同的 CylinderGeometry（默认封口、heightSegments = 1）。
 * 只用来估算「少分段能少多少面」，不改车辆网格。
 */
export function cylinderTriangles(radialSegments: number): number {
  const g = new THREE.CylinderGeometry(1, 1, 1, radialSegments, 1, false);
  const n = (g.index ? g.index.count : g.attributes.position.count) / 3;
  g.dispose();
  return n;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export interface PerfSample {
  label: string;
  shadows: boolean;
  awning: boolean;
  runtime: RuntimeDraw;
  census: MeshCensus;
  bytes: ByteBreakdown;
  /** 运行时减去 expectedRuntime。全 0 表示和「阴影 pass 再画一次」的关系一致。 */
  deltaCalls: number;
  deltaTriangles: number;
}

export function finishSample(
  label: string,
  shadows: boolean,
  awning: boolean,
  root: THREE.Object3D,
  runtime: RuntimeDraw,
): PerfSample {
  const census = meshCensus(root);
  const expected = expectedRuntime(census, shadows);
  return {
    label,
    shadows,
    awning,
    runtime,
    census,
    bytes: geometryBytes(root),
    deltaCalls: runtime.calls - expected.calls,
    deltaTriangles: runtime.triangles - expected.triangles,
  };
}

export interface VariantProbeRow {
  id: string;
  model: string;
  heightM: number;
  hasBrow: boolean;
  censusMeshes: number;
  censusTriangles: number;
  shadowCasters: number;
  bytes: number;
  /** 阴影开、无侧边帐 */
  runtimeCalls: number;
  runtimeTriangles: number;
  deltaCalls: number;
  deltaTriangles: number;
}

export interface FrameTiming {
  warmup: number;
  samples: number;
  medianMs: number;
  minMs: number;
  maxMs: number;
}

export interface DeviceReading {
  userAgent: string;
  /** window.innerWidth。headless 移动模拟下可能和布局视口不一致，真机复测以布局视口为准。 */
  inner: { width: number; height: number };
  /** documentElement.clientWidth，页面布局用的 CSS 视口。 */
  viewport: { width: number; height: number };
  screen: { width: number; height: number };
  visualViewport: { width: number; height: number; scale: number } | null;
  devicePixelRatio: number;
  pixelRatioUsed: number;
  hardwareConcurrency: number;
  webglRenderer: string;
}

export interface PerfReport {
  ok: boolean;
  error?: string;
  probe: 'placeholder-vehicle';
  threeRevision: string;
  measuredAt: string;
  variantId: string;
  /** 帧时间是主线程上 render() 的墙钟，不是 GPU 计时，也不是真机帧时间。 */
  frameTiming: FrameTiming | null;
  device: DeviceReading | null;
  /** 车体阴影关、车体阴影开、车体+侧边帐阴影关、车体+侧边帐阴影开 */
  samples: PerfSample[];
  variants?: VariantProbeRow[];
}

export function probeRow(v: Variant, sample: PerfSample): VariantProbeRow {
  return {
    id: v.id,
    model: v.model,
    heightM: v.heightM,
    hasBrow: v.hasBrow,
    censusMeshes: sample.census.meshes,
    censusTriangles: sample.census.triangles,
    shadowCasters: sample.census.shadowCasters,
    bytes: sample.bytes.total,
    runtimeCalls: sample.runtime.calls,
    runtimeTriangles: sample.runtime.triangles,
    deltaCalls: sample.deltaCalls,
    deltaTriangles: sample.deltaTriangles,
  };
}
