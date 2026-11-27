/** #99 纯显示。+z 是车头，+x 是左侧；输入由当前帧的驾驶/路径结果提供，不读取时钟或存档。 */
import * as THREE from 'three';
import type { Variant } from '../data/models';
import { DRIVING } from '../shared/config';
import { clamp } from '../shared/kinematics';

const rad = Math.PI / 180;
export const STEER_LIMIT = 20 * rad; // #99 用户选 A，各车型同一上限
export const TIRE_SEGMENTS = 16;
export const TIRE_WIDTH = 0.215;
export const tireRadius = (v: Variant) => v.lengthM * 0.061;
// 满舵轮胎最外点 = 主销 x + r sin δ + 半胎宽 cos δ；留 8 mm 余量（提案 / 待核实）。
export const frontInset = (r: number) => r * Math.sin(STEER_LIMIT) + TIRE_WIDTH / 2 * Math.cos(STEER_LIMIT) + 0.008;
// 从外壁到主销，再到胎内缘，最后给随车身倾斜的地台留边（16 mm 提案）。
export const wheelWellDepth = (r: number) => 2 * frontInset(r) + 0.016;
// 提案 / 待核实：最长轴距上俯仰行程约 30 mm，侧倾高低差约 50 mm。无弹跳、无过冲。
export const PITCH_LIMIT = 0.4 * rad;
export const LEAN_LIMIT = 1.3 * rad;
export interface MotionPose { spin: number; steer: number; pitch: number; lean: number }
export const still: Readonly<MotionPose> = { spin: 0, steer: 0, pitch: 0, lean: 0 };

export class VehicleMotion {
  readonly pose = { ...still };
  private speed = 0;
  constructor(private readonly radius: number, private readonly wheelbase: number) {}
  reset() {
    Object.assign(this.pose, still);
    this.speed = 0;
  }
  step(dt: number, speed: number, curvature: number) {
    if (dt <= 0) return;
    const p = this.pose;
    const a = (speed - this.speed) / dt;
    this.speed = speed;
    p.spin = (p.spin + speed * dt / this.radius) % (2 * Math.PI);
    p.steer = clamp(Math.atan(curvature * this.wheelbase), -STEER_LIMIT, STEER_LIMIT);
    if (speed === 0) {
      p.pitch = p.lean = 0; // 可原地打方向；已滚过的里程不倒带。
      return;
    }
    // 提案：0.14 s 一阶响应；正常起步、约 1/3 g 横向加速度分别达到行程端点。
    const k = -Math.expm1(-dt / 0.14);
    p.pitch += (-clamp(a / DRIVING.accel, -1, 1) * PITCH_LIMIT - p.pitch) * k;
    p.lean += (clamp(speed * speed * curvature / 3.3, -1, 1) * LEAN_LIMIT - p.lean) * k;
  }
}

export function groundOffset(radius: number, spin: number) {
  const facet = 2 * Math.PI / TIRE_SEGMENTS;
  const nearest = spin - facet * Math.round(spin / facet);
  return radius * (Math.cos(nearest) - 1);
}

export interface VertexSpan { first: number; end: number }
export interface WheelBinding {
  x: number; y: number; z: number; front: boolean;
  trim: VertexSpan; hub: VertexSpan;
}

/** 轮胎、轮盖分别已有自己的材质批次。只更新这两个批次里造轮时记录的连续区段，
 * 始终从绑定姿态算位置及法线（不逐帧累乘），不用每轮增加一个 mesh / shadow draw。 */
function wheelBatch(g: THREE.BufferGeometry, spans: VertexSpan[]) {
  const position = g.getAttribute('position') as THREE.BufferAttribute;
  const normal = g.getAttribute('normal') as THREE.BufferAttribute;
  const start = spans[0].first, end = spans[spans.length - 1].end;
  const bind = position.array.slice(start * 3, end * 3);
  const normals = normal.array.slice(start * 3, end * 3);
  const p = new THREE.Vector3(), n = new THREE.Vector3(), basis = new THREE.Matrix3();
  position.setUsage(THREE.DynamicDrawUsage);
  normal.setUsage(THREE.DynamicDrawUsage);
  g.computeBoundingSphere();
  const sphere = g.boundingSphere!, restRadiusSq = sphere.radius ** 2;
  return (matrices: THREE.Matrix4[]) => {
    // 保留静止部分原有的裁剪球；只按本帧实际转出去的顶点扩展，不常驻一个放大的裁剪范围。
    let radiusSq = restRadiusSq;
    for (let w = 0; w < spans.length; w++) {
      const m = matrices[w];
      basis.setFromMatrix4(m); // 刚体变换，无缩放
      for (let i = spans[w].first; i < spans[w].end; i++) {
        const offset = (i - start) * 3;
        p.fromArray(bind, offset).applyMatrix4(m);
        n.fromArray(normals, offset).applyMatrix3(basis);
        position.setXYZ(i, p.x, p.y, p.z);
        normal.setXYZ(i, n.x, n.y, n.z);
        radiusSq = Math.max(radiusSq, sphere.center.distanceToSquared(p));
      }
    }
    for (const a of [position, normal]) {
      a.clearUpdateRanges();
      a.addUpdateRange(start * 3, (end - start) * 3);
      a.needsUpdate = true;
    }
    sphere.radius = Math.sqrt(radiusSq);
    g.boundingBox = null;
  };
}

export function bindSuspension(sprung: THREE.Group, wheels: WheelBinding[], trim: THREE.BufferGeometry, hub: THREE.BufferGeometry, halfWidth: number) {
  const tires = wheelBatch(trim, wheels.map(w => w.trim));
  const caps = wheelBatch(hub, wheels.map(w => w.hub));
  const matrices = wheels.map(() => new THREE.Matrix4());
  const inverse = new THREE.Matrix4(), rotation = new THREE.Euler(0, 0, 0, 'YXZ');
  const shift = new THREE.Matrix4();
  const rear = wheels.find(w => !w.front)!;
  const pivot = new THREE.Vector3();
  const previous = { ...still };
  return (p: MotionPose) => {
    if (p.spin === previous.spin && p.steer === previous.steer && p.pitch === previous.pitch && p.lean === previous.lean) return;
    Object.assign(previous, p);
    // 后拱原有净空仅毫米级：以受载侧后悬架为支点，让另一侧舒展，前端在加宽的拱内俯仰。
    pivot.set(-Math.sign(p.lean) * halfWidth, rear.y, rear.z);
    sprung.rotation.set(p.pitch, 0, p.lean);
    sprung.position.copy(pivot).applyQuaternion(sprung.quaternion).negate().add(pivot);
    sprung.updateMatrix();
    inverse.copy(sprung.matrix).invert();
    const dy = groundOffset(rear.y, p.spin);
    wheels.forEach((w, i) => {
      // 从轮心出发：先绕车轴 X 滚动，再绕竖直主销 Y 转向。抵消父层悬挂，轮心不随车身起伏。
      const m = matrices[i].makeRotationFromEuler(rotation.set(p.spin, w.front ? p.steer : 0, 0, 'YXZ'));
      m.multiply(shift.makeTranslation(-w.x, -w.y, -w.z));
      m.premultiply(shift.makeTranslation(w.x, w.y + dy, w.z)).premultiply(inverse);
    });
    tires(matrices);
    caps(matrices);
  };
}
