/**
 * 收起式控制面板的界面层：底栏罗盘、点罗盘展开的圆形菜单、抽屉、快捷键引导（规则见 src/shared/hudnav.ts）。
 * 罗盘与圆形菜单只建一次，之后 renderHud 只改类名 / 角标 / 角度，不重写节点：
 * 重写会打断弹出动画和指针的转动。
 */
import { VIEW_LABEL, VIEWS, type View } from '../shared/camview';
import { DRAWERS, Drawers, needleTurn, polar, RING_ITEMS, ringSectors, sectorPath, SHORTCUTS, type DrawerTab } from '../shared/hudnav';
import { ICON } from './icons';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const VIEW_ICON: Record<View, string> = { overview: ICON.overview, follow: ICON.follow, orbit: ICON.orbit, hood: ICON.hood };
const VIEW_SHORT: Record<View, string> = { overview: '俯瞰', follow: '跟随', orbit: '环绕', hood: '引擎盖' };

export const drawers = new Drawers();

/** 圆形菜单的几何（SVG viewBox 400×400）：中心收起钮、内圈视图、外圈功能 */
const C = 200;
const R_CENTER = 44;
const R_VIEW: [number, number] = [50, 108];
const R_RING: [number, number] = [114, 196];

/** 建底栏罗盘与圆形菜单、顶栏引导按钮（只调一次） */
export function mountHud() {
  $('#help').innerHTML = ICON.keys;
  // 底栏罗盘：整个是一个按钮，点一下展开圆形菜单；四个方位的小图标只是示意当前视图
  $('#views').classList.add('compass');
  $('#views').innerHTML = `
    <button id="hub" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-controls="radial" aria-label="打开菜单（M）" title="菜单（M）">
      <span class="rose" aria-hidden="true"><i></i><i></i><i></i><i></i></span>
      <span class="needle" aria-hidden="true"><b></b></span>
      <span class="compass-label" aria-hidden="true"></span>
      ${VIEWS.map((v, i) => `<span class="pt pt-${i}" data-arg="${v}" aria-hidden="true">${VIEW_ICON[v]}</span>`).join('')}
      <kbd aria-hidden="true">M</kbd><i class="hub-dot" hidden></i>
    </button>`;

  const outer = ringSectors(RING_ITEMS.length);
  const inner = ringSectors(VIEWS.length);
  const pos = (r: number, deg: number) => {
    const [x, y] = polar(C, C, r, deg);
    return `left:${(x / 4).toFixed(2)}%;top:${(y / 4).toFixed(2)}%`;
  };
  const ringMid = (R_RING[0] + R_RING[1]) / 2;
  const viewMid = (R_VIEW[0] + R_VIEW[1]) / 2;
  const items = RING_ITEMS.map((it, i) => {
    const key = it.tab ?? it.act!;
    const act = it.tab ? `data-act="drawer" data-arg="${it.tab}" aria-expanded="false"` : `data-act="${it.act}"`;
    return {
      path: `<path class="sec" data-k="${key}" ${act} d="${sectorPath(C, C, R_RING[0], R_RING[1], outer[i])}" style="--i:${i}"/>`,
      btn: `<button class="rbtn" data-k="${key}" ${act} ${it.act === 'dex' ? 'id="dex-entry"' : ''} role="menuitem" aria-label="${it.tab ? DRAWERS[it.tab].label : it.label}" style="${pos(ringMid, outer[i].mid)};--i:${i}">
        ${ICON[key]}<span class="tip">${it.label}</span><i class="badge" data-badge="${key}" hidden></i></button>`,
    };
  });
  const views = VIEWS.map((v, i) => ({
    path: `<path class="sec sec-view" data-k="view-${v}" data-act="view" data-arg="${v}" d="${sectorPath(C, C, R_VIEW[0], R_VIEW[1], inner[i], 2)}" style="--i:${i}"/>`,
    btn: `<button class="rbtn vbtn" data-k="view-${v}" data-act="view" data-arg="${v}" role="menuitemradio" aria-checked="false" aria-label="${VIEW_LABEL[v]}（${i + 1}）" style="${pos(viewMid, inner[i].mid)};--i:${i}">
        ${VIEW_ICON[v]}<span class="tip">${VIEW_SHORT[v]}<kbd>${i + 1}</kbd></span></button>`,
  }));
  $('#radial').innerHTML = `
    <div class="radial-backdrop" data-act="menuClose"></div>
    <div class="wheel" role="menu" aria-label="菜单">
      <svg viewBox="0 0 400 400" aria-hidden="true">
        <circle class="wheel-bg" cx="${C}" cy="${C}" r="${R_RING[1] + 3}"/>
        ${items.map((x) => x.path).join('')}${views.map((x) => x.path).join('')}
        <circle class="sec-center" cx="${C}" cy="${C}" r="${R_CENTER}" data-act="menuClose"/>
      </svg>
      ${items.map((x) => x.btn).join('')}${views.map((x) => x.btn).join('')}
      <button class="radial-center" data-act="menuClose" aria-label="收起菜单">
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>`;
  // 指针移到图标上 / 键盘聚焦图标时，高亮它所在的整块扇区
  const wheel = $('#radial');
  const hl = (e: Event, on: boolean) => {
    const k = (e.target as HTMLElement).closest?.<HTMLElement>('.rbtn')?.dataset.k;
    if (k) wheel.querySelector(`path[data-k="${k}"]`)?.classList.toggle('hl', on);
  };
  wheel.addEventListener('pointerover', (e) => hl(e, true));
  wheel.addEventListener('pointerout', (e) => hl(e, false));
  wheel.addEventListener('focusin', (e) => hl(e, true));
  wheel.addEventListener('focusout', (e) => hl(e, false));
}

