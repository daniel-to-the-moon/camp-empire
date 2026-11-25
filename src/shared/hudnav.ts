/**
 * 收起式控制面板与首次快捷键引导（纯逻辑，界面见 src/client/hud.ts）。
 * - 左右两侧只留一列图标；点图标展开对应抽屉，再点或按 Esc 收起。每侧同一时间只开一个抽屉。
 * - 底栏的视图切换做成罗盘：四个视图在四个方位，指针转到当前视图。
 * - 首次打开显示快捷键引导；看过后记在 localStorage，之后可用顶栏的 ? 按钮或 H / ? 键再打开。
 */
import { VIEWS, type View } from './camview';

export type Side = 'left' | 'right';
export type DrawerTab = 'garage' | 'shop' | 'pending' | 'spots' | 'daily' | 'log';

export const DRAWERS: Record<DrawerTab, { side: Side; label: string }> = {
  garage: { side: 'left', label: '车库' },
  shop: { side: 'left', label: '营地小卖部' },
  pending: { side: 'right', label: '待收取' },
  spots: { side: 'right', label: '我的营地车位' },
  daily: { side: 'right', label: '每日' },
  log: { side: 'right', label: '流水' },
};

/** 窄于这个宽度（与 style.css 的窄屏断点一致）时两侧抽屉互斥 */
export const NARROW_PX = 760;

export const isDrawerTab = (s: string): s is DrawerTab => Object.prototype.hasOwnProperty.call(DRAWERS, s);

/** 两侧抽屉的开合状态：每侧最多开一个 */
export class Drawers {
  open: Record<Side, DrawerTab | null> = { left: null, right: null };

  /**
   * 点图标：没开就打开（同侧其他抽屉收起），已开就收起。返回点完后它是否打开。
   * exclusive：窄屏两侧抽屉会互相挡住，打开一侧时把另一侧也收起。
   */
  toggle(tab: DrawerTab, exclusive = false): boolean {
    const side = DRAWERS[tab].side;
    this.open[side] = this.open[side] === tab ? null : tab;
    if (exclusive && this.open[side]) this.open[side === 'left' ? 'right' : 'left'] = null;
    return this.open[side] === tab;
  }

  /** 收起全部；返回是否真的收起了什么（Esc 先收抽屉，没有可收的才交给别的弹层） */
  closeAll(): boolean {
    const any = this.open.left !== null || this.open.right !== null;
    this.open = { left: null, right: null };
    return any;
  }

  isOpen(tab: DrawerTab): boolean {
    return this.open[DRAWERS[tab].side] === tab;
  }
}

/** 罗盘：四个视图依次在 北 / 东 / 南 / 西；指针角度（度，顺时针，0 = 北） */
export const compassAngle = (v: View): number => VIEWS.indexOf(v) * 90;

/**
 * 指针从 prev（累计角度）转到 v 的方位，走最短的那一边（±180° 内），
 * 返回新的累计角度：CSS 过渡按累计角度插值，所以从西转到北是 +90°，不会倒转 270°。
 */
export function needleTurn(prev: number, v: View): number {
  const target = compassAngle(v);
  const cur = ((prev % 360) + 360) % 360;
  let d = target - cur;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return prev + d;
}

// ---------- 首次快捷键引导 ----------
export const GUIDE_KEY = 'camp-empire.guideSeen';

interface Prefs {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** 看过引导没有。存储不可用时当作没看过（只影响这一次打开，关掉后本页不会再自动弹） */
export function guideSeen(prefs: Prefs | null): boolean {
  try {
    return prefs?.getItem(GUIDE_KEY) === '1';
  } catch {
    return false;
  }
}

/** 记下已看过；返回是否写入成功 */
export function markGuideSeen(prefs: Prefs | null): boolean {
  try {
    if (!prefs) return false;
    prefs.setItem(GUIDE_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** 重新打开引导的按键：H 或 ?（Shift + /） */
export const isGuideKey = (e: { code: string; key: string }): boolean => e.code === 'KeyH' || e.key === '?';

/** 引导里的快捷键分组；与 main.ts 的键盘处理保持一致（测试会核对按键表） */
export interface ShortcutGroup {
  title: string;
  rows: { keys: string[]; what: string }[];
}

export const SHORTCUTS: ShortcutGroup[] = [
  {
    title: '镜头',
    rows: [
      { keys: ['1', '2', '3', '4'], what: '俯瞰 · 跟随 · 环绕 · 引擎盖' },
      { keys: ['V'], what: '轮换视图' },
      { keys: ['C'], what: '俯瞰 ↔ 跟随' },
    ],
  },
  {
    title: '环绕视图',
    rows: [
      { keys: ['拖拽'], what: '转动镜头' },
      { keys: ['滚轮', '双指'], what: '拉近 / 拉远' },
    ],
  },
  {
    title: '出发与回家',
    rows: [
      { keys: ['O'], what: '开出去兜一圈' },
      { keys: ['P'], what: '自动泊回家位' },
    ],
  },
  {
    title: '驾驶',
    rows: [
      { keys: ['W', 'A', 'S', 'D'], what: '油门 · 转向 · 倒车（方向键也行）' },
      { keys: ['空格'], what: '刹车' },
      { keys: ['Shift'], what: '加速挡' },
    ],
  },
  {
    title: '面板',
    rows: [
      { keys: ['点图标'], what: '展开两侧面板，再点收起' },
      { keys: ['Esc'], what: '收起面板 / 关掉引导' },
      { keys: ['H', '?'], what: '随时再看这份引导' },
    ],
  },
];
