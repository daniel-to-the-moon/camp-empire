/**
 * 露营卡片营地全景的相机取景（issue #30，GPT 审核 #39 第 1 轮）：按营地边界与截图宽高比计算相机位置，
 * 保证整个营地（含围栏、大门门柱与牌子、车顶高度）都落在截图内。纯数学，不依赖 three，有测试。
 *
 * 坐标为游戏坐标 (x, y, h)：h 向上。游戏 → three 的映射 (x, y, h) → (x, h, -y) 是旋转（行列式 = 1），
 * 叉乘方向不变，所以这里按 three 相机 lookAt 的约定（up = 高度轴）计算的投影与 three 渲染一致。
 */
import { WORLD } from './camp';

export type Vec3 = readonly [number, number, number];

/** 全景截图的垂直视场（度），与 scene.ts snapshot 的临时相机一致 */
export const SNAPSHOT_FOV_DEG = 40;

/**
 * 全景需要框住的范围（界面取景参数，不是玩法数值）：
 * - 水平外扩 1.5 m：围栏厚 1 m、建在 WORLD 边界外侧（camp.ts fenceShapes），再留 0.5 m；
 * - 高度 5.5 m：大门门柱 4.4 m、牌子中心 5 m（scene.ts），高于任何车型（最高约 3.x m）。
 */
export const CAMP_FRAME = { margin: 1.5, topH: 5.5 } as const;

/** 俯视仰角（度）：从营地南侧斜上方看，既看得出车辆立面也不至于前后遮挡（界面取景，提案值） */
export const CAMP_ELEVATION_DEG = 62;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * 透视投影到归一化设备坐标：返回 [x, y]，在截图内当且仅当 |x| ≤ 1 且 |y| ≤ 1；点在相机背后返回 null。
 * 约定同 three：相机 z 轴 = normalize(pos - look)，x 轴 = normalize(up × z)，y 轴 = z × x。
 */
export function projectNdc(pos: Vec3, look: Vec3, fovDeg: number, aspect: number, p: Vec3): [number, number] | null {
  const z = norm(sub(pos, look));
  const x = norm(cross([0, 0, 1], z));
  const y = cross(z, x);
  const d = sub(p, pos);
  const depth = -dot(d, z);
  if (depth <= 0) return null;
  const t = Math.tan((fovDeg * Math.PI) / 360);
  return [dot(d, x) / depth / (t * aspect), dot(d, y) / depth / t];
}

/** 需要框住的 8 个角点 */
export function campFrameCorners(frame: { margin: number; topH: number } = CAMP_FRAME): Vec3[] {
  const { minX, maxX, minY, maxY } = WORLD;
  const m = frame.margin;
  const out: Vec3[] = [];
  for (const x of [minX - m, maxX + m]) for (const y of [minY - m, maxY + m]) for (const h of [0, frame.topH]) out.push([x, y, h]);
  return out;
}

const fits = (pos: Vec3, look: Vec3, fov: number, aspect: number, pts: Vec3[]) =>
  pts.every((p) => {
    const n = projectNdc(pos, look, fov, aspect, p);
    return n !== null && Math.abs(n[0]) <= 1 && Math.abs(n[1]) <= 1;
  });

/**
 * 营地全景相机：看向营地中心，沿南侧仰角方向后退到刚好框住全部角点的距离（二分查找，精度 1 cm）。
 */
export function campShotCamera(aspect: number, fovDeg = SNAPSHOT_FOV_DEG, elevationDeg = CAMP_ELEVATION_DEG, frame = CAMP_FRAME): { pos: Vec3; look: Vec3 } {
  const { minX, maxX, minY, maxY } = WORLD;
  const look: Vec3 = [(minX + maxX) / 2, (minY + maxY) / 2, frame.topH / 2];
  const e = (elevationDeg * Math.PI) / 180;
  const dir: Vec3 = [0, -Math.cos(e), Math.sin(e)];
  const at = (d: number): Vec3 => [look[0] + dir[0] * d, look[1] + dir[1] * d, look[2] + dir[2] * d];
  const pts = campFrameCorners(frame);
  let lo = 1;
  let hi = 2000;
  if (!fits(at(hi), look, fovDeg, aspect, pts)) throw new Error('campShotCamera: 视场内放不下营地');
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    if (fits(at(mid), look, fovDeg, aspect, pts)) hi = mid;
    else lo = mid;
  }
  return { pos: at(hi), look };
}
