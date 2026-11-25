import * as THREE from 'three';
import type { Variant } from '../data/models';
import type { Layout } from './layout';
import { lampFixtures } from './lampFixtures';
import { grille, noseBelt, noseFloor, noseProfile } from './frontProfile';

export const MAIN_PAINT = 0x608faa;
const CREAM = 0xfff0d7;
const RUBBER = 0x292a2d;
const SEAL = 0x33393b;
const BELT = 0xf5d9b2;
const GLASS = 0x4f7b90;
const GLINT = 0xb9d9de;
const CHROME = 0xe4dfd4;

type Point = [x: number, y: number, z: number];
type Face = (u: number, v: number) => Point;
type Side = 1 | -1;
const SIDES = [-1, 1] as const;
const lerp = THREE.MathUtils.lerp;

function between(a: Point, b: Point, t: number): Point {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

class Facets {
  private positions: number[] = [];
  private colors: number[] = [];
  private color = new THREE.Color();

  constructor(private withAlpha = false) {}

  triangle(tint: number, a: Point, b: Point, c: Point, alpha = 1): void {
    this.positions.push(...a, ...b, ...c);
    this.color.setHex(tint);
    const { r, g, b: blue } = this.color;
    for (let i = 0; i < 3; i++) {
      this.colors.push(r, g, blue);
      if (this.withAlpha) this.colors.push(alpha);
    }
  }

  quad(tint: number, a: Point, b: Point, c: Point, d: Point, alpha = 1): void {
    this.triangle(tint, a, b, c, alpha);
    this.triangle(tint, a, c, d, alpha);
  }

  solid(tint: number, shape: THREE.BufferGeometry): void {
    const positions = shape.getAttribute('position');
    const index = shape.getIndex();
    const point = (i: number): Point => {
      const k = index ? index.getX(i) : i;
      return [positions.getX(k), positions.getY(k), positions.getZ(k)];
    };
    for (let i = 0; i < (index?.count ?? positions.count); i += 3) {
      this.triangle(tint, point(i), point(i + 1), point(i + 2));
    }
    shape.dispose();
  }

  geometry(): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.colors, this.withAlpha ? 4 : 3));
    geo.computeVertexNormals();
    return geo;
  }
}

function block(w: number, h: number, d: number, x: number, y: number, z: number): THREE.BoxGeometry {
  return new THREE.BoxGeometry(w, h, d).translate(x, y, z);
}

// Plans are ordered around the vehicle from the front right, with flat faces separated by chamfers.
function ring(y: number, half: number, front: number, rear: number, noseCut: number, tailCut: number): Point[] {
  return [
    [-half + noseCut, y, front], [half - noseCut, y, front],
    [half, y, front - noseCut], [half, y, rear + tailCut],
    [half - tailCut, y, rear], [-half + tailCut, y, rear],
    [-half, y, rear + tailCut], [-half, y, front - noseCut],
  ];
}

function stationFace(low: Point[], high: Point[], i: number): Face {
  const next = (i + 1) % low.length;
  return (u, v) => between(between(low[i], high[i], v), between(low[next], high[next], v), u);
}

function rect(out: Facets, color: number, face: Face, left: number, bottom: number, right: number, top: number, alpha = 1): void {
  out.quad(color, face(left, bottom), face(right, bottom), face(right, top), face(left, top), alpha);
}

function band(out: Facets, color: number, low: Point[], high: Point[], skip: number[] = []): void {
  for (let i = 0; i < low.length; i++) {
    if (!skip.includes(i)) rect(out, color, stationFace(low, high, i), 0, 0, 1, 1);
  }
}

type WindowSpan = [leftBottom: number, rightBottom: number, leftTop: number, rightTop: number, opacity: number];

function mirrored(spans: WindowSpan[]): WindowSpan[] {
  return [...spans].reverse().map(([a, b, c, d, opacity]) => [1 - b, 1 - a, 1 - d, 1 - c, opacity]);
}

