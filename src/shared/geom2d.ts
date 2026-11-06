/** 平面碰撞：凸多边形（分离轴定理）与圆。纯函数。 */

export type Pt = [number, number];

export type Shape =
  | { type: 'poly'; pts: Pt[]; tag: string }
  | { type: 'circle'; c: Pt; r: number; tag: string };

/** 中心 + 朝向 + 长宽 → 矩形四角（逆时针） */
export function rect(cx: number, cy: number, yaw: number, length: number, width: number): Pt[] {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const hl = length / 2;
  const hw = width / 2;
  return (
    [
      [-hl, -hw],
      [hl, -hw],
      [hl, hw],
      [-hl, hw],
    ] as Pt[]
  ).map(([u, v]) => [cx + u * c - v * s, cy + u * s + v * c]);
}

function axes(pts: Pt[]): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const nx = -(y2 - y1);
    const ny = x2 - x1;
    const n = Math.hypot(nx, ny);
    out.push([nx / n, ny / n]);
  }
  return out;
}

function project(pts: Pt[], [ax, ay]: Pt): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const [x, y] of pts) {
    const d = x * ax + y * ay;
    if (d < lo) lo = d;
    if (d > hi) hi = d;
  }
  return [lo, hi];
}

export function polysOverlap(a: Pt[], b: Pt[]): boolean {
  for (const ax of [...axes(a), ...axes(b)]) {
    const [a0, a1] = project(a, ax);
    const [b0, b1] = project(b, ax);
    if (a1 <= b0 || b1 <= a0) return false;
  }
  return true;
}

/** 点到线段距离 */
export function distPointSeg([px, py]: Pt, [x1, y1]: Pt, [x2, y2]: Pt): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / l2));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

export function pointInPoly([px, py]: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function polyCircleOverlap(pts: Pt[], c: Pt, r: number): boolean {
  if (pointInPoly(c, pts)) return true;
  for (let i = 0; i < pts.length; i++) {
    if (distPointSeg(c, pts[i], pts[(i + 1) % pts.length]) < r) return true;
  }
  return false;
}

export function hits(poly: Pt[], shape: Shape): boolean {
  return shape.type === 'poly' ? polysOverlap(poly, shape.pts) : polyCircleOverlap(poly, shape.c, shape.r);
}

/** 返回第一个碰到的障碍物，没碰到返回 null */
export function firstHit(poly: Pt[], shapes: Shape[]): Shape | null {
  for (const s of shapes) if (hits(poly, s)) return s;
  return null;
}

export interface Penetration {
  /** 单位法线：从障碍物指向车（把车沿 n 推出 depth 即分离） */
  n: Pt;
  depth: number;
  shape: Shape;
}

function centroid(pts: Pt[]): Pt {
  let x = 0;
  let y = 0;
  for (const p of pts) {
    x += p[0];
    y += p[1];
  }
  return [x / pts.length, y / pts.length];
}

/** 最近点（多边形边界上） */
function closestOnPoly(c: Pt, pts: Pt[]): Pt {
  let best: Pt = pts[0];
  let bd = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % pts.length];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const l2 = dx * dx + dy * dy;
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((c[0] - x1) * dx + (c[1] - y1) * dy) / l2));
    const q: Pt = [x1 + t * dx, y1 + t * dy];
    const d = Math.hypot(q[0] - c[0], q[1] - c[1]);
    if (d < bd) {
      bd = d;
      best = q;
    }
  }
  return best;
}

/** 车（凸多边形）与一个障碍物的穿透：分离轴最小重叠方向。不相交返回 null。 */
export function penetration(car: Pt[], shape: Shape): Penetration | null {
  const cc = centroid(car);
  if (shape.type === 'circle') {
    const inside = pointInPoly(shape.c, car);
    const q = closestOnPoly(shape.c, car);
    const d = Math.hypot(q[0] - shape.c[0], q[1] - shape.c[1]);
    if (!inside && d >= shape.r) return null;
    // 圆心在车外：法线 = 圆心 → 车上最近点；圆心已进到车内：用圆心 → 车中心
    let nx = inside ? cc[0] - shape.c[0] : q[0] - shape.c[0];
    let ny = inside ? cc[1] - shape.c[1] : q[1] - shape.c[1];
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
    // 深度：车在 n 方向上最靠近圆心的投影 与 圆的远端 之差
    let lo = Infinity;
    for (const [x, y] of car) lo = Math.min(lo, (x - shape.c[0]) * nx + (y - shape.c[1]) * ny);
    return { n: [nx, ny], depth: shape.r - lo, shape };
  }
  let best: Penetration | null = null;
  for (const ax of [...axes(car), ...axes(shape.pts)]) {
    const [a0, a1] = project(car, ax);
    const [b0, b1] = project(shape.pts, ax);
    const overlap = Math.min(a1, b1) - Math.max(a0, b0);
    if (overlap <= 0) return null;
    if (!best || overlap < best.depth) {
      // 方向：车相对障碍物所在的一侧
      const sign = (a0 + a1) / 2 >= (b0 + b1) / 2 ? 1 : -1;
      best = { n: [ax[0] * sign, ax[1] * sign], depth: overlap, shape };
    }
  }
  return best;
}
