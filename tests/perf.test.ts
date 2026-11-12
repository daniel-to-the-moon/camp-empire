import { describe, expect, it } from 'vitest';
import perfHtml from '../perf.html?raw';
import { ALL_VARIANTS, findVariant } from '../src/data/models';
import {
  PIXEL_RATIO_CAP,
  PROBE_VARIANT_ID,
  cylinderTriangles,
  expectedRuntime,
  geometryBytes,
  meshCensus,
} from '../src/geometry/perf';
import { buildPlaceholderVehicle } from '../src/geometry/placeholder';
import { DESKTOP_HEADLESS, PIXEL6_SIM } from '../src/geometry/perf';
import { measure, resolveChrome, type MeasureRun } from '../scripts/perf-measure';

const probe = findVariant(PROBE_VARIANT_ID)!;

describe('占位车网格计数与加载体积', () => {
  const { root } = buildPlaceholderVehicle(probe);
  const census = meshCensus(root);
  const bytes = geometryBytes(root);

  it('SH5043 占位车是 4 个网格，其中 3 个投射阴影', () => {
    expect(census.meshes).toBe(4);
    expect(census.shadowCasters).toBe(3);
    expect(census.triangles).toBeGreaterThan(0);
    expect(census.triangles).toBeLessThanOrEqual(2600);
    expect(census.shadowTriangles).toBeLessThan(census.triangles);
  });

  it('加载体积是几何缓冲字节，属性合计不少于去重后的总字节', () => {
    expect(bytes.total).toBeGreaterThan(0);
    const summed = Object.values(bytes.byAttribute).reduce((sum, n) => sum + n, 0);
    expect(summed).toBeGreaterThanOrEqual(bytes.total);
    expect(bytes.byAttribute.position).toBeGreaterThan(0);
  });

  it('阴影关时期望等于网格计数；阴影开时每个投射网格再算一次', () => {
    expect(expectedRuntime(census, false)).toEqual({ calls: census.meshes, triangles: census.triangles });
    expect(expectedRuntime(census, true)).toEqual({
      calls: census.meshes + census.shadowCasters,
      triangles: census.triangles + census.shadowTriangles,
    });
  });

  it('轮胎 14 段、轮毂 10 段的圆柱三角面（three r187，未改车辆）', () => {
    expect(cylinderTriangles(14)).toBe(56);
    expect(cylinderTriangles(10)).toBe(40);
    expect(cylinderTriangles(8)).toBe(32);
    expect(cylinderTriangles(6)).toBe(24);
  });

  it('25 个变体的网格三角面都不超过现有测试上限', () => {
    for (const variant of ALL_VARIANTS) {
      const built = buildPlaceholderVehicle(variant);
      expect(meshCensus(built.root).meshes).toBeLessThanOrEqual(6);
      expect(meshCensus(built.root).triangles).toBeLessThanOrEqual(2600);
    }
  });
});

describe('探针页面', () => {
  const html = perfHtml;

  it('给体验官留了 /perf.html，上面有要抄的三项和真机步骤', () => {
    expect(html).toContain('/src/client/perf.ts');
    expect(html).toContain('id="perf-report"');
    expect(html).toContain('运行时三角面');
    expect(html).toContain('运行时 draw call');
    expect(html).toContain('加载体积');
    expect(html).toContain('真机复测');
    expect(html).toContain('/perf.html');
    expect(PIXEL_RATIO_CAP).toBe(2);
    expect(DESKTOP_HEADLESS.cpuThrottlingRate).toBe(1);
    expect(PIXEL6_SIM.width).toBe(412);
    expect(PIXEL6_SIM.height).toBe(915);
    expect(PIXEL6_SIM.deviceScaleFactor).toBe(2.625);
    expect(PIXEL6_SIM.cpuThrottlingRate).toBe(4);
  });
});

const chrome = resolveChrome();

describe.skipIf(!chrome)('renderer.info（本机 Chrome；没有 Chrome 的 CI 会跳过）', () => {
  let run: MeasureRun;

  it('桌面 headless 与 Pixel 6 模拟都读到 draw call，且和网格计数对得上', async () => {
    run = await measure({
      chrome: chrome!,
      profiles: [DESKTOP_HEADLESS, PIXEL6_SIM],
      frames: 8,
      all: true,
    });
    expect(run.profiles).toHaveLength(2);
    const [desktop, pixel] = run.profiles;
    expect(desktop!.profile.id).toBe('desktop-headless');
    expect(pixel!.profile.id).toBe('pixel6-sim');
    for (const item of run.profiles) {
      for (const sample of item.report.samples) {
        expect(sample.deltaCalls).toBe(0);
        expect(sample.deltaTriangles).toBe(0);
      }
      const on = item.report.samples.find((sample) => sample.shadows && !sample.awning)!;
      expect(on.runtime.calls).toBe(on.census.meshes + on.census.shadowCasters);
      expect(on.bytes.total).toBeGreaterThan(0);
      expect(item.report.device!.pixelRatioUsed).toBe(Math.min(item.report.device!.devicePixelRatio, PIXEL_RATIO_CAP));
      expect(item.report.variants).toHaveLength(25);
      for (const row of item.report.variants!) {
        expect(row.deltaCalls).toBe(0);
        expect(row.runtimeCalls).toBe(7);
      }
    }
    const desktopOn = desktop!.report.samples.find((sample) => sample.shadows && !sample.awning)!;
    const pixelOn = pixel!.report.samples.find((sample) => sample.shadows && !sample.awning)!;
    expect(pixelOn.runtime.calls).toBe(desktopOn.runtime.calls);
    expect(pixelOn.runtime.triangles).toBe(desktopOn.runtime.triangles);
    expect(pixelOn.bytes.total).toBe(desktopOn.bytes.total);
    expect(pixel!.report.device!.userAgent).toContain('Pixel 6');
    expect(pixel!.report.frameTiming!.samples).toBe(8);
  }, 90_000);
});