/** Fills the sheet metal around real openings. Each gasket and pane shares the opening's plane. */
function windowRow(
  body: Facets, trim: Facets, glass: Facets, face: Face, bottom: number, top: number, spans: WindowSpan[], liningOffset?: Point,
): void {
  rect(body, CREAM, face, 0, 0, 1, bottom);
  rect(body, CREAM, face, 0, top, 1, 1);
  let previousBottom = 0;
  let previousTop = 0;
  for (const [leftBottom, rightBottom, leftTop, rightTop, opacity] of spans) {
    const a = face(leftBottom, bottom);
    const b = face(rightBottom, bottom);
    const c = face(rightTop, top);
    const d = face(leftTop, top);
    body.quad(CREAM, face(previousBottom, bottom), a, d, face(previousTop, top));
    const opening: Face = (u, v) => between(between(a, b, u), between(d, c, u), v);
    const edgeU = Math.min(0.16, 0.042 / Math.abs(b[2] - a[2] || b[0] - a[0]));
    // On the flat skylight v runs aft rather than upwards.
    const edgeV = 0.042 / Math.abs(c[1] - b[1] || c[2] - b[2]);
    rect(trim, SEAL, opening, 0, 0, 1, edgeV);
    rect(trim, SEAL, opening, 0, 1 - edgeV, 1, 1);
    rect(trim, SEAL, opening, 0, edgeV, edgeU, 1 - edgeV);
    rect(trim, SEAL, opening, 1 - edgeU, edgeV, 1, 1 - edgeV);
    // A narrow pale strip suggests a reflection, while the main pane leaves the cabin visible.
    rect(glass, GLASS, opening, edgeU, edgeV, 1 - edgeU, 0.93 - edgeV, opacity);
    rect(glass, GLINT, opening, edgeU, 0.93 - edgeV, 1 - edgeU, 1 - edgeV, opacity);
    if (liningOffset) {
      // The brow is an enclosed compartment, not a second see-through cab. Return the
      // inside edge of its gasket to a recessed opaque shade, closed even at grazing angles.
      const rim = [opening(edgeU, edgeV), opening(1 - edgeU, edgeV),
        opening(1 - edgeU, 1 - edgeV), opening(edgeU, 1 - edgeV)];
      const back = rim.map(([x, y, z]): Point => [x + liningOffset[0], y + liningOffset[1], z + liningOffset[2]]);
      band(trim, SEAL, rim, back);
      trim.quad(SEAL, back[0], back[1], back[2], back[3]);
    }
    previousBottom = rightBottom;
    previousTop = rightTop;
  }
  body.quad(CREAM, face(previousBottom, bottom), face(1, bottom), face(1, top), face(previousTop, top));
}

/** #73, 11-25 游戏需求。窗宽、留边、内衬深度均为风格化提案 / 待核实。
 * 只裁风挡上沿前方的悬伸段；两侧与平顶共用乘客窗的密封条、玻璃及反光带。 */
function browWindows(body: Facets, trim: Facets, glass: Facets, lip: Point[], eave: Point[], roof: Point[], windTopZ: number): void {
  const rearEdge = windTopZ + 0.025;
  const depth = 0.024;
  const bottom = 0.13, top = 0.88;
  const left = stationFace(lip, eave, 2);
  const endAt = (v: number) => (rearEdge - left(0, v)[2]) / (left(1, v)[2] - left(0, v)[2]);
  const side: WindowSpan[] = [[0.012, endAt(bottom), 0.022, endAt(top), 0.63]];
  band(body, CREAM, lip, eave, [2, 6]);
  windowRow(body, trim, glass, left, bottom, top, side, [-depth, 0, 0]);
  windowRow(body, trim, glass, stationFace(lip, eave, 6), bottom, top, mirrored(side), [depth, 0, 0]);

  // Keep both bevelled ends of the octagonal roof. The rectangle between them is
  // partitioned around the skylight, not capped underneath the glazing.
  body.quad(CREAM, roof[0], roof[1], roof[2], roof[7]);
  body.quad(CREAM, roof[6], roof[3], roof[4], roof[5]);
  const nose = roof[2][2], tail = roof[3][2];
  const deck: Face = (u, v) => [lerp(roof[7][0], roof[2][0], u), roof[2][1], lerp(nose, tail, v)];
  windowRow(body, trim, glass, deck, 0.04 / (nose - tail), (nose - rearEdge) / (nose - tail),
    [[0.2, 0.8, 0.2, 0.8, 0.63]], [0, -depth, 0]);
}

