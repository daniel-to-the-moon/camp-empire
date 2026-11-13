/**
 * 泼溅点验的测量脚本：拉起 lab 开发服务器和本机 headless Chrome，读页面上的 window.__lab。
 * 帧率是这个虚拟机里的实测。Chrome 这里只有 SwiftShader 软件 WebGL，再叠加移动端视口和 CPU 降速，
 * 不是玩家的桌面显卡，也不是真机。
 */
import { spawn } from 'node:child_process';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';

const LAB = 'http://127.0.0.1:5174/lab/splat.html';
const ARTIFACTS = '/opt/cursor/artifacts';
const CHROME_PORT = 9333;

function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let nextId = 0;
  const pending = new Map();
  const listeners = new Map();
  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error(`调试通道打不开 ${wsUrl}`)));
  });
  ws.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message || JSON.stringify(message.error)));
      else resolve(message.result);
    } else if (message.method) {
      for (const fn of listeners.get(message.method) ?? []) fn(message.params);
    }
  });
  return {
    ready: opened,
    on(method, fn) {
      const list = listeners.get(method) ?? [];
      list.push(fn);
      listeners.set(method, list);
    },
    send(method, params = {}, timeoutMs = 360000) {
      const id = ++nextId;
      return opened.then(() => new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP 超时 ${method}`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (error) => { clearTimeout(timer); reject(error); },
        });
        ws.send(JSON.stringify({ id, method, params }));
      }));
    },
    close() {
      ws.close();
    },
  };
}

async function waitFor(label, fn, tries = 50) {
  let last = '还没开始';
  for (let i = 0; i < tries; i++) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await delay(200);
  }
  throw new Error(`${label} 超时：${last}`);
}

function startServer() {
  const child = spawn('npm', ['run', 'lab'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (chunk) => { log += chunk; });
  child.stderr.on('data', (chunk) => { log += chunk; });
  return {
    child,
    log: () => log,
    stop() { child.kill('SIGTERM'); },
  };
}

function startChrome() {
  const child = spawn('/usr/bin/google-chrome-stable', [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    '--use-angle=swiftshader',
    `--remote-debugging-port=${CHROME_PORT}`,
    '--user-data-dir=/tmp/splat-lab-chrome',
    '--window-size=1280,720',
    '--disable-extensions',
    '--hide-scrollbars',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stderr.on('data', (chunk) => { log += chunk; });
  return {
    child,
    log: () => log,
    stop() { child.kill('SIGKILL'); },
  };
}

async function attachPage() {
  const page = await waitFor('Chrome 调试页', async () => {
    const list = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`).then((res) => res.json());
    return list.find((item) => item.type === 'page' && item.webSocketDebuggerUrl);
  });
  const client = cdp(page.webSocketDebuggerUrl);
  await client.ready;
  const logs = [];
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  client.on('Runtime.consoleAPICalled', (params) => {
    const text = params.args.map((arg) => arg.value ?? arg.description ?? '').join(' ');
    logs.push(`${params.type}: ${text}`);
    console.log(`[page:${params.type}] ${text}`);
  });
  client.on('Runtime.exceptionThrown', (params) => {
    const text = params.exceptionDetails.exception?.description || params.exceptionDetails.text;
    logs.push(`exception: ${text}`);
    console.error(`[page:exception] ${text}`);
  });
  return { client, logs };
}

async function evaluate(client, expression, timeoutMs = 300000) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }, timeoutMs);
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail);
  }
  return result.result.value;
}

async function shot(client, file) {
  const { data } = await client.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(file, Buffer.from(data, 'base64'));
  console.log('截图', file);
}

