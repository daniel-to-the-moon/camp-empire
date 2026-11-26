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

  await step('罗盘连切：转向南途中按 4，指针从当时的实际角度走最短弧转到西', async () => {
    const angle = () => page.evaluate(() => {
      const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(document.querySelector('#views .needle')).transform);
      return m ? (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI : 0;
    });
    await page.keyboard.press('1');
    await page.waitForTimeout(1200);
    // 按 3 后等两帧（指针刚起步），记下此刻实际角度，再立刻按 4；跑得快慢不同的机器上起点不同，所以断言相对起点
    const start = await page.evaluate(async () => {
      const key = (code, key) => window.dispatchEvent(new KeyboardEvent('keydown', { code, key }));
      key('Digit3', '3');
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(document.querySelector('#views .needle')).transform);
      const a = m ? (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI : 0;
      key('Digit4', '4');
      return a;
    });
    const seen = [start];
    for (let i = 0; i < 20; i++) { await page.waitForTimeout(50); seen.push(await angle()); }
    // 展开成连续角度，看总共转了多远
    const cum = [start];
    for (let i = 1; i < seen.length; i++) cum.push(cum[i - 1] + ((((seen[i] - seen[i - 1]) % 360) + 540) % 360) - 180);
    const shortest = Math.abs(((((-90 - start) % 360) + 540) % 360) - 180);
    const far = Math.max(...cum.map((a) => Math.abs(a - start)));
    if (far > shortest * 1.1 + 5) throw new Error(`指针没走最短弧：起点 ${start.toFixed(0)}°，最短 ${shortest.toFixed(0)}°，实际转到 ${far.toFixed(0)}°（${seen.map((a) => a.toFixed(0)).join(', ')}）`);
    if (Math.abs(seen.at(-1) + 90) > 15) throw new Error(`指针没停在西：${seen.at(-1).toFixed(0)}°`);
    for (const k of ['Digit3', 'Digit4']) await page.evaluate((code) => window.dispatchEvent(new KeyboardEvent('keyup', { code })), k);
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

  await step('键盘：Tab 聚焦图标按空格展开抽屉、聚焦罗盘按空格换视图', async () => {
    await page.keyboard.press('Escape');
    const tabTo = async (sel) => {
      for (let i = 0; i < 40; i++) {
        await page.keyboard.press('Tab');
        if (await page.evaluate((q) => document.activeElement?.matches(q), sel)) return;
      }
      throw new Error(`Tab 走不到 ${sel}`);
    };
    await tabTo('#rail-left [data-arg="garage"]');
    await page.keyboard.press('Space');
    await page.locator('#garage.active').waitFor({ state: 'visible', timeout: 3_000 }).catch(() => { throw new Error('空格没有展开车库抽屉'); });
    await tabTo('#views [data-arg="hood"]');
    await page.keyboard.press('Space');
    await page.locator('#views [data-arg="hood"].on').waitFor({ timeout: 3_000 }).catch(() => { throw new Error('空格没有切到引擎盖视图'); });
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Escape');
    await page.keyboard.press('1');
  });

  await step('减少动态效果：途中开启立即停在目标；开启后换视图不转动画', async () => {
    const angle = () => page.evaluate(() => {
      const m = /^matrix\(([^,]+),\s*([^,]+)/.exec(getComputedStyle(document.querySelector('#views .needle')).transform);
      return m ? (Math.atan2(Number(m[2]), Number(m[1])) * 180) / Math.PI : 0;
    });
    await page.waitForTimeout(900);
    await page.keyboard.press('3');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const a1 = await angle();
    if (Math.abs(Math.abs(a1) - 180) > 2) throw new Error(`途中开启减少动态后指针没对齐南：${a1.toFixed(0)}°`);
    await page.keyboard.press('2');
    await page.waitForTimeout(30);
    const a2 = await angle();
    if (Math.abs(a2 - 90) > 2) throw new Error(`减少动态下换视图仍在转动：${a2.toFixed(0)}°`);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.keyboard.press('1');
  });

  await step('矮横屏 667×280：点图标打开抽屉，能点到里面的按钮', async () => {
    await page.setViewportSize({ width: 667, height: 280 });
    await page.keyboard.press('Escape');
    await page.locator('#rail-left [data-arg="garage"]').click();
    const chip = page.locator('#garage [data-act="variant"][data-arg="SH5043XLJH9DB-C_3116"]');
    await chip.click();
    await page.locator('#garage [data-arg="SH5043XLJH9DB-C_3116"].on').waitFor({ state: 'attached', timeout: 5_000 });
    await page.keyboard.press('Escape');
    // 右侧最后一个图标在矮屏下要滚到才能点
    await page.locator('#rail-right [data-arg="log"]').click();
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
