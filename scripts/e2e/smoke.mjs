// 浏览器端到端冒烟验收：在真实 Chromium 里打开构建产物（vite preview），走一遍核心循环。
// 用法：node scripts/e2e/smoke.mjs [地址]，默认 http://127.0.0.1:4173/
// 流程：?dev 入口 → 画布渲染出非空像素 → 金币显示 → 快进 1 天 → 待收取池有钱 → 收取 → 车辆截图 → 无页面错误。
// 截图写到 E2E_ARTIFACTS（默认 e2e-artifacts/）供 CI 上传，失败时退出码非 0。
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
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

  const hideHud = () => page.addStyleTag({ content: 'body > *:not(#stage), #stage > *:not(canvas) { visibility: hidden !important; }' });
  await step('场景画布渲染出非空像素', async () => {
    await page.waitForTimeout(1500);
    // WebGL 画布没开 preserveDrawingBuffer，直接回读是空的；改为截屏。
    // 截屏前隐藏全部界面层（顶栏、面板、弹窗、底栏等），只留画布，避免界面颜色让空白场景蒙混过关（GPT 审核 #63 第 1 轮）。
    const style = await hideHud();
    const png = (await page.locator('#stage canvas').first().screenshot()).toString('base64');
    await style.evaluate(el => el.remove());
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

  await step('首次打开：快捷键引导出现，Esc 关掉；H 重开、按钮关掉', async () => {
    const guide = page.locator('#guide');
    await guide.waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: join(outDir, 'ui-guide.png') });
    await page.keyboard.press('Escape');
    await guide.waitFor({ state: 'hidden', timeout: 5_000 });
    await page.keyboard.press('KeyH');
    await guide.waitFor({ state: 'visible', timeout: 5_000 });
    await guide.locator('[data-act="guideClose"]').click();
    await guide.waitFor({ state: 'hidden', timeout: 5_000 });
    // 顶栏按钮打开 → 焦点在“开始露营”上按空格关闭 → 焦点回到顶栏按钮（GPT 审核 #90）
    await page.locator('#help').click();
    await guide.waitFor({ state: 'visible', timeout: 5_000 });
    await page.keyboard.press('Space');
    await guide.waitFor({ state: 'hidden', timeout: 5_000 });
    const focused = await page.evaluate(() => document.activeElement?.id);
    if (focused !== 'help') throw new Error(`关闭引导后焦点没有回到顶栏按钮（现在是 ${focused || 'body'}）`);
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
  await step('待收取池有钱（右侧图标列展开待收取抽屉）', async () => {
    await page.screenshot({ path: join(outDir, 'ui-collapsed.png') });
    await page.locator('#rail-right [data-arg="pending"]').click();
    await page.locator('#drawer-right').waitFor({ state: 'visible', timeout: 5_000 });
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
    // 真实指针点击抽屉里可见的收取按钮（抽屉内容不变就不重绘，节点稳定）
    await btn.click();
    await page.waitForFunction(() => document.querySelector('#pending [data-act="collect"]')?.hasAttribute('disabled'), null, { timeout: 5_000 })
      .catch(() => { throw new Error('收取后待收取池没有清空（收取按钮仍可点）'); });
    const after = await coins();
    if (!(after > before)) throw new Error(`收取后金币没有增加：${before} → ${after}`);
    const logAfter = (await page.locator('#log li').first().textContent()) ?? '';
    if (logAfter === logBefore) throw new Error(`收取后流水没有新增（最新一条仍是：${logBefore}）`);
  });

  await step('保存三机位、眉檐高机位、前后全亮对照与无眉檐款特写', async () => {
    const prefix = 'data:image/png;base64,';
    const saveShot = async (angle, filename, lit = false) => {
      const dataUrl = await page.evaluate(([a, on]) => window.__campDebug.vehicleShot(a, on), [angle, lit]);
      if (!dataUrl.startsWith(prefix)) throw new Error(`${angle} 未返回 PNG data URL`);
      const png = Buffer.from(dataUrl.slice(prefix.length), 'base64');
      if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error(`${angle} 的 PNG 文件头无效`);
      writeFileSync(join(outDir, filename), png);
    };
    const selectVariant = async (id) => {
      const chip = `#garage [data-act="variant"][data-arg="${id}"]`;
      // 玩家路径：点左侧车库图标展开抽屉，再真实点击可见的车型按钮
      if (await page.locator('#drawer-left').isHidden() || !(await page.locator('#garage.active').count())) {
        await page.locator('#rail-left [data-arg="garage"]').click();
      }
      await page.locator('#garage').waitFor({ state: 'visible', timeout: 5_000 });
      if (!(await page.locator(`${chip}.on`).count())) await page.locator(chip).click();
      await page.locator(`${chip}.on`).waitFor({ state: 'attached', timeout: 10_000 });
    };

    await selectVariant('SH5043XLJH9DB-C_3116');
    for (const angle of ['front34', 'side', 'rear34']) await saveShot(angle, `vehicle-${angle}.png`);
    for (const angle of ['front34', 'rear34']) await saveShot(angle, `vehicle-${angle}-lit.png`, true);

    // front34 高度 2.6 m，低于这款车的平顶；另用玩家可操作的环绕视图拍天窗。
    await page.keyboard.press('3');
    await page.locator('#views [data-arg="orbit"].on').waitFor();
    const style = await hideHud();
    try {
      // 固定视口，环绕从车后 28° 起步：−310 px 绕向右前，+80 px 把仰角抬到约 65°。
      await page.mouse.move(800, 300);
      await page.mouse.down();
      await page.mouse.move(490, 380);
      await page.mouse.up();
      await page.mouse.wheel(0, -340); // 距离 16 × exp(−340 × 0.0015) ≈ 9.6 m
      await page.waitForTimeout(1000); // 环绕相机指数趋近目标，避免截到拖动过渡帧
      await page.locator('#stage canvas').first().screenshot({ path: join(outDir, 'vehicle-brow-high.png') });
    } finally {
      await style.evaluate(el => el.remove());
      await page.keyboard.press('1');
    }
    await selectVariant('SH6591H4DB_2735');
    await saveShot('front34', 'vehicle-no-brow-front34.png');
  });

  await step('窄屏两侧抽屉互斥：正好 760px 点两侧只开一侧；宽屏双开后缩窄自动收起一侧', async () => {
    const left = page.locator('#drawer-left');
    const right = page.locator('#drawer-right');
    const openTab = async (side, tab) => {
      if (!(await page.locator(`#rail-${side} [data-arg="${tab}"].on`).count())) await page.locator(`#rail-${side} [data-arg="${tab}"]`).click();
    };
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 760, height: 800 });
    await openTab('left', 'garage');
    await openTab('right', 'daily');
    if (!(await left.isHidden()) || !(await right.isVisible())) throw new Error('760px 下两侧抽屉同时打开');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
    await openTab('left', 'garage');
    await openTab('right', 'daily');
    if (!(await left.isVisible()) || !(await right.isVisible())) throw new Error('宽屏下两侧抽屉应能同时打开');
    await page.setViewportSize({ width: 700, height: 800 });
    await left.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('缩窄后左侧抽屉没有收起'); });
    if ((await page.locator('#rail-left [data-arg="garage"]').getAttribute('aria-expanded')) !== 'false') throw new Error('左侧抽屉收起后图标仍是展开状态');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('罗盘连切：转向南刚起步就按 4，指针从北附近直接转向西，不绕过南', async () => {
    const angle = () => page.evaluate(() => {
      const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(document.querySelector('#views .needle')).transform);
      return m ? (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI : 0;
    });
    await page.keyboard.press('1');
    await page.waitForTimeout(1200);
    await page.keyboard.press('3');
    await page.waitForTimeout(60);
    await page.keyboard.press('4');
    const seen = [];
    for (let i = 0; i < 20; i++) { seen.push(await angle()); await page.waitForTimeout(50); }
    if (seen.some((a) => Math.abs(a) > 150)) throw new Error(`指针绕过了南：${seen.map((a) => a.toFixed(0)).join(', ')}`);
    if (Math.abs(seen.at(-1) + 90) > 15) throw new Error(`指针没停在西：${seen.at(-1).toFixed(0)}°`);
    await page.keyboard.press('1');
  });

  await step('看过引导后重载不再自动弹出', async () => {
    await page.reload({ waitUntil: 'load' });
    await page.locator('#stage canvas').waitFor({ timeout: 20_000 });
    await page.waitForTimeout(1500);
    if (await page.locator('#guide').isVisible()) throw new Error('关过引导后重载又弹出了');
  });

  await step('本地存储不可用（读取抛错）时照样启动，引导能打开和关闭', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p2 = await ctx.newPage();
    const errs = [];
    p2.on('pageerror', (e) => errs.push(e.message));
    await p2.addInitScript(() => {
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('denied', 'SecurityError'); } });
    });
    await p2.goto(base, { waitUntil: 'load', timeout: 30_000 });
    await p2.locator('#stage canvas').waitFor({ timeout: 20_000 });
    const g = p2.locator('#guide');
    await g.waitFor({ state: 'visible', timeout: 10_000 });
    await g.locator('[data-act="guideClose"]').click();
    await g.waitFor({ state: 'hidden', timeout: 5_000 });
    await ctx.close();
    if (errs.length) throw new Error(`存储不可用时页面报错：${errs.join('；')}`);
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