function sideWindows(face: Face, bottom: number, top: number, driverEnd: number, tail: number): WindowSpan[] {
  const atZ = (z: number, h: number) => (z - face(0, h)[2]) / (face(1, h)[2] - face(0, h)[2]);
  const passengerStart = driverEnd - 0.19;
  const passengerEnd = tail + 0.42;
  const divide = (passengerStart + passengerEnd) / 2;
  return [
    [0.013, atZ(driverEnd, bottom), 0.013, atZ(driverEnd, top), 0.32],
    [atZ(passengerStart, bottom), atZ(divide + 0.047, bottom), atZ(passengerStart, top), atZ(divide + 0.047, top), 0.63],
    [atZ(divide - 0.047, bottom), atZ(passengerEnd, bottom), atZ(divide - 0.047, top), atZ(passengerEnd, top), 0.63],
  ];
}

function paintLowerSides(
  body: Facets, trim: Facets, paint: number, low: Point[], high: Point[], axles: number[], radius: number, joinZ: number,
): void {
  const [half, floor] = low[2];
  const rear = low[3][2];
  const belt = high[2][1];
  const cut = radius + 0.028;
  const lift = Math.asin((floor - radius) / cut);
  const mouth = cut * Math.cos(lift);
  const archFace = half + 0.01;
  const segments = 9;

  for (const side of SIDES) {
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
      span(cursor, axle + mouth);
      const point = (x: number, r: number, angle: number): Point =>
        [side * x, radius + r * Math.sin(angle), axle + r * Math.cos(angle)];
      for (let i = 0; i < segments; i++) {
        const a = lerp(lift, Math.PI - lift, i / segments);
        const b = lerp(lift, Math.PI - lift, (i + 1) / segments);
        const start = point(half, cut, a);
        const end = point(half, cut, b);
        skin(body, paint, start, end, [side * half, belt, end[2]], [side * half, belt, start[2]]);
        const innerA = point(archFace, radius + 0.012, a);
        const innerB = point(archFace, radius + 0.012, b);
        const outerA = point(archFace, radius + 0.088, a);
        const outerB = point(archFace, radius + 0.088, b);
        skin(trim, RUBBER, innerA, innerB, outerB, outerA);
        skin(trim, SEAL, outerA, outerB, point(half, radius + 0.088, b), point(half, radius + 0.088, a));
        skin(trim, RUBBER, point(half - 0.29, radius + 0.012, a), point(half - 0.29, radius + 0.012, b), innerB, innerA);
      }
      cursor = axle - mouth;
    }
    span(cursor, rear);
  }
}

function wheelAndHub(trim: Facets, hub: Facets, side: Side, half: number, radius: number, z: number): void {
  const tireWidth = 0.215;
  const outer = half - 0.041;
  const cylinder = (r: number, width: number, x: number, segments: number, buriedBack = false) => {
    const g = new THREE.CylinderGeometry(r, r, width, segments);
    if (buriedBack) {
      // CylinderGeometry builds barrel, top cap, bottom cap. Only the last cap is buried.
      g.setIndex(Array.from(g.getIndex()!.array.slice(0, g.groups[2].start)));
    }
    return g.rotateZ(-side * Math.PI / 2).translate(side * x, Math.fround(radius), z);
  };
  trim.solid(RUBBER, cylinder(radius, tireWidth, outer - tireWidth / 2, 16));
  trim.solid(0x414146, cylinder(radius * 0.80, 0.010, outer, 16, true));
  hub.solid(0xb8b1a4, cylinder(radius * 0.57, 0.025, outer + 0.007, 12, true));
  hub.solid(CHROME, cylinder(radius * 0.455, 0.018, outer + 0.019, 12, true));
  hub.solid(0x797c7a, cylinder(radius * 0.17, 0.016, outer + 0.028, 8, true));
}