// ---------- 圆形菜单开合 ----------
let menuReturnFocus: HTMLElement | null = null;

export const menuOpen = () => !$('#radial').hidden;

/** 展开圆形菜单；键盘打开时把焦点放到第一格 */
export function openMenu(viaKeyboard = false) {
  if (drawers.closeAll()) syncDrawers();
  const a = document.activeElement;
  menuReturnFocus = a instanceof HTMLElement && a !== document.body ? a : null;
  const r = $('#radial');
  r.hidden = false;
  $('#hub').setAttribute('aria-expanded', 'true');
  $('#hub').setAttribute('aria-label', '收起菜单（M）');
  if (viaKeyboard) r.querySelector<HTMLButtonElement>('.rbtn')?.focus({ preventScroll: true });
}

/** 收起圆形菜单；restoreFocus：焦点还回打开前的位置（选了抽屉时不还，让抽屉接手） */
export function closeMenu(restoreFocus = true): boolean {
  const r = $('#radial');
  if (r.hidden) return false;
  r.hidden = true;
  $('#hub').setAttribute('aria-expanded', 'false');
  $('#hub').setAttribute('aria-label', '打开菜单（M）');
  r.querySelectorAll('.hl').forEach((p) => p.classList.remove('hl'));
  const back = restoreFocus && menuReturnFocus?.isConnected ? menuReturnFocus : null;
  menuReturnFocus = null;
  back?.focus({ preventScroll: true });
  return true;
}

/** 菜单里用方向键绕圈移动焦点：右 / 下顺时针，左 / 上逆时针；在内圈就在内圈里转，外圈同理 */
export function menuArrow(code: string): boolean {
  const step = code === 'ArrowRight' || code === 'ArrowDown' ? 1 : code === 'ArrowLeft' || code === 'ArrowUp' ? -1 : 0;
  if (!step) return false;
  const cur = document.activeElement as HTMLElement | null;
  const ringSel = cur?.classList.contains('vbtn') ? '.vbtn' : '.rbtn:not(.vbtn)';
  const list = [...$('#radial').querySelectorAll<HTMLButtonElement>(ringSel)];
  const i = cur ? list.indexOf(cur as HTMLButtonElement) : -1;
  list[i < 0 ? 0 : (i + step + list.length) % list.length]?.focus({ preventScroll: true });
  return true;
}

/** 按 drawers 的状态开合抽屉、高亮菜单里对应的格子 */
export function syncDrawers() {
  for (const side of ['left', 'right'] as const) {
    const open = drawers.open[side];
    const panel = $(`#drawer-${side}`);
    if (panel.hidden !== !open) panel.hidden = !open;
    panel.querySelectorAll<HTMLElement>('section[data-tab]').forEach((s) => {
      const on = s.dataset.tab === open;
      if (s.classList.contains('active') !== on) s.classList.toggle('active', on);
    });
    if (open) {
      panel.setAttribute('aria-label', DRAWERS[open].label);
      $(`#drawer-${side}-title`).textContent = DRAWERS[open].label;
    }
  }
  // 抽屉的遮罩：有抽屉开着才显示，点遮罩收起（手机是 action sheet 的遮罩，PC 透明，只用来点外面收起）
  const any = !!(drawers.open.left || drawers.open.right);
  const bd = $('#sheet-backdrop');
  if (bd.hidden !== !any) bd.hidden = !any;
  document.querySelectorAll<HTMLElement>('#radial [data-act="drawer"]').forEach((b) => {
    const on = drawers.isOpen(b.dataset.arg as DrawerTab);
    if (b.classList.contains('on') !== on) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
    }
  });
}

/** 图标角标：文字为空就隐藏；hot 时跳动提醒 */
export function setBadge(key: string, text: string, hot = false) {
  const b = document.querySelector<HTMLElement>(`.badge[data-badge="${key}"]`);
  if (!b) return;
  if (b.textContent !== text) b.textContent = text;
  if (b.hidden !== !text) b.hidden = !text;
  if (b.classList.contains('hot') !== hot) b.classList.toggle('hot', hot);
  // 罗盘上的小红点：菜单里有要处理的事（跳动的角标或“!”）就亮，提示点开看看
  const dot = document.querySelector<HTMLElement>('#hub .hub-dot');
  if (!dot) return;
  const need = [...document.querySelectorAll<HTMLElement>('#radial .badge')].some((x) => !x.hidden && (x.classList.contains('hot') || x.textContent === '!'));
  if (dot.hidden !== !need) dot.hidden = !need;
}

