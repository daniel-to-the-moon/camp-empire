/**
 * 收起式控制面板与首次快捷键引导（纯逻辑，界面见 src/client/hud.ts）。
 * - 所有菜单收进底栏的菜单钮：点菜单钮（或按 M）展开一个圆形菜单，内圈四个视图、外圈其余功能，平均分在各扇区。
 *   选中抽屉类功能后圆形菜单收起、抽屉打开（手机是底部 action sheet，PC 是浮层），一次只开一个；Esc 收起。
 * - 指南针（和菜单钮分开，只显示朝向、不能点）实时感应镜头朝向：盘面和指针跟着镜头转，红色指针始终指向营地的北（cameraHeading / dialTurn）。
 * - 首次打开显示快捷键引导；看过后记在 localStorage，之后可用顶栏的 ? 按钮或 H / ? 键再打开。
 */

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

/**
 * 指南针实时朝向：镜头此刻“画面上方”对着的地面方位角（度，顺时针，0 = 北 = three 的 −Z，90 = 东 = +X）。
 * q 为镜头的朝向四元数 { x, y, z, w }。镜头斜着看时取前方（−Z 轴）在地面的投影；
 * 几乎正俯视时前方投影太短，改用镜头上方（+Y 轴）的投影，也就是画面上方在地面的方向。两者都退化时返回 null。
 */
export function cameraHeading(q: { x: number; y: number; z: number; w: number }): number | null {
  const { x, y, z, w } = q;
  // 四元数旋转后的 −Z 轴与 +Y 轴，只取地面分量（x、z）
  const fx = -2 * (x * z + w * y);
  const fz = -(1 - 2 * (x * x + y * y));
  const ux = 2 * (x * y - w * z);
  const uz = 2 * (y * z + w * x);
  const [gx, gz] = Math.hypot(fx, fz) >= 0.2 ? [fx, fz] : [ux, uz];
  if (Math.hypot(gx, gz) < 1e-6) return null;
  const deg = (Math.atan2(gx, -gz) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 指南针盘面的转角：镜头朝向 h 时，正北在画面上偏 −h；累计角度走最短弧，跨过 0° / 360° 时不倒转一整圈 */
export function dialTurn(prev: number, heading: number): number {
  const target = -heading;
  let d = (((target - prev) % 360) + 540) % 360 - 180;
  if (d === -180) d = 180;
  return prev + d;
}

// ---------- 圆形菜单（点菜单钮展开） ----------
/** 外圈：除视图以外的全部功能；顺时针从正北开始排，平均分扇区 */
export type MenuItem = { tab: DrawerTab; act?: never } | { act: 'card' | 'dex' | 'privacy'; tab?: never };
export const RING_ITEMS: (MenuItem & { label: string })[] = [
  { tab: 'pending', label: '待收取' },
  { tab: 'daily', label: '每日' },
  { tab: 'spots', label: '车位' },
  { tab: 'log', label: '流水' },
  { act: 'card', label: '卡片' },
  { act: 'dex', label: '图鉴' },
  { act: 'privacy', label: '隐私' },
  { tab: 'shop', label: '小卖部' },
  { tab: 'garage', label: '车库' },
];

export interface Sector {
  /** 扇区起止角（度，顺时针，0 = 北） */
  from: number;
  to: number;
  /** 扇区中线角，图标放在这条线上 */
  mid: number;
}

/** n 个等分扇区，第一个以正北为中线 */
export function ringSectors(n: number): Sector[] {
  const w = 360 / n;
  return Array.from({ length: n }, (_, i) => ({ from: i * w - w / 2, to: i * w + w / 2, mid: i * w }));
}

/** 极坐标（度，顺时针，0 = 北）转成以 (cx, cy) 为圆心的屏幕坐标 */
export function polar(cx: number, cy: number, r: number, deg: number): [number, number] {
  const a = (deg * Math.PI) / 180;
  return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
}

/** 圆环扇区的 SVG 路径：内半径 r0、外半径 r1，两侧各让出 gap 度留缝 */
export function sectorPath(cx: number, cy: number, r0: number, r1: number, s: Sector, gap = 1.2): string {
  const a = s.from + gap;
  const b = s.to - gap;
  const large = b - a > 180 ? 1 : 0;
  const f = (n: number) => Math.round(n * 100) / 100;
  const [x0, y0] = polar(cx, cy, r1, a);
  const [x1, y1] = polar(cx, cy, r1, b);
  const [x2, y2] = polar(cx, cy, r0, b);
  const [x3, y3] = polar(cx, cy, r0, a);
  return `M${f(x0)} ${f(y0)}A${r1} ${r1} 0 ${large} 1 ${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}A${r0} ${r0} 0 ${large} 0 ${f(x3)} ${f(y3)}Z`;
}

/** 打开 / 收起圆形菜单的按键：M */
export const isMenuKey = (e: { code: string }): boolean => e.code === 'KeyM';

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
      { keys: ['点菜单', 'M'], what: '展开圆形菜单：视图和全部功能都在里面' },
      { keys: ['Esc'], what: '收起菜单 / 面板 / 引导' },
      { keys: ['H', '?'], what: '随时再看这份引导' },
    ],
  },
];