function fascia(trim: Facets, front: number, rear: number): void {
  const { halfWidth, bottom, top, proud } = grille;
  const frontFace: Face = (x, y) => [x, y, noseProfile(front, y).z + proud];
  rect(trim, RUBBER, frontFace, -halfWidth, bottom, halfWidth, top);
  const rail: Face = (x, y) => [x, y, frontFace(x, y)[2] + 0.0005];
  for (const h of [0.13, 0.36, 0.59, 0.82]) {
    const y = lerp(bottom, top, h);
    rect(trim, CHROME, rail, -halfWidth, y, halfWidth, y + 0.011);
  }
  // Unbranded oval fixed across the rails, parallel to the grille.
  const mid = (bottom + top) / 2;
  const tilt = Math.atan2(frontFace(0, top)[2] - frontFace(0, bottom)[2], top - bottom);
  const badge = (g: THREE.BufferGeometry) => g.scale(0.125, 0.069, 1).rotateX(tilt).translate(0, mid, rail(0, mid)[2] + 0.0005);
  trim.solid(CHROME, badge(new THREE.RingGeometry(0.73, 1, 20)));
  trim.solid(RUBBER, badge(new THREE.CircleGeometry(0.73, 20)));

  const rearFace: Face = (x, y) => [-x, y, rear + 0.009];
  const rearInset: Face = (x, y) => [-x, y, rear + 0.007];
  rect(trim, CHROME, rearFace, -0.24, 0.955, 0.24, 1.108);
  rect(trim, 0x515758, rearInset, -0.21, 0.979, 0.21, 1.084);
}

/** 提案：下包围就是这段外蒙皮。两端沿翼子板收至裙边，中央留空，
 * 四壁接后挡板；横条两端落在孔壁上。深度与色值均非原厂量测。 */
function frontBumper(body: Facets, trim: Facets, paint: number, half: number, front: number, joinZ: number): void {
  const x = half - 0.012;
  // Open U from one skirt to the other. The front face is edge 2; no cap over the grille mouth.
  const row = (y: number, z: number, cut: number, endY: number): Point[] => [
    [-x, endY, joinZ], [-x, y, z - cut], [-x + cut, y, z],
    [x - cut, y, z], [x, y, z - cut], [x, endY, joinZ],
  ];
  const skin = (y: number, endY = y) => {
    const { z, cut } = noseProfile(front, y);
    return row(y, z, cut, endY);
  };
  const toe = row(0.362, front - 0.035, 0.12, noseFloor);
  const lip = row(0.429, front, 0.12, 0.425);
  const rim = row(0.705, front - 0.008, 0.10, 0.48);
  const shoulder = skin(0.754, noseFloor + 0.095);
  band(trim, SEAL, toe, lip, [5]);
  band(trim, RUBBER, lip, rim, [2, 5]);
  band(trim, RUBBER, rim, shoulder, [5]);
  band(body, paint, shoulder, skin(noseBelt), [5]);
  trim.quad(RUBBER, toe[0], toe[5], toe[4], toe[1]);
  trim.quad(RUBBER, toe[1], toe[4], toe[3], toe[2]);

  const depth = 0.075;
  const throat = (u: number, h: number, inset: number): Point => [
    u * (half - 0.51 + 0.07 * h - 0.024 * inset), lerp(lip[2][1], rim[2][1], h),
    lerp(lip[2][2], rim[2][2], h) - inset * depth,
  ];
  const opening = (inset: number) => [throat(-1, 0, inset), throat(1, 0, inset), throat(1, 1, inset), throat(-1, 1, inset)];
  const mouth = opening(0), back = opening(1);
  trim.quad(RUBBER, lip[2], mouth[0], mouth[3], rim[2]);
  trim.quad(RUBBER, mouth[1], lip[3], rim[3], mouth[2]);
  band(trim, SEAL, mouth, back);
  trim.quad(0x181c1d, back[0], back[1], back[2], back[3]);
  for (const h of [0.2, 0.46, 0.72]) {
    rect(trim, 0xb5b1a8, (u, t) => throat(u, t, 0.32), -1, h, 1, h + 0.075);
    trim.quad(0x626668, throat(-1, h + 0.075, 0.32), throat(1, h + 0.075, 0.32),
      throat(1, h + 0.075, 0.70), throat(-1, h + 0.075, 0.70));
  }
  const cheek: Face = (u, h) => [u, lerp(lip[2][1], rim[2][1], h), lerp(lip[2][2], rim[2][2], h) + 0.0006];
  for (const side of SIDES) {
    const fogX = side * (half - 0.30);
    rect(trim, 0x494c4c, cheek, fogX - 0.099, 0.21, fogX + 0.099, 0.67);
    rect(trim, 0xbbaf92, (u, h) => { const p = cheek(u, h); p[2] += 0.0006; return p; },
      fogX - 0.060, 0.32, fogX + 0.060, 0.55);
    // Close the small step to the raised side skirt at the shared end station.
    const ends = [side * x, side * (x + 0.009)];
    rect(trim, RUBBER, (u, y) => [u, y, joinZ], Math.min(...ends), noseFloor, Math.max(...ends), noseFloor + 0.095);
  }
}

