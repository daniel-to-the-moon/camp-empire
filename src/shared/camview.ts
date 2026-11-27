/**
 * 视图与相机（issue #44 第 1–3 项；用户 2026-11-08 拍板：四种视图、引擎盖视角、触屏单指环绕 / 双指缩放）。
 * 纯函数，不依赖 three；输出 three 坐标 [x, 高度, z]（three.z = −逻辑 y，见 scene.ts）。
 *
 * 视图：
 * - overview 俯瞰：固定高角度看整个营地；
 * - follow 跟随：车后上方，随车头朝向；
 * - orbit 环绕：以车身中心为轴心，水平 360° 环绕（方位角不随车头转），俯仰与距离有上下限，相机永远在地面以上；
 * - hood 引擎盖：相机在风挡前方、引擎盖上方（不做驾驶员眼位与内饰），能看到引擎盖与前方路面。
 */
import type { Variant } from '../data/models';
import { computeLayout } from '../geometry/layout';

export type View = 'overview' | 'follow' | 'orbit' | 'hood';
/**
 * 菜单与 1–3 键可选的视图（用户 2026-11-27：默认跟随、加驾驶舱视图，环绕拖拽是默认就有的功能）：
 * 跟随（默认）· 驾驶舱 · 俯瞰。环绕不再单独作为一个视图来选：任何视图里在画面上拖拽 / 滚轮 / 双指，
 * 镜头就从当前位置接着转（进入 orbit 状态），按 1–3 或 V 回到选的视图。
 */
export const VIEWS: readonly View[] = ['follow', 'hood', 'overview'];
export const VIEW_LABEL: Record<View, string> = { overview: '俯瞰', follow: '跟随', orbit: '自由环绕', hood: '驾驶舱' };

export type V3 = [number, number, number];

export interface CamWant {
  pos: V3;
  look: V3;
  /** 垂直视场（度） */
  fov: number;
  /** 趋近速率 1/s（指数平滑）；Infinity = 直接到位（引擎盖视角必须贴车，否则相机会落后到车身里） */
  rate: number;
  /** 近裁剪面 m */
  near: number;
  /**
   * 碰撞震屏作用在哪里：'pos' = 抖相机位置（第三人称视图）；'look' = 只抖看向点、相机位置不动
   *（引擎盖视角：相机离机盖顶面只有 0.3 m，位置抖动最大 0.35 m 会把相机推进车体，GPT 审核 #48）。
   */
  shake: 'pos' | 'look';
}

/** 震屏最大位移 m（满强度时；强度按平方衰减），与改动前 scene.ts 的数值相同 */
export const SHAKE_MAX_M = 0.35;

/** 震屏的三轴单位抖动（每轴 ∈ [−1, 1]），t 为场景时间 s */
export function shakeWave(t: number): V3 {
  return [Math.sin(t * 61), Math.sin(t * 47 + 1.3), Math.cos(t * 53)];
}

/**
 * 叠加震屏后的最终相机位置与看向点（scene.ts 每帧调用；纯函数便于测试）。
 * amount ∈ [0, 1] 为当前震屏强度；位移幅度 = amount² × SHAKE_MAX_M。
 */
export function applyShake(pos: V3, look: V3, mode: CamWant['shake'], t: number, amount: number): { pos: V3; look: V3 } {
  const a = Math.min(1, Math.max(0, amount)) ** 2 * SHAKE_MAX_M;
  if (a <= 0) return { pos: [...pos], look: [...look] };
  const w = shakeWave(t);
  const off: V3 = [w[0] * a, w[1] * a, w[2] * a];
  const add = (p: V3): V3 => [p[0] + off[0], p[1] + off[1], p[2] + off[2]];
  return mode === 'pos' ? { pos: add(pos), look: [...look] } : { pos: [...pos], look: add(look) };
}

export const BASE_FOV = 45;

/** 环绕参数【提案】：距离与俯仰上下限 */
export const ORBIT = {
  minDist: 6,
  /** 最远 40 m：营地 68 × 66 m，从任何位置看车都不会远到看不清车（不飞出营地范围太多） */
  maxDist: 40,
  /** 俯仰（相机在目标上方的仰角）下限 8°：最低时相机高度 = 目标高 + 6 × sin 8° ≈ +0.84 m，不贴地、不穿地 */
  minPitch: (8 * Math.PI) / 180,
  maxPitch: (80 * Math.PI) / 180,
  /** 相机离地最低高度 m（双保险） */
  minHeight: 0.5,
  /** 拖拽灵敏度：每像素转动的弧度【提案】 */
  radPerPx: 0.008,
  /** 滚轮：每单位 deltaY 的缩放指数【提案】 */
  wheelZoom: 0.0015,
  rate: 10,
} as const;

export interface Orbit {
  /** 方位角（逻辑平面，弧度）：相机在目标的哪个方向，0 = 东；世界固定，不随车转 */
  azimuth: number;
  pitch: number;
  dist: number;
}

