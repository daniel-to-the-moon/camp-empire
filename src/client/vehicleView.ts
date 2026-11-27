/** 玩家车与露营者用同一套显示驱动；位姿根只由 placeVehicle 控制。 */
import * as THREE from 'three';
import type { Variant } from '../data/models';
import { SIDE_AWNING } from '../shared/config';
import { bodyCenter, wrapAngle, type Pose, type VehicleSpec } from '../shared/kinematics';
import { buildPlaceholderVehicle, buildSideAwning, setLamps, type LampState } from '../geometry/placeholder';
import { VehicleMotion, tireRadius } from '../geometry/vehicleMotion';

export function toThree(x: number, y: number, h = 0): THREE.Vector3 {
  return new THREE.Vector3(x, h, -y);
}

export function placeVehicle(obj: THREE.Object3D, s: VehicleSpec, p: Pose): void {
  const [cx, cy] = bodyCenter(s, p);
  obj.position.copy(toThree(cx, cy));
  obj.rotation.y = p.yaw + Math.PI / 2;
}

/** PathRunner 的位姿按线段插值；弦长带上前进/倒车符号，不能用名义路径速度（可能在让行）。 */
export function pathMotion(from: Pose, to: Pose, dt: number) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const yaw = wrapAngle(to.yaw - from.yaw);
  const heading = from.yaw + yaw / 2;
  const ds = Math.hypot(dx, dy) * Math.sign(dx * Math.cos(heading) + dy * Math.sin(heading));
  return ds && dt > 0 ? { speed: ds / dt, curvature: yaw / ds } : { speed: 0, curvature: 0 };
}

export type VehicleView = ReturnType<typeof makeVehicle>;
export function makeVehicle(v: Variant, tint?: number) {
  const { root, anchors, setPose } = buildPlaceholderVehicle(v, tint);
  const motion = new VehicleMotion(tireRadius(v), v.wheelbaseM);
  let awning: THREE.Group | null = null;
  return {
    root,
    get pose() { return motion.pose as Readonly<typeof motion.pose>; },
    updateMotion(dt: number, speed: number, curvature: number) {
      motion.step(dt, speed, curvature);
      setPose(motion.pose);
    },
    resetMotion() {
      motion.reset();
      setPose(motion.pose);
    },
    setLights: (on: LampState) => setLamps(root, on),
    setAwning(on: boolean) {
      if (on && !awning) {
        awning = buildSideAwning(v, SIDE_AWNING.depthM);
        anchors.side_awning.add(awning);
      } else if (!on && awning) {
        anchors.side_awning.remove(awning);
        disposeTree(awning);
        awning = null;
      }
    },
  };
}

export function disposeTree(o: THREE.Object3D): void {
  o.traverse((n) => {
    const m = n as THREE.Mesh;
    if (m.isMesh) {
      m.geometry.dispose();
      const mat = m.material;
      (Array.isArray(mat) ? mat : [mat]).forEach((x) => x.dispose());
    }
  });
}