function sideDetails(
  trim: Facets, half: number, belt: number, header: number, windBase: number, driverEnd: number, doorBack: number,
  front: number, rear: number,
): void {
  const doorFront = driverEnd - 0.09;
  const doorSill = 0.565;
  const doorTop = 1.33;
  for (const side of SIDES) {
    const panel: Face = (z, y) => [side * (half - 0.009 - 0.04 * Math.max(0, y - 1.32) / (header - 1.32)), y, -side * z];
    const line = (color: number, from: number, to: number, bottom: number, top: number) => {
      const a = Math.min(-side * from, -side * to);
      const b = Math.max(-side * from, -side * to);
      rect(trim, color, panel, a, bottom, b, top);
    };
    line(BELT, rear + 0.11, front - 0.13, belt - 0.037, belt + 0.003);
    const seam = 0x464f53;
    line(seam, doorBack, doorFront, doorSill, doorSill + 0.010);
    for (const z of [doorBack, doorFront - 0.012]) {
      line(seam, z, z + 0.012, doorSill + 0.010, belt - 0.037);
      line(seam, z, z + 0.012, belt + 0.003, doorTop);
    }
    trim.solid(SEAL, block(0.025, 0.044, 0.179, side * (half - 0.015), belt - 0.11, doorFront - 0.154));
    trim.solid(CHROME, block(0.010, 0.012, 0.113, side * (half - 0.005), belt - 0.104, doorFront - 0.154));
    trim.solid(SEAL, block(0.115, 0.075, 0.12, side * (half - 0.071), 1.426, windBase - 0.167));
    trim.solid(RUBBER, block(0.087, 0.179, 0.169, side * (half - 0.0435), 1.521, windBase - 0.162));
    trim.solid(0x8aacae, block(0.067, 0.135, 0.012, side * (half - 0.0455), 1.521, windBase - 0.245));
  }
  const tail: Face = (x, y) => [-x, y, rear + 0.009];
  rect(trim, SEAL, tail, -0.006, 0.65, 0.006, 0.931);
  rect(trim, SEAL, tail, -0.006, 1.127, 0.006, 1.495);
  rect(trim, SEAL, tail, -0.64, 0.651, 0.64, 0.663);
}

