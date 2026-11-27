/** #99 前轮窝与轮组。只使用本车的公告尺寸和占位胎面；下述留边是视觉提案 / 待核实。 */
import * as THREE from 'three';
import { frontInset, TIRE_SEGMENTS, TIRE_WIDTH, wheelWellDepth, type WheelBinding } from './vehicleMotion';
import type { Facets } from './vehicleBody';

type Point = [x: number, y: number, z: number];
type Side = -1 | 1;
const RUBBER = 0x292a2d, SEAL = 0x33393b;
const frontInnerGap = 0.070;
const lipOverlap = 0.016;

/** 半径增加而非把肩和顶一起抬平。深色唇边包住蒙皮切口，翻边沿胎面回折到内侧挡板。 */
export function paintLowerSides(
  body: Facets, trim: Facets, paint: number, low: Point[], high: Point[], axles: number[], radius: number, joinZ: number, wellX: number,
): void {
  const [half, floor] = low[2];
  const rear = low[3][2], belt = high[2][1], archFace = half + 0.01;
  for (const side of [-1, 1] as const) {
    const skin = (out: Facets, color: number, a: Point, b: Point, c: Point, d: Point) => {
      if (side === 1) out.quad(color, a, b, c, d);
      else out.quad(color, d, c, b, a);
    };
    const span = (from: number, to: number) => {
      const x = side * half;
      skin(body, paint, [x, floor, from], [x, floor, to], [x, belt, to], [x, belt, from]);
      const edge = side * (half + 0.009);
      skin(trim, RUBBER, [edge, floor, from], [edge, floor, to], [edge, floor + 0.095, to], [edge, floor + 0.095, from]);
    };
    let cursor = joinZ;
    for (const axle of axles) {
      const front = axle === axles[0];
      const inner = radius + (front ? frontInnerGap : 0.012);
      const outer = radius + (front ? 0.115 : 0.088);
      const cut = inner + lipOverlap;
      const lift = Math.asin((floor - radius) / cut);
      const mouth = cut * Math.cos(lift);
      const segments = front ? 7 : 9; // 两段弧的面预算转给内衬背面与地台缺口
      // 挡板下端嵌进地台（2 mm 提案搭接），不和地台竖边共面。
      const backX = front ? wellX - 0.002 : half - 0.29;
      span(cursor, axle + mouth);
      const point = (x: number, r: number, angle: number): Point =>
        [side * x, radius + r * Math.sin(angle), axle + r * Math.cos(angle)];
      for (let i = 0; i < segments; i++) {
        const a = THREE.MathUtils.lerp(lift, Math.PI - lift, i / segments);
        const b = THREE.MathUtils.lerp(lift, Math.PI - lift, (i + 1) / segments);
        const start = point(half, cut, a), end = point(half, cut, b);
        skin(body, paint, start, end, [side * half, belt, end[2]], [side * half, belt, start[2]]);
        const innerA = point(archFace, inner, a), innerB = point(archFace, inner, b);
        const outerA = point(archFace, outer, a), outerB = point(archFace, outer, b);
        skin(trim, RUBBER, innerA, innerB, outerB, outerA);
        skin(trim, SEAL, outerA, outerB, point(half, outer, b), point(half, outer, a));
        const backA = point(backX, inner, a), backB = point(backX, inner, b);
        skin(trim, RUBBER, backA, backB, innerB, innerA);
        if (front && i > 0) {
          const foot = point(backX, inner, lift);
          if (side === 1) trim.triangle(SEAL, foot, backB, backA);
          else trim.triangle(SEAL, foot, backA, backB);
        }
      }
      cursor = axle - mouth;
    }
    span(cursor, rear);
  }
}

export function wheelAndHub(trim: Facets, hub: Facets, side: Side, half: number, radius: number, z: number, front: boolean): WheelBinding {
  const center = half - (front ? frontInset(radius) : 0.041 + TIRE_WIDTH / 2);
  const outer = center + TIRE_WIDTH / 2;
  const cylinder = (r: number, width: number, x: number, segments: number, buriedBack = false) => {
    const g = new THREE.CylinderGeometry(r, r, width, segments);
    if (buriedBack) {
      // CylinderGeometry builds barrel, top cap, bottom cap. Only the last cap is buried.
      g.setIndex(Array.from(g.getIndex()!.array.slice(0, g.groups[2].start)));
    }
    return g.rotateZ(-side * Math.PI / 2).translate(side * x, Math.fround(radius), z);
  };
  const t = trim.count, h = hub.count;
  trim.solid(RUBBER, cylinder(radius, TIRE_WIDTH, center, TIRE_SEGMENTS));
  trim.solid(0x414146, cylinder(radius * 0.80, 0.010, outer, 16, true));
  hub.solid(0xb8b1a4, cylinder(radius * 0.57, 0.025, outer + 0.007, 12, true));
  hub.solid(0xe4dfd4, cylinder(radius * 0.455, 0.018, outer + 0.019, 12, true));
  hub.solid(0x797c7a, cylinder(radius * 0.17, 0.016, outer + 0.028, 8, true));
  return { x: side * center, y: radius, z, front, trim: { first: t, end: trim.count }, hub: { first: h, end: hub.count } };
}

export const frontWell = (half: number, r: number, axle: number) => ({
  wellX: half - wheelWellDepth(r),
  notchZ: axle - r - frontInnerGap - lipOverlap,
});

/** T 形地台：座脚落在宽段，窄段托住中控台，两段拼成封闭表面，不留重叠的盒面。 */
export function seatDeck(trim: Facets, bottomX: number, wellX: number, notchZ: number, back: number, front: number, floor: number, height: number) {
  const row = (y: number): Point[] => [
    [-wellX, y, front], [wellX, y, front], [wellX, y, notchZ], [bottomX, y, notchZ],
    [bottomX, y, back], [-bottomX, y, back], [-bottomX, y, notchZ], [-wellX, y, notchZ],
  ];
  const low = row(floor), high = row(floor + height), color = 0x303637;
  for (let i = 0; i < low.length; i++) {
    const j = (i + 1) % low.length;
    trim.quad(color, low[i], low[j], high[j], high[i]);
  }
  for (const [a, b, c, d] of [[0, 1, 2, 7], [6, 3, 4, 5]]) {
    trim.quad(color, high[a], high[b], high[c], high[d]);
    trim.quad(color, low[d], low[c], low[b], low[a]);
  }
}