/** 指针动画由 JS 逐帧驱动（不用 CSS 过渡）：随时知道指针此刻的真实角度，连切时从这里走最短弧（GPT 审核 #90） */
const needle = { shown: 0, from: 0, to: 0, t0: 0, raf: 0 };
const NEEDLE_MS = 650;
/** 带一点回弹的缓出（easeOutBack），对应原先 CSS 的 --spring */
const easeOutBack = (x: number) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const reduceQuery = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
const reduceMotion = () => reduceQuery?.matches ?? false;
// 转动途中开启“减少动态效果”：立即停下并对齐目标（GPT 审核 #90 第 2 轮）
reduceQuery?.addEventListener?.('change', (e) => {
  if (!e.matches || !needle.raf) return;
  cancelAnimationFrame(needle.raf);
  needle.raf = 0;
  needle.shown = needle.to;
  const box = document.querySelector<HTMLElement>('#views');
  if (box) drawNeedle(box);
});

function drawNeedle(box: HTMLElement) {
  box.querySelector<HTMLElement>('.needle')!.style.transform = `rotate(${needle.shown}deg)`;
}

function spinNeedle(box: HTMLElement, to: number) {
  needle.from = needle.shown;
  needle.to = to;
  needle.t0 = performance.now();
  cancelAnimationFrame(needle.raf);
  if (reduceMotion()) {
    needle.shown = to;
    drawNeedle(box);
    return;
  }
  const step = (now: number) => {
    // 每帧都查一次：转动途中开启“减少动态效果”，下一帧就对齐目标（不只依赖 change 事件）
    const x = reduceMotion() ? 1 : Math.min(1, (now - needle.t0) / NEEDLE_MS);
    needle.shown = needle.from + (needle.to - needle.from) * easeOutBack(x);
    drawNeedle(box);
    needle.raf = x < 1 ? requestAnimationFrame(step) : 0;
  };
  needle.raf = requestAnimationFrame(step);
}

let shownView: View | null = null;

export function syncCompass(cv: View) {
  if (shownView === cv) return;
  shownView = cv;
  const box = $('#views');
  // 以指针此刻实际显示的角度为起点（上一段转动可能还没转完），再走最短的一边（GPT 审核 #90）
  spinNeedle(box, needleTurn(needle.shown, cv));
  box.querySelectorAll<HTMLElement>('.pt').forEach((p) => p.classList.toggle('on', p.dataset.arg === cv));
  document.querySelectorAll<HTMLElement>('#radial [data-act="view"]').forEach((b) => {
    const on = b.dataset.arg === cv;
    b.classList.toggle('on', on);
    if (b instanceof HTMLButtonElement) b.setAttribute('aria-checked', String(on));
  });
  const label = box.querySelector<HTMLElement>('.compass-label')!;
  label.textContent = VIEW_LABEL[cv];
  // 换视图时罗盘轻轻一晃
  box.classList.remove('wobble');
  void box.offsetWidth;
  box.classList.add('wobble');
}

// ---------- 快捷键引导 ----------
export function guideHtml(): string {
  let n = 0;
  const key = (k: string) => `<kbd style="--k:${n++}">${k}</kbd>`;
  return `
    <div class="guide-head">
      <span class="guide-badge">${ICON.keys}</span>
      <div><h2>快捷键入门</h2><p class="hint">记住几个就能玩。所有菜单都收在底栏罗盘里，点一下就展开。之后按 <kbd>H</kbd> 或点右上角的键盘图标随时再看。</p></div>
    </div>
    <div class="guide-grid">${SHORTCUTS.map(
      (g) => `<section><h3>${g.title}</h3>${g.rows
        .map((r) => `<div class="guide-row"><span class="ks">${r.keys.map(key).join('')}</span><span>${r.what}</span></div>`)
        .join('')}</section>`,
    ).join('')}</div>
    <div class="row"><button class="primary" data-act="guideClose">开始露营</button></div>`;
}

let guideReturnFocus: HTMLElement | null = null;

export function openGuide() {
  const g = $('#guide');
  // 记下打开前的焦点，关掉后还回去（顶栏按钮打开时就回到顶栏按钮）
  const a = document.activeElement;
  guideReturnFocus = a instanceof HTMLElement && a !== document.body ? a : null;
  g.innerHTML = guideHtml();
  g.hidden = false;
  g.querySelector<HTMLButtonElement>('[data-act="guideClose"]')?.focus({ preventScroll: true });
}

export function closeGuide() {
  $('#guide').hidden = true;
  const back = guideReturnFocus?.isConnected ? guideReturnFocus : null;
  guideReturnFocus = null;
  back?.focus({ preventScroll: true });
}

export const guideOpen = () => !$('#guide').hidden;
