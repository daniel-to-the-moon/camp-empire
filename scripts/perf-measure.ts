/**
 * 用本机 Chrome 打开 /perf.html，读 WebGLRenderer.info。
 * 先跑桌面 headless，再跑 Pixel 6 视口 + DPR + 4× CPU 降速（模拟，不是真机）。
 *
 *   npm run perf:measure
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { cpus, platform, release, totalmem, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DESKTOP_HEADLESS,
  PIXEL6_SIM,
  PROBE_VARIANT_ID,
  cylinderTriangles,
  type DeviceProfile,
  type PerfReport,
  type PerfSample,
} from '../src/geometry/perf';

export interface MeasureRun {
  chromeVersion: string;
  host: { platform: string; cpu: string; memoryBytes: number };
  profiles: Array<{ profile: DeviceProfile; report: PerfReport }>;
  cylinders: Array<{ radialSegments: number; triangles: number }>;
}

const CANDIDATES = ['/usr/local/bin/google-chrome', '/opt/google/chrome/chrome', 'google-chrome'];

export function resolveChrome(envPath = process.env.CHROME_PATH): string | null {
  const list = envPath ? [envPath] : CANDIDATES;
  for (const bin of list) {
    try {
      accessSync(bin, constants.X_OK);
      return bin;
    } catch {
      /* 下一个候选 */
    }
  }
  return null;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('拿不到空闲端口'));
        return;
      }
      const port = addr.port;
      server.close(() => resolvePort(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

class Cdp {
  private next = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => {
      const text = typeof ev.data === 'string' ? ev.data : String(ev.data);
      const msg = JSON.parse(text) as { id?: number; result?: unknown; error?: { message?: string } };
      if (!msg.id || !this.pending.has(msg.id)) return;
      const waiter = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message ?? 'CDP 错误'));
      else waiter.resolve(msg.result);
    });
  }

  send(method: string, params: object = {}, sessionId?: string): Promise<unknown> {
    const id = ++this.next;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolveResult(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
}

async function waitHttp(url: string): Promise<void> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* 服务还没起来 */
    }
    await sleep(200);
  }
  throw new Error(`页面没有起来：${url}`);
}

