/** CLEANROOM_SPEC §5：横扫灯组在车头折角转向侧面，竖直尾灯共用一道边框。
 * 以下分区、尺寸为风格化提案，待视觉验收；不使用贴图或车型专属外观数据。
 */
import type { Variant } from '../data/models';
import { computeLayout, type Layout } from './layout';

export type LampRole = 'turnL' | 'turnR' | 'brake' | 'reverse' | 'head' | 'tail' | 'marker';
type Point = [number, number, number];
type Quad = [Point, Point, Point, Point];
type Surface = (u: number, v: number) => Point;
export interface LampQuad { role: LampRole; corners: Quad }
interface Fixtures { housings: Quad[]; lenses: LampQuad[] }

/** 每片透镜是在所属外壳平面里裁出的子区域，逆时针朝外。深度偏移由 lamps 材质统一处理。 */
export function lampFixtures(v: Variant, lay: Layout): Fixtures {
  const half = v.widthM / 2;
  const { zFront, zRear, frontAxleZ } = lay;
  const housings: Quad[] = [];
  const lenses: LampQuad[] = [];
  for (const side of [1, -1] as const) {
    const turn = side === 1 ? 'turnL' : 'turnR';
    const mount = (face: Surface) => {
      const patch = (u0: number, v0: number, u1: number, v1: number): Quad => {
        const a = face(u0, v0), b = face(u1, v0), c = face(u1, v1), d = face(u0, v1);
        return side === 1 ? [a, b, c, d] : [b, a, d, c];
      };
      housings.push(patch(0, 0, 1, 1));
      return (role: LampRole, u0: number, v0: number, u1: number, v1: number) => {
        lenses.push({ role, corners: patch(u0, v0, u1, v1) });
      };
    };
    // Follow the slope between the sill and belt rings, then fold along their chamfer.
    // At the outer seam both patches use exactly the same two points.
    const nose = (y: number, inward: number, wrap: number): Point => {
      const t = (y - 0.4) / (1.19 - 0.4);
      const cut = 0.10 + t * (0.073 - 0.10);
      const z = zFront - 0.023 + t * (0.023 - 0.004);
      return [side * (half - 0.012 - cut * (1 - wrap) - inward), y, z - cut * wrap + 0.001];
    };
    const frontFace = mount((u, h) => nose(0.979 + 0.045 * u + 0.126 * h, 0.46 * (1 - u), 0));
    frontFace('head', 0.035, 0.14, 0.765, 0.89);
    frontFace(turn, 0.79, 0.14, 0.976, 0.89);
    const corner = mount((u, h) => nose(1.024 + 0.017 * u + (0.126 - 0.025 * u) * h, 0, u));
    corner('marker', 0.075, 0.16, 0.93, 0.86);

    // Directly over the front axle, below the belt strip; 1 mm proud of the side skin.
    const fender = mount((u, h) => [side * (half - 0.011), 0.982 + 0.076 * h, frontAxleZ + (0.5 - u) * 0.18]);
    fender(turn, 0.08, 0.15, 0.92, 0.85);

    const rear = mount((u, h) => [side * (half - 0.077 - 0.172 * u), 0.95 + 0.81 * h, zRear + 0.011]);
    rear('reverse', 0.12, 0.04, 0.88, 0.20);
    rear(turn, 0.12, 0.23, 0.88, 0.39);
    rear('tail', 0.12, 0.42, 0.88, 0.68);
    rear('brake', 0.12, 0.71, 0.88, 0.96);
  }
  return { housings, lenses };
}

export function lampLayout(v: Variant): LampQuad[] {
  return lampFixtures(v, computeLayout(v)).lenses;
}