// Cabin dimensions and tints are stylised proposals, not factory measurements.
function dashboard(trim: Facets, half: number, windBaseZ: number, steeringX: number): void {
  const lower = ring(1.16, half - 0.03, windBaseZ - 0.065, windBaseZ - 0.49, 0.09, 0.07);
  const shoulder = ring(1.315, half - 0.03, windBaseZ - 0.07, windBaseZ - 0.58, 0.09, 0.06);
  const top = ring(1.485, half - 0.096, windBaseZ - 0.175, windBaseZ - 0.55, 0.07, 0.04);
  band(trim, 0x524d46, lower, shoulder);
  band(trim, 0x997c5f, shoulder, top);
  for (let i = 1; i < top.length - 1; i++) {
    trim.triangle(0x826b55, top[0], top[i], top[i + 1]);
    trim.triangle(0x524d46, lower[0], lower[i + 1], lower[i]);
  }
  // At the beltline, two short sleeves meet the skin edge-on. No outward cap coplanar with the paint.
  for (const side of SIDES) {
    const ends = [side * (half - 0.034), side * (half - 0.012)];
    const x0 = Math.min(...ends), x1 = Math.max(...ends);
    const sleeve = (y: number): [Point, Point, Point, Point] => [
      [x0, y, windBaseZ - 0.22], [x1, y, windBaseZ - 0.22],
      [x1, y, windBaseZ - 0.42], [x0, y, windBaseZ - 0.42],
    ];
    const low = sleeve(1.19), high = sleeve(1.28);
    band(trim, 0x524d46, low, high, [1, 3]);
    trim.quad(0x524d46, ...high);
    trim.quad(0x524d46, low[3], low[2], low[1], low[0]);
  }

  // A moulded cowl grows out of the padded top; only the driver-facing slope carries instruments.
  const cowl = (y: number, w: number, nose: number, back: number) =>
    ring(y, w, windBaseZ - nose, windBaseZ - back, 0.05, 0.028).map(([x, h, z]): Point => [x + steeringX, h, z]);
  const foot = cowl(1.48, 0.25, 0.245, 0.545);
  const crest = cowl(1.561, 0.197, 0.339, 0.425);
  const lip = cowl(1.571, 0.194, 0.35, 0.442);
  band(trim, 0x826b55, foot, crest);
  band(trim, 0x715c4a, crest, lip);
  for (let i = 1; i < lip.length - 1; i++) trim.triangle(0x92765b, lip[0], lip[i], lip[i + 1]);
  const dialTilt = Math.atan2(crest[4][1] - foot[4][1], crest[4][2] - foot[4][2]);
  const [, dialY, dialZ] = between(foot[4], crest[4], 0.5);
  for (const dx of [-0.094, 0.094]) {
    const x = steeringX + dx;
    trim.solid(0xe2d5b9, new THREE.RingGeometry(0.035, 0.047, 10)
      .rotateX(-Math.PI / 2 - dialTilt).translate(x, dialY + 0.001, dialZ));
    const needle: Face = (u, h) => [x + u + h * Math.sign(dx) * 0.38, dialY + 0.002 + h * Math.sin(dialTilt), dialZ + h * Math.cos(dialTilt)];
    rect(trim, 0xe6a465, needle, -0.004, 0.029, 0.004, -0.01);
  }
}

/** The centre stack flares from a foot between the seat rails into the dash. Its controls
 * sit on a shallow driver-facing slope, above the dash pad so they also read through the windscreen.
 */
function consoleStack(trim: Facets, baseZ: number, deckTop: number): void {
  const station = (width: number, front: number, rear: number, frontY: number, rearY: number): Point[] => [
    [-width, frontY, baseZ - front], [width, frontY, baseZ - front],
    [width, rearY, baseZ - rear], [-width, rearY, baseZ - rear],
  ];
  const foot = station(0.131, 0.36, 1.12, deckTop - 0.012, deckTop - 0.012);
  const waist = station(0.146, 0.36, 0.80, 1.17, 1.11);
  const top = station(0.18, 0.32, 0.694, 1.548, 1.516);
  band(trim, 0x63594c, foot, waist);
  band(trim, 0xb29473, waist, top);
  trim.quad(0x514d47, top[0], top[1], top[2], top[3]);
  trim.quad(SEAL, foot[3], foot[2], foot[1], foot[0]);
  const surface: Face = (x, t) => [x, lerp(top[0][1], top[3][1], t) + 0.001, lerp(top[0][2], top[3][2], t)];
  for (const side of SIDES) rect(trim, RUBBER, surface, side * 0.083 - 0.067, 0.10, side * 0.083 + 0.067, 0.30);
  rect(trim, 0x81a6a6, surface, -0.14, 0.41, 0.14, 0.87);
}