export function clampOrbit(o: Orbit): Orbit {
  const pitch = Math.min(ORBIT.maxPitch, Math.max(ORBIT.minPitch, o.pitch));
  // NaN 视为最近；±Infinity 由 min / max 自然夹到上下限
  const dist = Math.min(ORBIT.maxDist, Math.max(ORBIT.minDist, Number.isNaN(o.dist) ? ORBIT.minDist : o.dist));
  const az = Number.isFinite(o.azimuth) ? Math.atan2(Math.sin(o.azimuth), Math.cos(o.azimuth)) : 0;
  return { azimuth: az, pitch, dist };
}

/** 沿短弧平滑方位角，同时平滑仰角和距离，避免世界坐标插值的弦穿过车身。 */
export function smoothOrbit(current: Orbit, target: Orbit, dt: number): Orbit {
  const weight = 1 - Math.exp(-dt * ORBIT.rate);
  const delta = target.azimuth - current.azimuth;
  const turn = Math.atan2(Math.sin(delta), Math.cos(delta));
  return clampOrbit({
    azimuth: current.azimuth + turn * weight,
    pitch: current.pitch + (target.pitch - current.pitch) * weight,
    dist: current.dist + (target.dist - current.dist) * weight,
  });
}

/**
 * 从镜头当前的位置起转（任何视图里一拖就转，不跳）：由 three 坐标的相机位置反推环绕参数，再夹到上下限。
 * 俯瞰 / 驾驶舱离环绕的范围较远，夹完会有一点位移，但方位保持一致。
 */
export function orbitFrom(pos: V3, t: Pick<Target, 'x' | 'y'>): Orbit {
  const dx = pos[0] - t.x;
  const dy = -pos[2] - t.y;
  const up = pos[1] - ORBIT_LOOK_H;
  const horiz = Math.hypot(dx, dy);
  return clampOrbit({ azimuth: Math.atan2(dy, dx), pitch: Math.atan2(up, horiz), dist: Math.hypot(horiz, up) });
}

/** 进入环绕时的初始角度：在车后方、与跟随视图相近 */
export function orbitBehind(yaw: number): Orbit {
  return clampOrbit({ azimuth: yaw + Math.PI, pitch: (28 * Math.PI) / 180, dist: 16 });
}

export interface Target {
  /** 车身中心（逻辑坐标） */
  x: number;
  y: number;
  yaw: number;
  /** 车长 / 4：跟随视图按车长拉远 */
  h: number;
}

/** 环绕视图看向的点：车身中心上方 1 m */
const ORBIT_LOOK_H = 1;

export function orbitCam(t: Target, o: Orbit): CamWant {
  const c = clampOrbit(o);
  const horiz = c.dist * Math.cos(c.pitch);
  const px = t.x + horiz * Math.cos(c.azimuth);
  const py = t.y + horiz * Math.sin(c.azimuth);
  const ph = Math.max(ORBIT.minHeight, ORBIT_LOOK_H + c.dist * Math.sin(c.pitch));
  // 环绕参数已经平滑，渲染层直接使用这个位置。
  return { pos: [px, ph, -py], look: [t.x, ORBIT_LOOK_H, -t.y], fov: BASE_FOV, rate: Infinity, near: 0.1, shake: 'pos' };
}

export function overviewCam(): CamWant {
  return { pos: [0, 62, 38], look: [0, 0, 4], fov: BASE_FOV, rate: 3.5, near: 0.1, shake: 'pos' };
}

/** 跟随：与改动前的参数相同（车后 13 + h、上方 7 + h，看向车前 4 m） */
export function followCam(t: Target): CamWant {
  const back = 13 + t.h;
  const dx = Math.cos(t.yaw);
  const dy = Math.sin(t.yaw);
  return {
    pos: [t.x - dx * back, 7 + t.h, -(t.y - dy * back)],
    look: [t.x + dx * 4, 1, -(t.y + dy * 4)],
    fov: BASE_FOV,
    rate: 3.5,
    near: 0.1,
    shake: 'pos',
  };
}

/** 引擎盖视角参数【提案】 */
export const HOOD = {
  /** 相机高于机盖顶面 m */
  aboveHoodM: 0.3,
  /** 相机在风挡底边前方 m（风挡后倾，越往上离相机越远） */
  aheadOfWindshieldM: 0.02,
  /** 下俯角（度） */
  pitchDownDeg: 6,
  fov: 60,
  near: 0.05,
} as const;

export interface HoodMount {
  /** 车身局部坐标：forward = 相对车身中心沿车头方向 m，height = 离地 m */
  forward: number;
  height: number;
}

/** 引擎盖相机在车身局部坐标里的位置（由占位几何布局推出，正式模型替换时按同名尺寸重算） */
export function hoodMount(v: Variant): HoodMount {
  const lay = computeLayout(v);
  const [wsZ, wsY] = lay.windshield.bottom;
  return { forward: wsZ + HOOD.aheadOfWindshieldM, height: wsY - 0.1 + HOOD.aboveHoodM };
}

