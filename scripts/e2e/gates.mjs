// 性能验收 + 固定机位截图（devloop 第 3、1 条角色；docs/DEVLOOP.md “验收与发布角色”）。
// 用法：node scripts/e2e/gates.mjs [地址]，默认 http://127.0.0.1:4173/；产物写到 E2E_ARTIFACTS（默认 e2e-artifacts/）。
//
// 做什么：
//   1. 在页面脚本运行前给 WebGL 的 draw* 方法计数（不依赖游戏代码里的调试钩子，PR 改不了计数方式），
//      按 requestAnimationFrame 分帧统计 draw call 与三角形数；
//   2. 固定场景采样（营地俯瞰、开出去行驶中），与 scripts/e2e/budgets.json 的预算比较，超出即退出码 1（CI 失败 → 不合并）；
//   3. 固定机位截图：桌面营地俯瞰（隐藏界面层，只留画布）、手机竖屏整页（Playwright 设备模拟，非真机），供视觉验收使用。
// 帧时间只记录不判定：CI 用 SwiftShader 软件渲染，帧时间与真机无关（待核实目标设备实测，#55）。
import { chromium, devices } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkBudgets, summarize } from './gates-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const base = process.argv[2] || 'http://127.0.0.1:4173/';
const outDir = process.env.E2E_ARTIFACTS || 'e2e-artifacts';
mkdirSync(outDir, { recursive: true });
const budgets = JSON.parse(readFileSync(join(HERE, 'budgets.json'), 'utf8'));

/** 注入到页面：分帧统计 draw call / 三角形 */
function hookGl() {
  const frames = [];
  let cur = { calls: 0, tris: 0 };
  const TRI = 4; // gl.TRIANGLES
  const prim = (mode, count, inst = 1) => (mode === TRI ? Math.floor(count / 3) * inst : 0);
  const wrap = (proto, name, f) => {
    const orig = proto?.[name];
    if (!orig) return;
    proto[name] = function (...a) {
      cur.calls++;
      cur.tris += f(a);
      return orig.apply(this, a);
    };
  };
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    const p = C?.prototype;
    wrap(p, 'drawArrays', (a) => prim(a[0], a[2]));
    wrap(p, 'drawElements', (a) => prim(a[0], a[1]));
    wrap(p, 'drawArraysInstanced', (a) => prim(a[0], a[2], a[3]));
    wrap(p, 'drawElementsInstanced', (a) => prim(a[0], a[1], a[4]));
    wrap(p, 'drawRangeElements', (a) => prim(a[0], a[3]));
  }
  const raf = window.requestAnimationFrame.bind(window);
  // 同一浏览器帧里的多个回调拿到同一时间戳：时间戳变了才结算上一帧，多回调的 draw call 合计到同一帧
  let last = 0;
  let curT = -1;
  window.requestAnimationFrame = (cb) => raf((t) => {
    if (t !== curT) {
      if (cur.calls > 0) frames.push({ ...cur, ms: last ? curT - last : 0 });
      if (frames.length > 600) frames.shift();
      if (curT >= 0) last = curT;
      curT = t;
      cur = { calls: 0, tris: 0 };
    }
    cb(t);
  });
  window.__gates = { take: () => frames.splice(0, frames.length) };
}

const errors = [];
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const results = { scenes: {}, shots: [], budgets };
let failures = [];
try {
  const url = new URL(base);
  url.searchParams.set('dev', '');

  // —— 桌面：性能采样 + 营地俯瞰截图 ——
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.addInitScript(hookGl);
  await page.goto(url.toString(), { waitUntil: 'load', timeout: 30_000 });
  await page.locator('#stage canvas').waitFor({ timeout: 20_000 });
  const welcome = page.locator('#welcome');
  if (await welcome.isVisible()) {
    await welcome.locator('[data-act="closeWelcome"]').click();
    await welcome.waitFor({ state: 'hidden', timeout: 5_000 });
  }
  /** 等镜头稳定后采样 n 帧 */
  async function sample(name, settleMs = 2500, n = 60) {
    await page.waitForTimeout(settleMs);
    await page.evaluate(() => window.__gates.take());
    const frames = [];
    for (let i = 0; i < 40 && frames.length < n; i++) {
      await page.waitForTimeout(250);
      frames.push(...(await page.evaluate(() => window.__gates.take())));
    }
    results.scenes[name] = summarize(frames);
  }
  async function canvasShot(file) {
    const h = await page.addStyleTag({ content: 'body > *:not(#stage), #stage > *:not(canvas) { visibility: hidden !important; }' });
    await page.locator('#stage canvas').first().screenshot({ path: join(outDir, file) });
    await h.evaluate((el) => el.remove());
    results.shots.push(file);
  }

  await sample('camp');
  await canvasShot('shot-camp.png');
  // 开出去：O 键（停在家位时可用）；行驶几秒再采样
  await page.keyboard.press('KeyO');
  await page.keyboard.down('KeyW');
  await sample('driving', 1500, 60);
  await page.keyboard.up('KeyW');
  await canvasShot('shot-driving.png');
  await page.close();

  // —— 手机竖屏（设备模拟，非真机）：整页截图，供人工与视觉验收看界面在小屏上的排布；不参与评分门槛 ——
  const ctx = await browser.newContext({ ...devices['iPhone 13'] });
  const m = await ctx.newPage();
  m.on('pageerror', (e) => errors.push(`mobile pageerror: ${e.message}`));
  // 不带 ?dev：看玩家实际看到的界面（本机地址本来就不发统计）
  await m.goto(base, { waitUntil: 'load', timeout: 30_000 });
  await m.locator('#stage canvas').waitFor({ timeout: 20_000 });
  const mw = m.locator('#welcome');
  if (await mw.isVisible()) await mw.locator('[data-act="closeWelcome"]').click().catch(() => {});
  await m.waitForTimeout(2500);
  await m.screenshot({ path: join(outDir, 'shot-mobile.png') });
  results.shots.push('shot-mobile.png');
  await ctx.close();

  failures = checkBudgets(results.scenes, budgets);
  if (errors.length) failures.push(...errors);
} catch (e) {
  failures.push(`采样失败：${e.message}`);
} finally {
  await browser.close();
}
results.failures = failures;
writeFileSync(join(outDir, 'perf.json'), JSON.stringify(results, null, 2));
for (const [k, s] of Object.entries(results.scenes)) {
  console.log(`${k}: draw call 中位 ${s.callsMedian} / 最大 ${s.callsMax}；三角形中位 ${s.trisMedian} / 最大 ${s.trisMax}；帧时间中位 ${s.msMedian} ms（软件渲染，仅参考）；${s.frames} 帧`);
}
if (failures.length) {
  console.error('性能验收未通过：\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('性能验收通过');