function steering(trim: Facets, x: number, windBaseZ: number): void {
  const mount = new THREE.Vector3(x, 1.305, windBaseZ - 0.435);
  const center = new THREE.Vector3(x, 1.575, windBaseZ - 0.74);
  const offset = center.clone().sub(mount);
  const axis = offset.clone().normalize();
  const midpoint = mount.clone().lerp(center, 0.5);
  const columnRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis);
  trim.solid(0x686c63, new THREE.CylinderGeometry(0.049, 0.084, offset.length(), 8)
    .applyQuaternion(columnRotation).translate(midpoint.x, midpoint.y, midpoint.z));

  // The wheel, spokes and hub all share the plane perpendicular to the column.
  const wheelRotation = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), axis);
  const atWheel = (geometry: THREE.BufferGeometry) =>
    geometry.applyQuaternion(wheelRotation).translate(center.x, center.y, center.z);
  trim.solid(SEAL, atWheel(new THREE.TorusGeometry(0.185, 0.028, 5, 14)));
  trim.solid(0x565b59, atWheel(new THREE.BoxGeometry(0.35, 0.042, 0.040)));
  trim.solid(0x565b59, atWheel(block(0.043, 0.145, 0.040, 0, -0.102, 0)));
  trim.solid(RUBBER, atWheel(new THREE.BoxGeometry(0.108, 0.09, 0.075)));
}

function cabin(trim: Facets, half: number, windBaseZ: number, seatZ: number, deckTop: number): void {
  const saddle = 0xbb794d;
  const cushion = 0xeabc88;
  const seatX = half * 0.47;
  const pedestalBottom = deckTop + 0.026;
  const pedestalTop = 0.81;
  for (const side of SIDES) {
    const x = side * seatX;
    for (const rail of SIDES) {
      trim.solid(0x6d6257, block(0.055, 0.047, 0.54, x + rail * 0.135, deckTop + 0.018, seatZ + 0.025));
    }
    trim.solid(SEAL, block(0.39, pedestalTop - pedestalBottom, 0.405, x, (pedestalTop + pedestalBottom) / 2, seatZ));
    trim.solid(saddle, block(0.51, 0.15, 0.53, x, 0.87, seatZ + 0.07));
    trim.solid(cushion, block(0.39, 0.05, 0.41, x, 0.963, seatZ + 0.085));
    trim.solid(saddle, new THREE.BoxGeometry(0.52, 0.57, 0.16).rotateX(-0.14).translate(x, 1.20, seatZ - 0.17));
    trim.solid(cushion, new THREE.BoxGeometry(0.37, 0.44, 0.045).rotateX(-0.14).translate(x, 1.21, seatZ - 0.085));
    trim.solid(cushion, block(0.26, 0.18, 0.14, x, 1.56, seatZ - 0.21));
  }
  // Local +x is the driver's left when looking along +z (layout.ts).
  dashboard(trim, half, windBaseZ, seatX);
  steering(trim, half * 0.47, windBaseZ);
  consoleStack(trim, windBaseZ, deckTop);
}

/** Short bonnet pressing (proposal): two shoulders bound the raised centre fold.
 * Fade the crown to zero at both ends to keep the grille lip and windscreen seams closed. */
function bonnet(body: Facets, surface: Face): void {
  const section = (v: number, rise: number) => {
    const points = [0.28, 0.5, 0.72].map(u => surface(u, v));
    points[1][1] += rise;
    return points;
  };
  rect(body, CREAM, surface, 0, 0, 0.28, 1);
  rect(body, CREAM, surface, 0.72, 0, 1, 1);
  const rows = [section(0, 0), section(0.20, 0.041), section(0.64, 0.041), section(1, 0)];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    body.quad(CREAM, a[0], a[1], b[1], b[0]);
    body.quad(CREAM, a[2], b[2], b[1], a[1]);
  }
}