export function hoodCam(t: Target, m: HoodMount): CamWant {
  const dx = Math.cos(t.yaw);
  const dy = Math.sin(t.yaw);
  const px = t.x + dx * m.forward;
  const py = t.y + dy * m.forward;
  const ahead = 20;
  const lookH = m.height - ahead * Math.tan((HOOD.pitchDownDeg * Math.PI) / 180);
  return { pos: [px, m.height, -py], look: [px + dx * ahead, lookH, -(py + dy * ahead)], fov: HOOD.fov, rate: Infinity, near: HOOD.near, shake: 'look' };
}

export function camFor(view: View, t: Target, o: Orbit, m: HoodMount): CamWant {
  switch (view) {
    case 'overview':
      return overviewCam();
    case 'follow':
      return followCam(t);
    case 'orbit':
      return orbitCam(t, o);
    case 'hood':
      return hoodCam(t, m);
  }
}

/** 默认视图：跟随（用户 2026-11-27 改：“默认跟随模式和驾驶舱视图；环绕拖拽是默认的功能”，取代 #82 的默认环绕） */
export const DEFAULT_VIEW: View = 'follow';

/**
 * 当前生效的视图：进入游戏、停回家位时都回到默认的跟随；
 * 玩家手动选了别的视图（停着或行驶中都算）就按玩家选的来，直到下次停回家位。
 * `parked` 参数保留给调用方，生效规则已与停 / 开无关。
 */
export class ViewChoice {
  chosen: View;

  constructor(initial: View = DEFAULT_VIEW) {
    this.chosen = initial;
  }

  select(v: View, _parked: boolean): void {
    this.chosen = v;
  }

  /** 停回家位那一刻调用：回到默认视图（跟随） */
  onParked(): void {
    this.chosen = DEFAULT_VIEW;
  }

  effective(_parked: boolean): View {
    return this.chosen;
  }

  /** V 键：按 VIEWS 顺序切到下一个；正在自由环绕时回到第一个（跟随） */
  next(parked: boolean): View {
    const cur = this.effective(parked);
    return VIEWS[(VIEWS.indexOf(cur) + 1) % VIEWS.length];
  }
}

/** 键位：1–3 直选（跟随 · 驾驶舱 · 俯瞰），V 循环；C 保留旧习惯（俯瞰 ↔ 跟随） */
export function viewForKey(code: string, cur: View): View | 'next' | null {
  const i = ['Digit1', 'Digit2', 'Digit3'].indexOf(code);
  if (i >= 0) return VIEWS[i];
  if (code === 'KeyV') return 'next';
  if (code === 'KeyC') return cur === 'overview' ? 'follow' : 'overview';
  return null;
}

/**
 * 场景画面上的指针手势（触屏与鼠标共用）。规则（#44 用户裁决“与驾驶操作不冲突”）：
 * - 任何视图都生效（2026-11-27 起环绕拖拽是默认功能）：一拖就从镜头当前位置进入自由环绕（orbitFrom）。
 * - 手势只来自场景画面（#stage）；驾驶用键盘或底栏 / 面板按钮，它们不在场景画面上，所以拖拽不会误触驾驶，按按钮也不会转相机。
 * - 单指（或鼠标左键）拖拽：水平方向改方位角、竖直方向改俯仰；
 * - 双指：只按两指间距缩放（张开拉近），双指期间不旋转；从双指抬起一指后，剩下那指重新起算，不会跳。
 */
export class OrbitGesture {
  private pts = new Map<number, [number, number]>();
  private span = 0;

  down(id: number, x: number, y: number): void {
    this.pts.set(id, [x, y]);
    this.span = this.currentSpan();
  }

  up(id: number): void {
    this.pts.delete(id);
    this.span = this.currentSpan();
  }

  get active(): number {
    return this.pts.size;
  }

  /** 返回本次移动对环绕状态的改变；不是本手势跟踪的指针返回 null */
  move(id: number, x: number, y: number, o: Orbit): Orbit | null {
    const prev = this.pts.get(id);
    if (!prev) return null;
    this.pts.set(id, [x, y]);
    if (this.pts.size === 1) {
      return clampOrbit({
        azimuth: o.azimuth - (x - prev[0]) * ORBIT.radPerPx,
        pitch: o.pitch + (y - prev[1]) * ORBIT.radPerPx,
        dist: o.dist,
      });
    }
    const s = this.currentSpan();
    const out = this.span > 1 && s > 1 ? clampOrbit({ ...o, dist: (o.dist * this.span) / s }) : o;
    this.span = s;
    return out;
  }

  private currentSpan(): number {
    if (this.pts.size < 2) return 0;
    const [a, b] = [...this.pts.values()];
    return Math.hypot(a[0] - b[0], a[1] - b[1]);
  }
}

export function wheelZoom(o: Orbit, deltaY: number): Orbit {
  return clampOrbit({ ...o, dist: o.dist * Math.exp(deltaY * ORBIT.wheelZoom) });
}
