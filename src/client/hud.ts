/**
 * 收起式控制面板的界面层：底栏罗盘、点罗盘展开的圆形菜单、抽屉、快捷键引导（规则见 src/shared/hudnav.ts）。
 * 罗盘与圆形菜单只建一次，之后 renderHud 只改类名 / 角标 / 角度，不重写节点：
 * 重写会打断弹出动画和指针的转动。
 */
import { VIEW_LABEL, VIEWS, type View } from '../shared/camview';
import { DRAWERS, Drawers, dialTurn, polar, RING_ITEMS, ringSectors, sectorPath, SHORTCUTS, type DrawerTab } from '../shared/hudnav';
import { closeButton, ICON } from './icons';

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
  // 页面里写死的右上角关闭钮（卡片、隐私、抽屉）：补上 × 图标
  document.querySelectorAll<HTMLElement>('.x-close').forEach((b) => (b.innerHTML = ICON.close));
  // 底栏罗盘：整个是一个按钮，点一下展开圆形菜单；四个方位的小图标只是示意当前视图
  $('#views').classList.add('compass');
  $('#views').innerHTML = `
    <button id="hub" data-act="menu" aria-haspopup="menu" aria-expanded="false" aria-controls="radial" aria-label="打开菜单（M）" title="菜单（M）">
      <span class="dial" aria-hidden="true">
        <span class="rose"><i></i><i></i><i></i><i></i></span>
        <span class="cd cd-n">北</span>
        <span class="needle"><b></b></span>
      </span>
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

/** 键盘从菜单里选了抽屉：焦点交给抽屉里第一个能点的控件（没有就交给右上角的关闭钮），Tab 不用绕过无关控件（Codex 审核 #102） */
export function focusDrawer(tab: DrawerTab) {
  const panel = $(`#drawer-${DRAWERS[tab].side}`);
  if (panel.hidden) return;
  const first = panel.querySelector<HTMLElement>(
    `section[data-tab="${tab}"] :is(button, a[href], input, select, textarea):not([disabled])`,
  );
  (first ?? panel.querySelector<HTMLElement>('.x-close'))?.focus({ preventScroll: true });
}

/** 按 drawers 的状态开合抽屉、高亮菜单里对应的格子 */
export function syncDrawers() {
  for (const side of ['left', 'right'] as const) {
    const open = drawers.open[side];
    const panel = $(`#drawer-${side}`);
    // 收起时焦点还在抽屉里（键盘用户）：还回罗盘，不丢到页面开头
    if (!open && !panel.hidden && panel.contains(document.activeElement)) $('#hub').focus({ preventScroll: true });
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

/**
 * 罗盘实时朝向：每帧由 main.ts 传入镜头方位角，盘面（刻度 + “北”字）和北针一起转到 −heading，
 * 红针始终指着营地的北。按累计角度走最短弧，跨过正北时不倒转一圈；变化不到 0.3° 不写样式，省重排。
 */
let dialShown = 0;
let dialEl: HTMLElement | null = null;

export function setHeading(heading: number | null) {
  if (heading === null) return;
  const next = dialTurn(dialShown, heading);
  if (Math.abs(next - dialShown) < 0.3 && dialEl) return;
  dialShown = next;
  dialEl ??= document.querySelector<HTMLElement>('#hub .dial');
  if (dialEl) dialEl.style.transform = `rotate(${dialShown.toFixed(1)}deg)`;
}

let shownView: View | null = null;

export function syncCompass(cv: View) {
  if (shownView === cv) return;
  shownView = cv;
  const box = $('#views');
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
    ${closeButton('guideClose')}
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
  g.querySelector<HTMLButtonElement>('.primary[data-act="guideClose"]')?.focus({ preventScroll: true });
}

export function closeGuide() {
  $('#guide').hidden = true;
  const back = guideReturnFocus?.isConnected ? guideReturnFocus : null;
  guideReturnFocus = null;
  back?.focus({ preventScroll: true });
}

export const guideOpen = () => !$('#guide').hidden;