export function vehicleGeometries(v: Variant, lay: Layout, paint: number) {
  const body = new Facets();
  const trim = new Facets();
  const glass = new Facets(true);
  const hub = new Facets();
  const half = v.widthM / 2;
  const { zFront: front, zRear: rear } = lay;
  const radius = v.lengthM * 0.061;
  const axles = [lay.frontAxleZ, lay.rearAxleZ];
  const floorY = noseFloor;
  const beltY = noseBelt;
  const windBaseZ = front - v.frontOverhangM * 0.68;
  const windTopZ = windBaseZ - 0.69;
  const headerY = v.hasBrow ? 2.20 : v.heightM - 0.21;
  const driverEnd = windTopZ - 0.34;

  const lowerRing = (y: number) => {
    const { z, cut } = noseProfile(front, y);
    return ring(y, half - 0.012, z, rear + 0.012, cut, 0.036);
  };
  const sill = lowerRing(floorY), belt = lowerRing(beltY);
  const hood = ring(1.32, half - 0.012, windBaseZ, rear + 0.012, 0.096, 0.036);
  const header = ring(headerY, half - 0.052, windTopZ, rear + 0.012, 0.096, 0.056);
  // Hand off the entire nose to the moulding ahead of the wheel opening; no painted panel behind its mouth.
  const joinZ = front - 0.34;
  band(body, paint, sill, belt, [0, 1, 2, 6, 7]);
  frontBumper(body, trim, paint, half, front, joinZ);
  paintLowerSides(body, trim, paint, sill, belt, axles, radius, joinZ);
  band(body, CREAM, belt, hood, [0]);
  bonnet(body, stationFace(belt, hood, 0));
  band(body, CREAM, hood, header, [0, 2, 4, 6]);
  windowRow(body, trim, glass, stationFace(hood, header, 0), 0.055, 0.945, [[0.032, 0.968, 0.032, 0.968, 0.30]]);
  windowRow(body, trim, glass, stationFace(hood, header, 4), 0.22, 0.90, [[0.16, 0.84, 0.16, 0.84, 0.67]]);
  const windowBottom = 0.075;
  const windowTop = 0.89;
  const left = stationFace(hood, header, 2);
  const windows = sideWindows(left, windowBottom, windowTop, driverEnd, rear);
  windowRow(body, trim, glass, left, windowBottom, windowTop, windows);
  windowRow(body, trim, glass, stationFace(hood, header, 6), windowBottom, windowTop, mirrored(windows));

  let roofBase = header;
  if (v.hasBrow) {
    const browFoot = ring(2.265, half - 0.057, windTopZ + 0.01, rear + 0.012, 0.11, 0.064);
    const browLip = ring(2.47, half - 0.034, windBaseZ + 0.25, rear + 0.012, 0.19, 0.085);
    band(body, CREAM, roofBase, browFoot);
    band(body, CREAM, browFoot, browLip);
    roofBase = browLip;
  }
  const eave = ring(v.heightM - 0.105, half - 0.072, (v.hasBrow ? windBaseZ + 0.17 : windTopZ - 0.062),
    rear + 0.077, 0.155, 0.111);
  const roof = ring(v.heightM, half - 0.181, eave[0][2] - 0.14, rear + 0.195, 0.12, 0.12);
  if (v.hasBrow) {
    browWindows(body, trim, glass, roofBase, eave, roof, windTopZ);
    band(body, CREAM, eave, roof);
  } else {
    band(body, CREAM, roofBase, eave);
    band(body, CREAM, eave, roof);
    for (let i = 1; i < roof.length - 1; i++) body.triangle(CREAM, roof[0], roof[i], roof[i + 1]);
  }
  // One continuous underside: the seat deck occupies the middle span rather than overlaying the floor.
  const bottomX = half - 0.27;
  const seatZ = driverEnd + 0.21;
  const deckZ = seatZ + 0.18;
  const deckLength = 1.34;
  const deckHeight = 0.07;
  const floor: Face = (x, z) => [x, floorY, z];
  rect(body, paint, floor, -bottomX, rear + 0.012, bottomX, deckZ - deckLength / 2);
  rect(body, paint, floor, -bottomX, deckZ + deckLength / 2, bottomX, joinZ);
  trim.solid(0x303637, block(2 * bottomX, deckHeight, deckLength, 0, floorY + deckHeight / 2, deckZ));

  for (const ax of axles) for (const side of SIDES) wheelAndHub(trim, hub, side, half, radius, ax);
  trim.solid(RUBBER, block(v.widthM - 0.073, 0.245, 0.145, 0, 0.478, rear + 0.0725));
  fascia(trim, front, rear);
  const { housings, lenses } = lampFixtures(v, lay);
  for (const housing of housings) trim.quad(SEAL, ...housing);
  sideDetails(trim, half, beltY, headerY, windBaseZ, driverEnd, lay.rearAxleZ + radius + 0.16, front, rear);
  cabin(trim, half, windBaseZ, seatZ, floorY + deckHeight);
  return { body: body.geometry(), trim: trim.geometry(), glass: glass.geometry(), hub: hub.geometry(), lenses };
}
