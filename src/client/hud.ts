/**
 * 收起式控制面板的界面层：图标列、抽屉、罗盘、快捷键引导（规则见 src/shared/hudnav.ts）。
 * 图标列与罗盘只建一次，之后 renderHud 只改类名 / 角标 / 角度，不重写节点：
 * 重写会打断按钮的弹跳动画和指针的转动过渡。
 */
import { VIEW_LABEL, VIEWS, type View } from '../shared/camview';
import { DRAWERS, Drawers, needleTurn, SHORTCUTS, type DrawerTab, type Side } from '../shared/hudnav';
import { ICON } from './icons';

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

interface RailItem {
  /** 抽屉页签；或者直接执行的动作（data-act） */
  tab?: DrawerTab;
  act?: string;
  icon: string;
  label: string;
  id?: string;
}

const RAILS: Record<Side, RailItem[]> = {
  left: [
    { tab: 'garage', icon: ICON.garage, label: '车库' },
    { tab: 'shop', icon: ICON.shop, label: '营地小卖部' },
    { act: 'card', icon: ICON.card, label: '生成露营卡片' },
    { act: 'dex', icon: ICON.dex, label: '车型图鉴', id: 'dex-entry' },
    { act: 'privacy', icon: ICON.privacy, label: '隐私与统计' },
  ],
  right: [
    { tab: 'pending', icon: ICON.pending, label: '待收取' },
    { tab: 'spots', icon: ICON.spots, label: '营地车位' },
    { tab: 'daily', icon: ICON.daily, label: '每日礼物' },
    { tab: 'log', icon: ICON.log, label: '流水' },
  ],
};

const VIEW_ICON: Record<View, string> = { overview: ICON.overview, follow: ICON.follow, orbit: ICON.orbit, hood: ICON.hood };

export const drawers = new Drawers();

/** 建图标列、罗盘、顶栏引导按钮（只调一次） */
export function mountHud() {
  for (const side of ['left', 'right'] as const) {
    $(`#rail-${side}`).innerHTML = RAILS[side]
      .map((it, i) => {
        const act = it.tab ? `data-act="drawer" data-arg="${it.tab}" aria-expanded="false" aria-controls="drawer-${side}"` : `data-act="${it.act}"`;
        return `<button class="rail-btn" ${act} ${it.id ? `id="${it.id}"` : ''} aria-label="${it.label}" style="--i:${i}">
          ${it.icon}<span class="tip">${it.label}</span><i class="badge" data-badge="${it.tab ?? it.act}" hidden></i></button>`;
      })
      .join('');
  }
  $('#help').innerHTML = ICON.keys;
  // 罗盘：四个视图按 北 / 东 / 南 / 西 排开，中间是指针和当前视图名
  $('#views').classList.add('compass');
  $('#views').innerHTML = `
    <div class="rose" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
    <div class="needle" aria-hidden="true"><b></b></div>
    <span class="compass-label" aria-live="polite"></span>
    ${VIEWS.map(
      (v, i) => `<button class="pt pt-${i}" data-act="view" data-arg="${v}" aria-pressed="false" aria-label="${VIEW_LABEL[v]}（${i + 1}）" title="${VIEW_LABEL[v]}（${i + 1}）">
        ${VIEW_ICON[v]}<kbd>${i + 1}</kbd></button>`,
    ).join('')}`;
}

/** 按 drawers 的状态开合抽屉、高亮图标 */
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
      placePopover(panel, side, open);
    }
  }
  // 移动端 action sheet 的遮罩：有抽屉开着才显示，点遮罩收起
  const any = !!(drawers.open.left || drawers.open.right);
  const bd = $('#sheet-backdrop');
  if (bd.hidden !== !any) bd.hidden = !any;
  document.querySelectorAll<HTMLElement>('.rail-btn[data-act="drawer"]').forEach((b) => {
    const on = drawers.isOpen(b.dataset.arg as DrawerTab);
    if (b.classList.contains('on') !== on) {
      b.classList.toggle('on', on);
      b.setAttribute('aria-expanded', String(on));
    }
  });
}

/**
 * PC 端 popover：顶边对齐被点的图标弹出（箭头画在图标上，见 style.css）；放不下时往上挪。
 * 移动端（窄屏）是底部 action sheet，位置交给 CSS，这里设的变量不起作用。
 */
function placePopover(panel: HTMLElement, side: Side, tab: DrawerTab) {
  const btn = document.querySelector<HTMLElement>(`#rail-${side} [data-arg="${tab}"]`);
  if (!btn) return;
  const r = btn.getBoundingClientRect();
  const bottomReserve = 140; // 底栏罗盘的高度
  const minH = Math.min(320, window.innerHeight - 60 - bottomReserve);
  const top = Math.max(56, Math.min(r.top - 14, window.innerHeight - bottomReserve - minH));
  panel.style.setProperty('--pop-top', `${Math.round(top)}px`);
}

/** 图标角标：文字为空就隐藏；hot 时跳动提醒 */
export function setBadge(key: string, text: string, hot = false) {
  const b = document.querySelector<HTMLElement>(`.badge[data-badge="${key}"]`);
  if (!b) return;
  if (b.textContent !== text) b.textContent = text;
  if (b.hidden !== !text) b.hidden = !text;
  if (b.classList.contains('hot') !== hot) b.classList.toggle('hot', hot);
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
  box.querySelectorAll<HTMLButtonElement>('button[data-act="view"]').forEach((b) => {
    const on = b.dataset.arg === cv;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
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
      <div><h2>快捷键入门</h2><p class="hint">记住几个就能玩。之后按 <kbd>H</kbd> 或点右上角的键盘图标随时再看。</p></div>
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
