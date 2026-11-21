// 浏览器端到端冒烟验收：在真实 Chromium 里打开构建产物（vite preview），走一遍核心循环。
// 用法：node scripts/e2e/smoke.mjs [地址]，默认 http://127.0.0.1:4173/
// 流程：?dev 入口 → 画布渲染出非空像素 → 金币显示 → 快进 1 天 → 待收取池有钱 → 收取 → 金币增加 → 车辆三机位特写截图 → 无页面错误。
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
    // WebGL 画布没开 preserveDrawingBuffer，直接回读是空的；改为截屏。
    // 截屏前隐藏全部界面层（顶栏、面板、弹窗、底栏等），只留画布，避免界面颜色让空白场景蒙混过关（GPT 审核 #63 第 1 轮）。
    await page.addStyleTag({ content: 'body > *:not(#stage), #stage > *:not(canvas) { visibility: hidden !important; }', }).then((h) => h.evaluate((el) => el.setAttribute('data-smoke', 'hide')));
    const png = (await page.locator('#stage canvas').first().screenshot()).toString('base64');
    await page.evaluate(() => document.querySelector('style[data-smoke="hide"]')?.remove());
    const colors = await page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = 64; c.height = 64;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0, 64, 64);
      const d = g.getImageData(0, 0, 64, 64).data;
      const set = new Set();
      for (let i = 0; i < d.length; i += 4) set.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
      return set.size;
    }, png);
    if (colors < 8) throw new Error(`场景画布只有 ${colors} 种颜色，疑似没有渲染`);
  });

  const welcome = page.locator('#welcome');
  /** 回访面板（每日礼物、离线汇总）只关掉、不在里面收取：收取一律走待收取区，才能单独核对收取入账 */
  async function closeWelcome() {
    if (await welcome.isVisible()) {
      await welcome.locator('[data-act="closeWelcome"]').click();
      await welcome.waitFor({ state: 'hidden', timeout: 5_000 });
    }
  }
  await closeWelcome();

  await step('金币显示为数字', async () => { await coins(); });

  await step('开发快进 +1 天', async () => {
    await page.locator('#dev').waitFor({ state: 'visible', timeout: 5_000 });
    await page.locator('#dev [data-act="dev"][data-arg="86400000"]').click();
    await page.waitForTimeout(500);
    await closeWelcome();
  });

  const btn = page.locator('#pending [data-act="collect"]');
  await step('待收取池有钱', async () => {
    await btn.waitFor({ timeout: 10_000 });
    await page.waitForFunction(() => !document.querySelector('#pending [data-act="collect"]')?.hasAttribute('disabled'), null, { timeout: 10_000 });
  });

  // 基线在快进、每日礼物都处理完之后、点收取之前读（GPT 审核 #63 第 1 轮：快进本身会发每日礼物，不能当作收取入账）
  let before = 0;
  let logBefore = '';
  await step('收取：金币增加、待收取池清空、流水新增', async () => {
    await page.waitForTimeout(300);
    before = await coins();
    // 流水只显示最近 6 条、最新在前：比较第一条的内容
    logBefore = (await page.locator('#log li').first().textContent().catch(() => '')) ?? '';
    // 面板每帧重绘、按钮节点不稳定；点击处理挂在 document 上，直接对当前节点派发点击
    await page.evaluate(() => document.querySelector('#pending [data-act="collect"]')?.click());
    await page.waitForFunction(() => document.querySelector('#pending [data-act="collect"]')?.hasAttribute('disabled'), null, { timeout: 5_000 })
      .catch(() => { throw new Error('收取后待收取池没有清空（收取按钮仍可点）'); });
    const after = await coins();
    if (!(after > before)) throw new Error(`收取后金币没有增加：${before} → ${after}`);
    const logAfter = (await page.locator('#log li').first().textContent()) ?? '';
    if (logAfter === logBefore) throw new Error(`收取后流水没有新增（最新一条仍是：${logBefore}）`);
  });

  // 视觉验收素材（#69）：玩家车三个固定机位特写，写进产物目录，供人工 / 评分对照参考图
  await step('车辆特写截图（front34 / side / rear34）', async () => {
    const { writeFileSync } = await import('node:fs');
    for (const angle of ['front34', 'side', 'rear34']) {
      const url = await page.evaluate((a) => window.__campDebug.vehicleShot(a), angle);
      if (!url?.startsWith('data:image/png;base64,')) throw new Error(`vehicleShot(${angle}) 没有返回 PNG`);
      writeFileSync(join(outDir, `vehicle-${angle}.png`), Buffer.from(url.split(',')[1], 'base64'));
    }
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
