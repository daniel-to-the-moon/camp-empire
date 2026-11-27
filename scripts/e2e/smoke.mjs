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

/** 玩家路径：点底栏罗盘展开圆形菜单，再点其中一格（抽屉 / 卡片 / 图鉴 / 隐私 / 视图） */
async function pick(arg, p = page) {
  if (await p.locator('#radial').isHidden()) await p.locator('#hub').click();
  await p.locator('#radial').waitFor({ state: 'visible', timeout: 3_000 });
  await p.locator(`#radial button[data-arg="${arg}"], #radial button[data-act="${arg}"]`).click();
  await p.locator('#radial').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error(`选了 ${arg} 后圆形菜单没有收起`); });
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
    // 首次打开先出回访面板（每日礼物），引导要等它关掉才弹，不能叠在它上面
    const wel = page.locator('#welcome');
    await wel.waitFor({ state: 'visible', timeout: 10_000 });
    if (await guide.isVisible()) throw new Error('回访面板开着时引导也弹出来了');
    await wel.locator('.x-close').click();
    await guide.waitFor({ state: 'visible', timeout: 10_000 });
    await page.screenshot({ path: join(outDir, 'ui-guide.png') });
    await page.keyboard.press('Escape');
    await guide.waitFor({ state: 'hidden', timeout: 5_000 });
    await page.keyboard.press('KeyH');
    await guide.waitFor({ state: 'visible', timeout: 5_000 });
    await guide.locator('.primary[data-act="guideClose"]').click();
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
      await welcome.locator('.x-close').click();
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
  await step('待收取池有钱（点罗盘、在圆形菜单里选待收取）', async () => {
    await page.screenshot({ path: join(outDir, 'ui-collapsed.png') });
    await pick('pending');
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
      // 玩家路径：点罗盘、在圆形菜单里选车库，再真实点击可见的车型按钮
      if (await page.locator('#drawer-left').isHidden() || !(await page.locator('#garage.active').count())) await pick('garage');
      await page.locator('#garage').waitFor({ state: 'visible', timeout: 5_000 });
      if (!(await page.locator(`${chip}.on`).count())) await page.locator(chip).click();
      await page.locator(`${chip}.on`).waitFor({ state: 'attached', timeout: 10_000 });
    };

    await selectVariant('SH5043XLJH9DB-C_3116');
    for (const angle of ['front34', 'side', 'rear34']) await saveShot(angle, `vehicle-${angle}.png`);
    await saveShot('entrySide', 'vehicle-entry-side.png');
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

  await step('圆形菜单：点罗盘展开，全部功能平均分在外圈、视图在内圈；点中心 / 遮罩 / Esc / 再点罗盘都能收起', async () => {
    await page.keyboard.press('Escape');
    const radial = page.locator('#radial');
    const hub = page.locator('#hub');
    if (!(await radial.isHidden())) throw new Error('圆形菜单默认应收起');
    await hub.click();
    await radial.waitFor({ state: 'visible', timeout: 3_000 });
    if ((await hub.getAttribute('aria-expanded')) !== 'true') throw new Error('罗盘的 aria-expanded 没有跟着变');
    await page.waitForTimeout(700); // 等弹出动画
    await page.screenshot({ path: join(outDir, 'ui-radial-pc.png') });
    // 外圈 9 格、内圈 4 格：图标到圆心的距离一致、相邻两格夹角一致
    const geo = await page.evaluate(() => {
      const w = document.querySelector('#radial .wheel').getBoundingClientRect();
      const cx = w.left + w.width / 2, cy = w.top + w.height / 2;
      const ring = (sel) => [...document.querySelectorAll(sel)].map((b) => {
        const r = b.getBoundingClientRect();
        const x = r.left + r.width / 2 - cx, y = r.top + r.height / 2 - cy;
        return { d: Math.hypot(x, y), a: ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360 };
      });
      return { outer: ring('#radial .rbtn:not(.vbtn)'), inner: ring('#radial .vbtn'), size: w.width };
    });
    for (const [name, list, n] of [['外圈', geo.outer, 9], ['内圈', geo.inner, 4]]) {
      if (list.length !== n) throw new Error(`${name}应有 ${n} 格，实际 ${list.length}`);
      const ds = list.map((x) => x.d);
      if (Math.max(...ds) - Math.min(...ds) > 3) throw new Error(`${name}图标到圆心的距离不一致：${ds.map((d) => d.toFixed(0))}`);
      list.forEach((x, i) => {
        const want = (360 / n) * i;
        const diff = Math.abs(((x.a - want + 540) % 360) - 180);
        if (diff > 3) throw new Error(`${name}第 ${i + 1} 格不在等分扇区中线上：${x.a.toFixed(0)}° ≠ ${want}°`);
      });
    }
    // 收起：中心 ×、遮罩、Esc、再点罗盘
    await page.locator('#radial .radial-center').click();
    await radial.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('点中心没有收起圆形菜单'); });
    await hub.click();
    await page.mouse.click(40, 400);
    await radial.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('点遮罩没有收起圆形菜单'); });
    await hub.click();
    await page.keyboard.press('Escape');
    await radial.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('Esc 没有收起圆形菜单'); });
    await page.keyboard.press('KeyM');
    await radial.waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { throw new Error('M 没有展开圆形菜单'); });
    await page.keyboard.press('KeyM');
    await radial.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('再按 M 没有收起圆形菜单'); });
    // 菜单里选视图：菜单收起、罗盘指到新视图
    await pick('follow');
    await page.locator('#views [data-arg="follow"].on').waitFor({ timeout: 3_000 }).catch(() => { throw new Error('菜单里选跟随没有换视图'); });
    await page.keyboard.press('1');
    // 卡片 / 图鉴 / 隐私这类直接执行：图鉴弹窗打开
    await pick('dex');
    await page.locator('#dex').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { throw new Error('菜单里选图鉴没有打开图鉴'); });
    await page.locator('#dex [data-act="dexClose"]').first().click();
  });

  await step('PC 抽屉：从圆形菜单打开，在底栏上方弹出、不挡罗盘；一次只开一个', async () => {
    const left = page.locator('#drawer-left');
    const right = page.locator('#drawer-right');
    await pick('shop');
    await left.waitFor({ state: 'visible', timeout: 3_000 });
    await page.waitForTimeout(400);
    const pb = await left.boundingBox();
    const hb = await page.locator('#hub').boundingBox();
    if (!pb || !hb || pb.y + pb.height > hb.y) throw new Error(`PC 抽屉盖住了罗盘：panel ${JSON.stringify(pb)} hub ${JSON.stringify(hb)}`);
    await page.screenshot({ path: join(outDir, 'ui-drawer-pc.png') });
    await pick('spots');
    await right.waitFor({ state: 'visible', timeout: 3_000 });
    if (!(await left.isHidden())) throw new Error('打开车位后小卖部没有收起（应一次只开一个）');
    if ((await page.locator('#radial button[data-arg="shop"]').getAttribute('aria-expanded')) !== 'false') throw new Error('小卖部收起后菜单格子仍是展开状态');
    // 再点罗盘：抽屉收起、菜单展开
    await page.locator('#hub').click();
    await right.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('展开圆形菜单时抽屉没有收起'); });
    await page.keyboard.press('Escape');
    await pick('daily');
    await right.locator('.x-close').click();
    await right.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('点右上角 ×没有收起抽屉'); });
  });

  await step('窄屏 760px：圆形菜单选中后底部弹出 action sheet，点遮罩 / 完成 / Esc 收起', async () => {
    const left = page.locator('#drawer-left');
    const right = page.locator('#drawer-right');
    const bd = page.locator('#sheet-backdrop');
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 760, height: 800 });
    if (!(await left.isHidden()) || !(await right.isHidden()) || !(await bd.isHidden())) throw new Error('窄屏默认应全部收起');
    await pick('garage');
    await left.waitFor({ state: 'visible', timeout: 3_000 });
    await bd.waitFor({ state: 'visible', timeout: 3_000 });
    await page.waitForTimeout(450); // 等 sheet 滑上来
    const box = await left.boundingBox();
    if (!box || Math.abs(box.y + box.height - 800) > 2 || box.width < 750) throw new Error(`action sheet 应贴底铺满宽度：${JSON.stringify(box)}`);
    await page.mouse.click(380, 40);
    await left.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('点遮罩没有收起 action sheet'); });
    await pick('daily');
    await right.waitFor({ state: 'visible', timeout: 3_000 });
    await right.locator('.x-close').click();
    await right.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('点右上角 ×没有收起 action sheet'); });
    await pick('shop');
    await left.waitFor({ state: 'visible', timeout: 3_000 });
    await page.keyboard.press('Escape');
    await left.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('Esc 没有收起 action sheet'); });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('手机 390×844：action sheet 里能真实点到“收取”，金币增加', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.keyboard.press('Escape');
    await page.screenshot({ path: join(outDir, 'ui-mobile-collapsed.png') });
    // 开发面板只用于造数据：直接触发快进
    await page.evaluate(() => document.querySelector('#dev [data-act="dev"][data-arg="86400000"]').click());
    await page.waitForTimeout(500);
    await closeWelcome();
    await page.keyboard.press('Escape');
    await page.locator('#hub').click();
    await page.locator('#radial').waitFor({ state: 'visible', timeout: 3_000 });
    await page.waitForTimeout(700);
    // 圆形菜单整圈都在手机屏幕里
    const wb = await page.locator('#radial .wheel').boundingBox();
    if (!wb || wb.x < 0 || wb.x + wb.width > 390 || wb.y < 0 || wb.y + wb.height > 844) throw new Error(`手机上圆形菜单超出屏幕：${JSON.stringify(wb)}`);
    await page.screenshot({ path: join(outDir, 'ui-radial-mobile.png') });
    await pick('pending');
    const b = page.locator('#pending [data-act="collect"]');
    await page.waitForFunction(() => !document.querySelector('#pending [data-act="collect"]')?.hasAttribute('disabled'), null, { timeout: 10_000 });
    await page.waitForTimeout(400);
    const bb = await b.boundingBox();
    if (!bb || bb.y + bb.height > 844 || bb.height < 36) throw new Error(`手机上收取按钮不在可视区或太小：${JSON.stringify(bb)}`);
    await page.screenshot({ path: join(outDir, 'ui-mobile-sheet.png') });
    const c0 = await coins();
    await b.click();
    await page.waitForFunction(() => document.querySelector('#pending [data-act="collect"]')?.hasAttribute('disabled'), null, { timeout: 5_000 })
      .catch(() => { throw new Error('手机上点收取没有生效'); });
    if (!((await coins()) > c0)) throw new Error('手机上收取后金币没有增加');
    await page.locator('#drawer-right .x-close').click();
    await page.locator('#drawer-right').waitFor({ state: 'hidden', timeout: 3_000 });
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('所有关闭都支持 Esc；关闭钮在右上角、醒目', async () => {
    await page.keyboard.press('Escape');
    for (const [arg, sel] of [['dex', '#dex'], ['privacy', '#privacy'], ['daily', '#drawer-right']]) {
      await pick(arg);
      const box = page.locator(sel);
      await box.waitFor({ state: 'visible', timeout: 3_000 });
      await page.waitForTimeout(400);
      const bb = await box.boundingBox();
      const xb = await box.locator('.x-close').first().boundingBox();
      if (!bb || !xb) throw new Error(`${sel} 没有关闭钮`);
      // 右上角：离右边、上边都不超过 28px；够大（至少 32px）
      if (bb.x + bb.width - (xb.x + xb.width) > 28 || xb.y - bb.y > 28 || xb.width < 32) throw new Error(`${sel} 的关闭钮不在右上角或太小：${JSON.stringify({ bb, xb })}`);
      if (arg === 'dex') await page.screenshot({ path: join(outDir, 'ui-close-topright.png') });
      await page.keyboard.press('Escape');
      await box.waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error(`Esc 没有关掉 ${sel}`); });
    }
    // 图鉴开着时按 M 再从菜单打开隐私：图鉴先关掉，不会两个叠在一起，Esc 关的是看得见的隐私（Codex 审核 #103）
    await pick('dex');
    await page.locator('#dex').waitFor({ state: 'visible', timeout: 3_000 });
    await page.keyboard.press('KeyM');
    await page.locator('#radial').waitFor({ state: 'visible', timeout: 3_000 });
    if (!(await page.locator('#dex').isHidden())) throw new Error('展开菜单时图鉴没有关掉（菜单被图鉴挡住）');
    await pick('privacy');
    await page.locator('#privacy').waitFor({ state: 'visible', timeout: 3_000 });
    if (!(await page.locator('#dex').isHidden())) throw new Error('打开隐私后图鉴没有关掉（两个弹窗叠在一起）');
    await page.keyboard.press('Escape');
    await page.locator('#privacy').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('Esc 没有关掉最上面的隐私'); });
    // 引导也能用右上角 × 关
    await page.keyboard.press('KeyH');
    await page.locator('#guide').waitFor({ state: 'visible', timeout: 3_000 });
    await page.locator('#guide .x-close').click();
    await page.locator('#guide').waitFor({ state: 'hidden', timeout: 3_000 }).catch(() => { throw new Error('点引导右上角 × 没有关掉'); });
  });

  await step('罗盘实时感应：环绕视图拖动画面，盘面跟着镜头朝向实时转；拖回来又转回去', async () => {
    const dial = () => page.evaluate(() => {
      const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(document.querySelector('#hub .dial')).transform);
      return m ? (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI : 0;
    });
    const diff = (a, b) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);
    await page.keyboard.press('Escape');
    await page.keyboard.press('3');
    await page.locator('#views [data-arg="orbit"].on').waitFor({ timeout: 3_000 });
    await page.waitForTimeout(1500);
    const a0 = await dial();
    await page.locator('#views').screenshot({ path: join(outDir, 'ui-compass-live-1.png') });
    // 拖动途中就要转（不是松手后才更新）
    await page.mouse.move(900, 300);
    await page.mouse.down();
    await page.mouse.move(750, 300, { steps: 6 });
    await page.waitForTimeout(300);
    const aMid = await dial();
    await page.mouse.move(600, 300, { steps: 6 });
    await page.mouse.up();
    await page.waitForTimeout(1200);
    const a1 = await dial();
    await page.locator('#views').screenshot({ path: join(outDir, 'ui-compass-live-2.png') });
    if (diff(aMid, a0) < 5) throw new Error(`拖动途中罗盘没动：${a0.toFixed(0)}° → ${aMid.toFixed(0)}°`);
    if (diff(a1, a0) < 20) throw new Error(`拖完罗盘转得太少：${a0.toFixed(0)}° → ${a1.toFixed(0)}°`);
    // 拖回原处：罗盘回到原来的朝向
    await page.mouse.move(600, 300);
    await page.mouse.down();
    await page.mouse.move(900, 300, { steps: 12 });
    await page.mouse.up();
    await page.waitForTimeout(1500);
    const a2 = await dial();
    if (diff(a2, a0) > 6) throw new Error(`拖回原处后罗盘没回到原朝向：${a0.toFixed(0)}° → ${a2.toFixed(0)}°`);
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
    await g.locator('.primary[data-act="guideClose"]').click();
    await g.waitFor({ state: 'hidden', timeout: 5_000 });
    await ctx.close();
    if (errs.length) throw new Error(`存储不可用时页面报错：${errs.join('；')}`);
  });

  await step('键盘：Tab 到罗盘按空格展开菜单；M 展开后方向键绕圈、空格选中', async () => {
    await page.keyboard.press('Escape');
    const tabTo = async (sel) => {
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate((q) => document.activeElement?.matches(q), sel)) return;
      }
      throw new Error(`Tab 走不到 ${sel}`);
    };
    // 先用鼠标点过画面，再纯键盘：M 展开 → 右方向键到“每日” → 空格选中（Codex 审核 #102）
    await page.mouse.click(640, 300);
    await page.keyboard.press('KeyM');
    await page.keyboard.press('ArrowRight');
    if (!(await page.evaluate(() => document.activeElement?.dataset.arg === 'daily'))) throw new Error('M 展开后右方向键没有移到每日');
    await page.keyboard.press('Space');
    await page.locator('#daily.active').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { throw new Error('鼠标点过之后，M → 方向键 → 空格没有选中每日'); });
    // 键盘选的抽屉：焦点跟进抽屉；Esc 收起后焦点回到罗盘（Codex 审核 #102）
    if (!(await page.evaluate(() => !!document.activeElement?.closest('#drawer-right')))) throw new Error('键盘选了抽屉后焦点没进抽屉');
    await page.keyboard.press('Escape');
    if (!(await page.evaluate(() => document.activeElement?.id === 'hub'))) throw new Error('Esc 收起抽屉后焦点没回到罗盘');
    await tabTo('#hub');
    await page.keyboard.press('Space');
    await page.locator('#radial').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { throw new Error('空格没有展开圆形菜单'); });
    // 键盘点开的：焦点进菜单第一格，方向键能绕圈（Codex 审核 #102）
    if (!(await page.evaluate(() => document.activeElement?.dataset.arg === 'pending'))) throw new Error('空格展开菜单后焦点没进菜单');
    await page.keyboard.press('ArrowRight');
    if (!(await page.evaluate(() => document.activeElement?.dataset.arg === 'daily'))) throw new Error('空格展开菜单后方向键没有绕圈');
    await page.keyboard.press('Escape');
    if (!(await page.evaluate(() => document.activeElement?.id === 'hub'))) throw new Error('Esc 收起菜单后焦点没回到罗盘');
    // M 展开：焦点落在第一格（待收取），左方向键逆时针到最后一格（车库）
    await page.keyboard.press('KeyM');
    if (!(await page.evaluate(() => document.activeElement?.dataset.arg === 'pending'))) throw new Error('M 展开后焦点不在第一格');
    await page.keyboard.press('ArrowLeft');
    if (!(await page.evaluate(() => document.activeElement?.dataset.arg === 'garage'))) throw new Error('方向键没有绕圈移到车库');
    await page.keyboard.press('Space');
    await page.locator('#garage.active').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { throw new Error('空格没有展开车库抽屉'); });
    await page.keyboard.press('KeyM');
    await tabTo('#radial button[data-arg="hood"]');
    await page.keyboard.press('Space');
    await page.locator('#views [data-arg="hood"].on').waitFor({ timeout: 3_000 }).catch(() => { throw new Error('空格没有切到引擎盖视图'); });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Escape');
    await page.keyboard.press('1');
    // 鼠标点过的罗盘留着焦点：先按 W 再按空格，空格仍是刹车，不会再点一次罗盘把抽屉收起
    await pick('daily');
    await page.keyboard.press('KeyW');
    await page.keyboard.press('Space');
    if (!(await page.locator('#daily.active').isVisible())) throw new Error('鼠标点过的图标被空格再次触发（抽屉收起了）');
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());
  });

  await step('矮横屏 667×280：圆形菜单放得下，选车库后能点到里面的按钮', async () => {
    await page.setViewportSize({ width: 667, height: 280 });
    await page.keyboard.press('Escape');
    await page.locator('#hub').click();
    const wb = await page.locator('#radial .wheel').boundingBox();
    if (!wb || wb.y < 0 || wb.y + wb.height > 280) throw new Error(`矮屏下圆形菜单超出屏幕：${JSON.stringify(wb)}`);
    await pick('garage');
    const chip = page.locator('#garage [data-act="variant"][data-arg="SH5043XLJH9DB-C_3116"]');
    await chip.click();
    await page.locator('#garage [data-arg="SH5043XLJH9DB-C_3116"].on').waitFor({ state: 'attached', timeout: 5_000 });
    await page.keyboard.press('Escape');
    await pick('log');
    await page.locator('#log').waitFor({ state: 'visible', timeout: 3_000 });
    await page.screenshot({ path: join(outDir, 'ui-short-landscape.png') });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1280, height: 800 });
  });

  await step('?dev 下本地存储方法抛错（getItem / setItem / removeItem）照样启动', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const p3 = await ctx.newPage();
    const errs = [];
    p3.on('pageerror', (e) => errs.push(e.message));
    await p3.addInitScript(() => {
      for (const m of ['getItem', 'setItem', 'removeItem']) Storage.prototype[m] = () => { throw new DOMException('denied', 'SecurityError'); };
    });
    await p3.goto(url.toString(), { waitUntil: 'load', timeout: 30_000 });
    await p3.locator('#stage canvas').waitFor({ timeout: 20_000 });
    await p3.locator('#guide').waitFor({ state: 'visible', timeout: 10_000 });
    await ctx.close();
    if (errs.length) throw new Error(`存储方法抛错时 ?dev 页面报错：${errs.join('；')}`);
  });

  await step('只有 localStorage 旧档且暂时读不到：只读、不写新档；恢复后旧档被导入', async () => {
    // 用当前页的 v3 存档当作“旧版 localStorage 存档”的内容
    const legacy = await page.evaluate(() => new Promise((res, rej) => {
      const r = indexedDB.open('camp-empire', 1);
      r.onerror = () => rej(r.error);
      r.onsuccess = () => {
        const g = r.result.transaction('kv', 'readonly').objectStore('kv').get('save.v3');
        g.onsuccess = () => res(g.result);
        g.onerror = () => rej(g.error);
      };
    }));
    if (typeof legacy !== 'string') throw new Error('取不到当前存档做旧档样本');
    const wantCoins = await coins();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const seed = await ctx.newPage();
    await seed.goto(new URL('/favicon.ico', base).toString()).catch(() => {});
    await seed.evaluate((v) => localStorage.setItem('camp-empire.save.v2', v), legacy);
    await seed.close();
    const blocked = await ctx.newPage();
    await blocked.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new DOMException('denied', 'SecurityError'); };
    });
    await blocked.goto(base, { waitUntil: 'load', timeout: 30_000 });
    await blocked.locator('#stage canvas').waitFor({ timeout: 20_000 });
    await blocked.locator('#readonly').waitFor({ state: 'visible', timeout: 10_000 }).catch(() => { throw new Error('旧档读不到时没有进入只读'); });
    await blocked.waitForTimeout(1500);
    const v3 = await blocked.evaluate(() => new Promise((res) => {
      const r = indexedDB.open('camp-empire', 1);
      r.onsuccess = () => {
        const g = r.result.transaction('kv', 'readonly').objectStore('kv').get('save.v3');
        g.onsuccess = () => res(g.result ?? null);
      };
    }));
    await blocked.close();
    if (v3 !== null) throw new Error('旧档读不到时仍写入了新存档');
    const ok = await ctx.newPage();
    await ok.goto(base, { waitUntil: 'load', timeout: 30_000 });
    await ok.locator('#stage canvas').waitFor({ timeout: 20_000 });
    await ok.waitForTimeout(1500);
    const t = (await ok.locator('#coins').textContent()) ?? '';
    const got = Number(t.replace(/[^\d.-]/g, ''));
    const left = await ok.evaluate(() => localStorage.getItem('camp-empire.save.v2'));
    await ctx.close();
    // 迁移后可能再领一次当日礼物，金币只会多不会少
    if (!(got >= wantCoins)) throw new Error(`恢复后旧档没有导入：金币 ${got}，旧档 ${wantCoins}`);
    if (left !== null) throw new Error('导入后旧档没有从 localStorage 删除');
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
