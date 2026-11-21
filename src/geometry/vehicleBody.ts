import * as THREE from 'three';
import type { Variant } from '../data/models';
import type { Layout } from './layout';

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

/** Fills the sheet metal around real openings. Each gasket and pane shares the opening's plane. */
function windowRow(
  body: Facets, trim: Facets, glass: Facets, face: Face, bottom: number, top: number, spans: WindowSpan[],
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
    const edgeV = 0.042 / (c[1] - b[1]);
    rect(trim, SEAL, opening, 0, 0, 1, edgeV);
    rect(trim, SEAL, opening, 0, 1 - edgeV, 1, 1);
    rect(trim, SEAL, opening, 0, edgeV, edgeU, 1 - edgeV);
    rect(trim, SEAL, opening, 1 - edgeU, edgeV, 1, 1 - edgeV);
    // A narrow pale strip suggests a reflection, while the main pane leaves the cabin visible.
    rect(glass, GLASS, opening, edgeU, edgeV, 1 - edgeU, 0.93 - edgeV, opacity);
    rect(glass, GLINT, opening, edgeU, 0.93 - edgeV, 1 - edgeU, 1 - edgeV, opacity);
    previousBottom = rightBottom;
    previousTop = rightTop;
  }
  body.quad(CREAM, face(previousBottom, bottom), face(1, bottom), face(1, top), face(previousTop, top));
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
  body: Facets, trim: Facets, paint: number, low: Point[], high: Point[], axles: number[], radius: number,
): void {
  const [half, floor, front] = low[2];
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
    const span = (from: number, to: number, upperFrom = from) => {
      const x = side * half;
      skin(body, paint, [x, floor, from], [x, floor, to], [x, belt, to], [x, belt, upperFrom]);
      const edge = side * (half + 0.009);
      skin(trim, RUBBER, [edge, floor, from], [edge, floor, to], [edge, floor + 0.095, to], [edge, floor + 0.095, from]);
    };
    let cursor = front;
    for (const axle of axles) {
      span(cursor, axle + mouth, cursor === front ? high[2][2] : cursor);
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
  const cylinder = (r: number, width: number, x: number, segments: number) =>
    new THREE.CylinderGeometry(r, r, width, segments).rotateZ(Math.PI / 2).translate(side * x, Math.fround(radius), z);
  trim.solid(RUBBER, cylinder(radius, tireWidth, outer - tireWidth / 2, 16));
  trim.solid(0x414146, cylinder(radius * 0.80, 0.010, outer, 16));
  hub.solid(0xb8b1a4, cylinder(radius * 0.57, 0.025, outer + 0.007, 12));
  hub.solid(CHROME, cylinder(radius * 0.455, 0.018, outer + 0.019, 12));
  hub.solid(0x797c7a, cylinder(radius * 0.17, 0.016, outer + 0.028, 8));
}

function fascia(trim: Facets, half: number, front: number, rear: number): void {
  // The supplied signal quads stay on their original planes. Surrounds sit just behind them.
  const frontFace: Face = (x, y) => [x, y, front - 0.001];
  const frontInset: Face = (x, y) => [x, y, front - 0.0007];
  const rearFace: Face = (x, y) => [-x, y, rear + 0.009];
  const rearInset: Face = (x, y) => [-x, y, rear + 0.007];
  rect(trim, RUBBER, frontFace, -0.42, 0.785, 0.42, 1.103);
  for (const y of [0.833, 0.917, 1.001, 1.069]) rect(trim, CHROME, frontInset, -0.40, y, 0.40, y + 0.014);
  const oval = new THREE.RingGeometry(0.73, 1, 20).scale(0.125, 0.074, 1).translate(0, 0.963, front);
  trim.solid(CHROME, oval);
  const ovalInset = new THREE.CircleGeometry(1, 20).scale(0.092, 0.055, 1).translate(0, 0.963, front - 0.0004);
  trim.solid(RUBBER, ovalInset);
  rect(trim, 0x121a1d, frontFace, -0.49, 0.45, 0.49, 0.58);
  rect(trim, 0x636568, frontInset, -0.43, 0.505, 0.43, 0.518);
  rect(trim, CHROME, rearFace, -0.24, 0.955, 0.24, 1.108);
  rect(trim, 0x515758, rearInset, -0.21, 0.979, 0.21, 1.084);

  for (const side of SIDES) {
    const x = half - 0.08;
    const point = (dx: number, y: number, dz = 0.002): Point => [side * (x - dx), y, front - dz];
    const patch = (color: number, a: Point, b: Point, c: Point, d: Point) => {
      if (side === 1) trim.quad(color, a, b, c, d);
      else trim.quad(color, d, c, b, a);
    };
    patch(SEAL, point(0.46, 0.974), point(0.0, 1.014), point(0.0, 1.153), point(0.48, 1.108));
    patch(0xffdf9b, point(0.429, 1.016, 0.001), point(0.006, 1.044, 0.001),
      point(0.006, 1.137, 0.001), point(0.441, 1.093, 0.001));
    patch(0xfff4cb, point(0.427, 1.075, 0.0005), point(0.006, 1.117, 0.0005),
      point(0.006, 1.137, 0.0005), point(0.441, 1.093, 0.0005));
    const wing = (y: number): Point => [side * (half - 0.031), y, front - 0.059];
    patch(SEAL, point(0, 1.014), wing(1.037), wing(1.147), point(0, 1.153));
    patch(0xffe3a3, point(0.006, 1.044, 0.001), wing(1.061), wing(1.127), point(0.006, 1.137, 0.001));

    const fogX = side * (half - 0.31);
    rect(trim, 0x4c4e4e, frontFace, fogX - 0.09, 0.463, fogX + 0.09, 0.571);
    rect(trim, 0xbbaf92, frontInset, fogX - 0.051, 0.498, fogX + 0.051, 0.535);

    const lensX = side * (half - 0.155);
    const tail: Face = (dx, y) => rearFace(lensX + dx, y);
    rect(trim, SEAL, tail, -0.091, 0.95, 0.091, 1.76);
    const lens: Face = (dx, y) => rearInset(lensX + dx, y);
    const highlight: Face = (dx, y) => [-lensX - dx, y, rear + 0.005];
    rect(trim, 0xa93237, lens, -0.061, 0.982, 0.061, 1.729);
    rect(trim, 0xf87465, highlight, -0.053, 1.26, 0.053, 1.68);
    rect(trim, 0xffc285, highlight, -0.053, 1.085, 0.053, 1.16);
  }
}

function frontBumper(trim: Facets, half: number, front: number): void {
  const base = ring(0.362, half - 0.067, front - 0.031, front - 0.207, 0.083, 0.02);
  const lip = ring(0.412, half - 0.036, front - 0.003, front - 0.196, 0.11, 0.02);
  const top = ring(0.604, half - 0.036, front - 0.003, front - 0.196, 0.11, 0.02);
  band(trim, SEAL, base, lip);
  band(trim, RUBBER, lip, top);
  for (let i = 1; i < top.length - 1; i++) {
    trim.triangle(RUBBER, top[0], top[i], top[i + 1]);
    trim.triangle(RUBBER, base[0], base[i + 1], base[i]);
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

function dashboard(trim: Facets, half: number, windBaseZ: number, steeringX: number): void {
  // The dash meets the inner wall at the beltline and clears the shell above it.
  const lower = ring(1.16, half - 0.012, windBaseZ - 0.065, windBaseZ - 0.49, 0.09, 0.07);
  const shoulder = ring(1.315, half - 0.018, windBaseZ - 0.07, windBaseZ - 0.58, 0.09, 0.06);
  const top = ring(1.485, half - 0.096, windBaseZ - 0.175, windBaseZ - 0.55, 0.07, 0.04);
  band(trim, 0x524d46, lower, shoulder);
  band(trim, 0x997c5f, shoulder, top);
  for (let i = 1; i < top.length - 1; i++) {
    trim.triangle(0x826b55, top[0], top[i], top[i + 1]);
    trim.triangle(0x524d46, lower[0], lower[i + 1], lower[i]);
  }

  const instrumentZ = windBaseZ - 0.409;
  const instrumentY = 1.567;
  const panelAngle = Math.atan2(0.021, 0.225);
  const panelHeight = 0.113;
  trim.solid(SEAL, new THREE.BoxGeometry(0.405, panelHeight, 0.225)
    .rotateX(-panelAngle).translate(steeringX, instrumentY - panelHeight / (2 * Math.cos(panelAngle)), instrumentZ));
  trim.solid(RUBBER, block(0.425, 0.039, 0.042, steeringX, 1.578, instrumentZ + 0.092));
  for (const offset of [-0.098, 0.098]) {
    const x = steeringX + offset;
    trim.solid(0xd5c9a9, new THREE.RingGeometry(0.031, 0.045, 10)
      .rotateX(-Math.PI / 2 - panelAngle).translate(x, instrumentY + 0.001, instrumentZ));
    trim.solid(0xd99464, new THREE.BoxGeometry(0.009, 0.004, 0.035)
      .rotateY(Math.sign(offset) * 0.52).rotateX(-panelAngle).translate(x, instrumentY + 0.002, instrumentZ));
  }
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

function cabin(trim: Facets, half: number, windBaseZ: number, driverEnd: number, floorY: number): void {
  const saddle = 0xbb794d;
  const cushion = 0xeabc88;
  const seatX = half * 0.47;
  const seatZ = driverEnd + 0.21;
  const deckHeight = 0.073;
  const deckTop = floorY + 0.07;
  const pedestalBottom = deckTop + 0.026;
  const pedestalTop = 0.81;
  trim.solid(0x303637, block(half * 1.74, deckHeight, 1.34, 0, deckTop - deckHeight / 2, seatZ + 0.18));
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
  dashboard(trim, half, windBaseZ, seatX);
  steering(trim, seatX, windBaseZ);
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
  const floorY = 0.4;
  const beltY = 1.19;
  const windBaseZ = front - v.frontOverhangM * 0.68;
  const windTopZ = windBaseZ - 0.69;
  const headerY = v.hasBrow ? 2.20 : v.heightM - 0.21;
  const driverEnd = windTopZ - 0.34;

  const sill = ring(floorY, half - 0.012, front - 0.023, rear + 0.012, 0.10, 0.036);
  const belt = ring(beltY, half - 0.012, front - 0.004, rear + 0.012, 0.073, 0.036);
  const hood = ring(1.32, half - 0.012, windBaseZ, rear + 0.012, 0.096, 0.036);
  const header = ring(headerY, half - 0.052, windTopZ, rear + 0.012, 0.096, 0.056);
  band(body, paint, sill, belt, [2, 6]);
  paintLowerSides(body, trim, paint, sill, belt, axles, radius);
  band(body, CREAM, belt, hood, [0]);
  const bonnet = stationFace(belt, hood, 0);
  const hoodRidge: Point = [0, 1.276, lerp(belt[0][2], windBaseZ, 0.5)];
  body.triangle(CREAM, bonnet(0, 0), bonnet(0.5, 0), hoodRidge);
  body.quad(CREAM, bonnet(0, 0), hoodRidge, bonnet(0.5, 1), bonnet(0, 1));
  body.triangle(CREAM, bonnet(0.5, 0), bonnet(1, 0), hoodRidge);
  body.quad(CREAM, hoodRidge, bonnet(1, 0), bonnet(1, 1), bonnet(0.5, 1));
  band(body, CREAM, hood, header, [0, 2, 4, 6]);
  windowRow(body, trim, glass, stationFace(hood, header, 0), 0.055, 0.945, [[0.032, 0.968, 0.032, 0.968, 0.30]]);
  windowRow(body, trim, glass, stationFace(hood, header, 4), 0.22, 0.90, [[0.16, 0.84, 0.16, 0.84, 0.67]]);
  const windowBottom = 0.075;
  const windowTop = 0.89;
  const left = stationFace(hood, header, 2);
  const windows = sideWindows(left, windowBottom, windowTop, driverEnd, rear);
  windowRow(body, trim, glass, left, windowBottom, windowTop, windows);
  windowRow(body, trim, glass, stationFace(hood, header, 6), windowBottom, windowTop,
    [...windows].reverse().map(([a, b, c, d, opacity]) => [1 - b, 1 - a, 1 - d, 1 - c, opacity]));

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
  band(body, CREAM, roofBase, eave);
  band(body, CREAM, eave, roof);
  for (let i = 1; i < roof.length - 1; i++) body.triangle(CREAM, roof[0], roof[i], roof[i + 1]);
  // The chassis floor leaves the tire sweep open at the four outside corners.
  const bottomX = half - 0.27;
  body.quad(paint, [-bottomX, floorY, rear + 0.012], [bottomX, floorY, rear + 0.012],
    [bottomX, floorY, front - 0.023], [-bottomX, floorY, front - 0.023]);

  for (const ax of axles) for (const side of SIDES) wheelAndHub(trim, hub, side, half, radius, ax);
  frontBumper(trim, half, front);
  trim.solid(RUBBER, block(v.widthM - 0.073, 0.245, 0.145, 0, 0.478, rear + 0.0725));
  fascia(trim, half, front, rear);
  sideDetails(trim, half, beltY, headerY, windBaseZ, driverEnd, lay.rearAxleZ + radius + 0.16, front, rear);
  cabin(trim, half, windBaseZ, driverEnd, floorY);
  return { body: body.geometry(), trim: trim.geometry(), glass: glass.geometry(), hub: hub.geometry() };
}