async function scenario(client, { name, query, width, height, deviceScaleFactor, mobile, cpu, views }) {
  await client.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  await client.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await client.send('Page.navigate', { url: `${LAB}${query}` });
  console.log(`打开 ${name}`);
  const facts = await evaluate(client, `new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.__lab) {
        window.__lab.ready.then(() => resolve(window.__lab.facts())).catch(reject);
        return;
      }
      if (Date.now() - started > 90000) reject(new Error('页面没有 __lab'));
      else setTimeout(tick, 100);
    };
    tick();
  })`);
  console.log(name, 'facts', JSON.stringify(facts));
  const shots = [];
  for (const view of views) {
    await evaluate(client, `window.__lab.setView(${JSON.stringify(view)}); window.__lab.settle()`);
    await delay(600);
    const file = `${ARTIFACTS}/splat_${name}_${view}.png`;
    await shot(client, file);
    shots.push(file);
  }
  let meshShot = null;
  if (name === 'desktop') {
    await evaluate(client, `window.__lab.setView('side'); window.__lab.setSplatVisible(false); window.__lab.settle()`);
    meshShot = `${ARTIFACTS}/splat_desktop_mesh.png`;
    await shot(client, meshShot);
    await evaluate(client, `window.__lab.setSplatVisible(true)`);
  }
  const fps = await evaluate(client, 'window.__lab.sample(5000, true)');
  console.log(name, 'fps', JSON.stringify(fps));
  let draws = null;
  if (name === 'desktop') {
    draws = await evaluate(client, 'window.__lab.measureDraws()');
    console.log(name, 'draws', JSON.stringify(draws));
  }
  return { name, query, width, height, deviceScaleFactor, mobile, cpuRate: cpu, facts, shots, meshShot, fps, draws };
}

await rm('/tmp/splat-lab-chrome', { recursive: true, force: true });
const server = startServer();
const chrome = startChrome();
try {
  await mkdir(ARTIFACTS, { recursive: true });
  await waitFor('lab 页面', async () => {
    const res = await fetch(LAB);
    return res.ok;
  });
  const splatHead = await fetch('https://sparkjs.dev/assets/splats/valley.spz', { method: 'HEAD' });
  const version = await waitFor('Chrome 版本', () => fetch(`http://127.0.0.1:${CHROME_PORT}/json/version`).then((res) => res.json()));
  const { client, logs } = await attachPage();
  const desktop = await scenario(client, {
    name: 'desktop',
    query: '?hud=0&aa=1',
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    cpu: 1,
    views: ['overview', 'front', 'side', 'rear', 'low', 'bury'],
  });
  const desktopNoAa = await scenario(client, {
    name: 'desktop_noaa',
    query: '?hud=0&aa=0',
    width: 1280,
    height: 720,
    deviceScaleFactor: 1,
    mobile: false,
    cpu: 1,
    views: [],
  });
  const mobile = await scenario(client, {
    name: 'mobile_sim',
    query: '?hud=0&aa=1&minFrames=4',
    width: 412,
    height: 915,
    deviceScaleFactor: 2.625,
    mobile: true,
    cpu: 4,
    views: ['front', 'bury'],
  });
  const report = {
    measuredAt: new Date().toISOString(),
    chrome: version.Browser,
    valleyContentLength: splatHead.headers.get('content-length'),
    valleyContentType: splatHead.headers.get('content-type'),
    note: 'SwiftShader 软件 WebGL。mobile_sim 用 Chrome 的 Pixel 6 视口（412×915 CSS 像素，deviceScaleFactor 2.625）再加 CPU 降速 4 倍。页面把像素比封顶为 2，所以画布不是手机的物理分辨率。这不是真机，GPU 也没有换成 Pixel 6 的 GPU。',
    scenarios: [desktop, desktopNoAa, mobile],
    pageLogs: logs.slice(-40),
  };
  await writeFile(`${ARTIFACTS}/splat_lab_report.json`, JSON.stringify(report, null, 2));
  console.log('报告已写入', `${ARTIFACTS}/splat_lab_report.json`);
  client.close();
} catch (error) {
  console.error(error);
  console.error('--- server log ---');
  console.error(server.log().slice(-4000));
  console.error('--- chrome log ---');
  console.error(chrome.log().slice(-4000));
  process.exitCode = 1;
} finally {
  chrome.stop();
  server.stop();
  await delay(300);
  process.exit(process.exitCode ?? 0);
}
