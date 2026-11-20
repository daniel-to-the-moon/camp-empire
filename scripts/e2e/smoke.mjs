// 浏览器端到端冒烟验收：在真实 Chromium 里打开构建产物（vite preview），走一遍核心循环。
// 用法：node scripts/e2e/smoke.mjs [地址]，默认 http://127.0.0.1:4173/
// 流程：?dev 入口 → 画布渲染出非空像素 → 金币显示 → 快进 1 天 → 待收取池有钱 → 收取 → 金币增加 → 无页面错误。
// 失败时退出码非 0，并把截图写到 E2E_ARTIFACTS（默认 e2e-artifacts/）供 CI 上传。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const base = process.argv[2] || 'http://127.0.0.1:4173/';
const outDir = process.env.E2E_ARTIFACTS || 'e2e-artifacts';
mkdirSync(outDir, { recursive: true });

const errors = [];
const steps = [];
const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console.error: ${m.text()}`); });

/** 读金币显示（整数金，去掉千分位） */
async function coins() {
  const t = (await page.locator('#coins').textContent()) ?? '';
  const n = Number(t.replace(/[^\d.-]/g, ''));
  if (!Number.isFinite(n)) throw new Error(`金币显示不是数字：${JSON.stringify(t)}`);
  return n;
}

async function step(name, fn) {
  try {
    await fn();
    steps.push(`✓ ${name}`);
  } catch (e) {
    steps.push(`✗ ${name}：${e.message}`);
    throw e;
  }
}

let ok = false;
try {
  const url = new URL(base);
  url.searchParams.set('dev', '');
  await step('打开游戏（?dev 入口）', async () => {
    await page.goto(url.toString(), { waitUntil: 'load', timeout: 30_000 });
    await page.locator('#stage canvas').waitFor({ timeout: 20_000 });
  });

  await step('场景画布渲染出非空像素', async () => {
    await page.waitForTimeout(1500);
    // WebGL 画布没开 preserveDrawingBuffer，直接回读是空的；改为截屏后在 2D 画布里看像素是否有变化
    const png = (await page.locator('#stage').screenshot()).toString('base64');
    const painted = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      const colors = new Set();
      for (let i = 0; i < d.length; i += 4) colors.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
      return colors.size >= 8;
    }, png);
    if (!painted) throw new Error('场景截图颜色少于 8 种，疑似没有渲染');
  });

  // 首次进入可能弹出回访面板（每日礼物），先关掉
  const welcome = page.locator('#welcome');
  if (await welcome.isVisible()) await welcome.locator('[data-act="closeWelcome"]').click();

  let before = 0;
  await step('金币显示为数字', async () => { before = await coins(); });

  await step('开发快进 +1 天', async () => {
    await page.locator('#dev').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#dev [data-act="dev"][data-arg="86400000"]').click();
  });

  await step('待收取池有钱并收取', async () => {
    if (await welcome.isVisible()) {
      const c = welcome.locator('[data-act="collect"]');
      if (await c.count()) { await c.click(); return; }
      await welcome.locator('[data-act="closeWelcome"]').click();
    }
    const btn = page.locator('#pending [data-act="collect"]');
    await btn.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('#pending [data-act="collect"]')?.hasAttribute('disabled'), null, { timeout: 10_000 });
    await btn.click();
  });

  await step('收取后金币增加', async () => {
    await page.waitForTimeout(500);
    const after = await coins();
    if (!(after > before)) throw new Error(`金币没有增加：${before} → ${after}`);
  });

  if (errors.length) throw new Error(`页面出现错误：\n${errors.join('\n')}`);
  ok = true;
} catch (e) {
  steps.push(`失败：${e.message}`);
} finally {
  await page.screenshot({ path: join(outDir, ok ? 'smoke-pass.png' : 'smoke-fail.png') }).catch(() => {});
  await browser.close();
}

console.log(steps.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### 浏览器冒烟验收：${ok ? '通过' : '失败'}\n\n${steps.map((s) => `- ${s}`).join('\n')}\n`);
}
process.exit(ok ? 0 : 1);
