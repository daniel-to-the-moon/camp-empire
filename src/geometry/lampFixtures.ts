/** CLEANROOM_SPEC §5：横扫灯组在车头折角转向侧面，竖直尾灯共用一道边框。
 * 以下分区、尺寸为风格化提案，待视觉验收；不使用贴图或车型专属外观数据。
 */
import type { Variant } from '../data/models';
import { computeLayout, type Layout } from './layout';
import { grille, noseProfile } from './frontProfile';

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
    // Three joined planes rather than a flat rectangle: start at the grille, rise
    // around the bevel, then narrow to a point short of the separate axle repeater.
    const mix = (a: number, b: number, t: number) => a + (b - a) * t;
    const corner: Surface = (u, h) => {
      const y = mix(mix(1.028, 1.164, h), mix(1.045, 1.147, h), u);
      const { cut, z } = noseProfile(zFront, y);
      return [side * (half - 0.012 - cut * (1 - u) + grille.proud * u), y, z - cut * u + grille.proud * (1 - u)];
    };
    const face = mount((u, h) => {
      const [x, outerY] = corner(0, h);
      const y = mix(mix(grille.bottom, grille.top, h), outerY, u);
      return [mix(side * grille.halfWidth, x, u), y, noseProfile(zFront, y).z + grille.proud];
    });
    face(turn, 0.025, 0.13, 0.145, 0.87);
    face('head', 0.166, 0.10, 0.99, 0.93);
    const bevel = mount(corner);
    bevel('marker', 0.06, 0.08, 0.94, 0.32);
    bevel('head', 0.06, 0.49, 0.94, 0.93);
    const wing = mount((u, h) => {
      const [x, y, z] = corner(1, h);
      return [x, mix(y, mix(1.109, 1.143, h), u), mix(z, zFront - 0.52 * v.frontOverhangM, u)];
    });
    wing('head', 0.012, 0.12, 0.963, 0.91);

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