async function waitJsonVersion(port: number): Promise<string> {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const body = (await res.json()) as { webSocketDebuggerUrl: string };
        return body.webSocketDebuggerUrl;
      }
    } catch {
      /* 调试端口还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome 调试端口没有起来');
}

function kill(child: ChildProcess | null): void {
  if (!child || child.killed || child.exitCode !== null) return;
  child.kill('SIGKILL');
}

export async function measure(options: {
  chrome: string;
  profiles?: DeviceProfile[];
  frames?: number;
  all?: boolean;
  variantId?: string;
}): Promise<MeasureRun> {
  const profiles: DeviceProfile[] = options.profiles ?? [DESKTOP_HEADLESS, PIXEL6_SIM];
  const frames = options.frames ?? 30;
  const all = options.all ?? true;
  const variantId = options.variantId ?? PROBE_VARIANT_ID;
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const vitePort = await freePort();
  const debugPort = await freePort();
  const userDir = await mkdtemp(`${tmpdir()}/camp-perf-`);
  const page = `http://127.0.0.1:${vitePort}/perf.html`;
  let vite: ChildProcess | null = null;
  let chrome: ChildProcess | null = null;
  let ws: WebSocket | null = null;
  const log: string[] = [];
  try {
    vite = spawn(process.execPath, [resolve(repoRoot, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    vite.stdout?.on('data', (buf: Buffer) => log.push(buf.toString()));
    vite.stderr?.on('data', (buf: Buffer) => log.push(buf.toString()));
    await waitHttp(page);

    chrome = spawn(
      options.chrome,
      [
        '--headless=new',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--enable-unsafe-swiftshader',
        `--remote-debugging-port=${debugPort}`,
        '--remote-allow-origins=*',
        `--user-data-dir=${userDir}`,
        'about:blank',
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    chrome.stderr?.on('data', (buf: Buffer) => log.push(buf.toString()));
    const browserWs = await waitJsonVersion(debugPort);
    ws = new WebSocket(browserWs);
    await new Promise<void>((resolveOpen, reject) => {
      ws!.addEventListener('open', () => resolveOpen());
      ws!.addEventListener('error', () => reject(new Error('连不上 Chrome 调试端口')));
    });
    const cdp = new Cdp(ws);
    const created = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string };
    const attached = (await cdp.send('Target.attachToTarget', { targetId: created.targetId, flatten: true })) as { sessionId: string };
    const sessionId = attached.sessionId;
    if (!sessionId) throw new Error('Chrome 没有返回调试会话');
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);

    const reports: Array<{ profile: DeviceProfile; report: PerfReport }> = [];
    for (const profile of profiles) {
      await cdp.send(
        'Emulation.setDeviceMetricsOverride',
        {
          width: profile.width,
          height: profile.height,
          deviceScaleFactor: profile.deviceScaleFactor,
          mobile: profile.mobile,
          ...(profile.screenWidth && profile.screenHeight
            ? { screenWidth: profile.screenWidth, screenHeight: profile.screenHeight }
            : {}),
        },
        sessionId,
      );
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpuThrottlingRate }, sessionId);
      if (profile.userAgent) {
        await cdp.send('Emulation.setUserAgentOverride', { userAgent: profile.userAgent }, sessionId);
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
      }
      const query = new URLSearchParams({ variant: variantId, frames: String(frames) });
      if (all) query.set('all', '1');
      await cdp.send('Page.navigate', { url: `${page}?${query}` }, sessionId);
      const report = JSON.parse(await waitReport(cdp, sessionId)) as PerfReport;
      if (!report.ok) throw new Error(report.error ?? '探针失败');
      checkProfile(profile, report);
      reports.push({ profile, report });
    }
    const cpu = cpus()[0]?.model ?? '未知';
    return {
      chromeVersion: execFileSync(options.chrome, ['--version'], { encoding: 'utf8' }).trim(),
      host: { platform: `${platform()} ${release()}`, cpu, memoryBytes: totalmem() },
      profiles: reports,
      cylinders: [14, 10, 8, 6].map((radialSegments) => ({ radialSegments, triangles: cylinderTriangles(radialSegments) })),
    };
  } catch (err) {
    const tail = log.join('').slice(-2000);
    throw new Error(`${err instanceof Error ? err.message : String(err)}${tail ? `\n---\n${tail}` : ''}`);
  } finally {
    ws?.close();
    kill(chrome);
    kill(vite);
    await sleep(300);
    await rm(userDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => undefined);
  }
}

async function waitReport(cdp: Cdp, sessionId: string): Promise<string> {
  for (let i = 0; i < 75; i++) {
    const evaluated = (await cdp.send(
      'Runtime.evaluate',
      {
        expression: "document.documentElement.dataset.perfReady === '1' ? (document.getElementById('perf-report')?.textContent ?? '') : ''",
        returnByValue: true,
      },
      sessionId,
    )) as { result?: { value?: string } };
    const value = evaluated.result?.value;
    if (value) return value;
    await sleep(200);
  }
  throw new Error('探针页面没有写出报告');
}

function checkProfile(profile: DeviceProfile, report: PerfReport): void {
  const device = report.device;
  if (!device) throw new Error('报告里没有设备读数');
  const boxes = [device.inner, device.viewport, device.visualViewport].filter((box): box is { width: number; height: number } => box !== null);
  const matched = boxes.some((box) => box.width === profile.width && box.height === profile.height);
  if (!matched) {
    throw new Error(
      `视口期望 ${profile.width}×${profile.height}，inner ${device.inner.width}×${device.inner.height}，布局 ${device.viewport.width}×${device.viewport.height}，visual ${JSON.stringify(device.visualViewport)}，screen ${device.screen.width}×${device.screen.height}，dpr ${device.devicePixelRatio}`,
    );
  }
  if (Math.abs(device.devicePixelRatio - profile.deviceScaleFactor) > 0.02) {
    throw new Error(`devicePixelRatio 期望 ${profile.deviceScaleFactor}，实际 ${device.devicePixelRatio}`);
  }
  if (profile.userAgent && !device.userAgent.includes('Pixel 6')) {
    throw new Error(`UA 没有带上 Pixel 6：${device.userAgent}`);
  }
}

function sampleOf(report: PerfReport, shadows: boolean, awning: boolean): PerfSample {
  const found = report.samples.find((item) => item.shadows === shadows && item.awning === awning);
  if (!found) throw new Error('报告缺样本');
  return found;
}

export function formatRun(run: MeasureRun): string {
  const lines: string[] = [];
  lines.push(`Chrome ${run.chromeVersion}`);
  lines.push(`主机 ${run.host.platform}，CPU ${run.host.cpu}，内存 ${run.host.memoryBytes} 字节`);
  lines.push('这台主机不是 MacBook，也不是 Pixel 6。下面的帧时间是该主机上的主线程墙钟。');
  for (const item of run.profiles) {
    const off = sampleOf(item.report, false, false);
    const on = sampleOf(item.report, true, false);
    const awningOff = sampleOf(item.report, false, true);
    const awning = sampleOf(item.report, true, true);
    const device = item.report.device;
    lines.push('');
    lines.push(`## ${item.profile.label}（${item.profile.id}）`);
    lines.push(
      `参数：视口 ${item.profile.width}×${item.profile.height}，DPR ${item.profile.deviceScaleFactor}，CPU 降速 ${item.profile.cpuThrottlingRate}×，mobile=${item.profile.mobile}`,
    );
    if (device) {
      lines.push(
        `页面读到：布局视口 ${device.viewport.width}×${device.viewport.height}，inner ${device.inner.width}×${device.inner.height}，screen ${device.screen.width}×${device.screen.height}，devicePixelRatio ${device.devicePixelRatio}，渲染器用 ${device.pixelRatioUsed}，hardwareConcurrency ${device.hardwareConcurrency}`,
      );
      lines.push(`UA ${device.userAgent}`);
      lines.push(`WebGL ${device.webglRenderer}`);
    }
    lines.push(`车型 ${item.report.variantId}，three r${item.report.threeRevision}，${item.report.measuredAt}`);
    lines.push(
      `阴影关：运行时 ${off.runtime.triangles} 面 / ${off.runtime.calls} draw call；网格 ${off.census.triangles} 面 / ${off.census.meshes} 网格；差 calls ${off.deltaCalls}、面 ${off.deltaTriangles}；字节 ${off.bytes.total}`,
    );
    lines.push(`阴影开：运行时 ${on.runtime.triangles} 面 / ${on.runtime.calls} draw call；字节 ${on.bytes.total}；差 calls ${on.deltaCalls}、面 ${on.deltaTriangles}`);
    lines.push(`属性字节 ${JSON.stringify(on.bytes.byAttribute)}`);
    lines.push(`加侧边帐、阴影关：运行时 ${awningOff.runtime.triangles} 面 / ${awningOff.runtime.calls} draw call；字节 ${awningOff.bytes.total}；差 calls ${awningOff.deltaCalls}、面 ${awningOff.deltaTriangles}`);
    lines.push(`加侧边帐、阴影开：运行时 ${awning.runtime.triangles} 面 / ${awning.runtime.calls} draw call；字节 ${awning.bytes.total}；差 calls ${awning.deltaCalls}、面 ${awning.deltaTriangles}`);
    const frame = item.report.frameTiming;
    if (frame) lines.push(`主线程 render() 中位 ${frame.medianMs.toFixed(2)} ms（${frame.samples} 帧，最小 ${frame.minMs.toFixed(2)}，最大 ${frame.maxMs.toFixed(2)}）`);
    if (item.report.variants) {
      const tris = item.report.variants.map((row) => row.censusTriangles);
      const calls = item.report.variants.map((row) => row.runtimeCalls);
      const bytes = item.report.variants.map((row) => row.bytes);
      lines.push(
        `25 个变体（阴影开、无帐）网格三角面 ${Math.min(...tris)}–${Math.max(...tris)}，运行时 draw call ${Math.min(...calls)}–${Math.max(...calls)}，字节 ${Math.min(...bytes)}–${Math.max(...bytes)}`,
      );
      for (const row of item.report.variants) {
        lines.push(
          `  ${row.id} 网格 ${row.censusTriangles} 面 / ${row.censusMeshes}，运行时 ${row.runtimeTriangles} 面 / ${row.runtimeCalls} call，字节 ${row.bytes}，差 calls ${row.deltaCalls}`,
        );
      }
    }
  }
  lines.push('');
  lines.push('圆柱分段（与轮胎同一 CylinderGeometry，单个，未改车辆）：');
  for (const row of run.cylinders) lines.push(`  ${row.radialSegments} 段 → ${row.triangles} 三角面`);
  return lines.join('\n');
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const bin = resolveChrome();
  if (!bin) {
    console.error('找不到 Chrome。设置 CHROME_PATH 后再跑 npm run perf:measure。');
    process.exit(1);
  }
  measure({ chrome: bin })
    .then((run) => {
      console.log(formatRun(run));
    })
    .catch((err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
