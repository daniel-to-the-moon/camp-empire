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

/** 按实际位移给弦长带上前进/倒车符号；原地让行时无法从位移求曲率，沿用上一帧。 */
export function pathMotion(from: Pose, to: Pose, dt: number, previousCurvature = 0) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const yaw = wrapAngle(to.yaw - from.yaw);
  const heading = from.yaw + yaw / 2;
  const ds = Math.hypot(dx, dy) * Math.sign(dx * Math.cos(heading) + dy * Math.sin(heading));
  return ds && dt > 0 ? { speed: ds / dt, curvature: yaw / ds } : { speed: 0, curvature: previousCurvature };
}

export type VehicleView = ReturnType<typeof makeVehicle>;
export function makeVehicle(v: Variant, tint?: number) {
  const { root, anchors, setPose } = buildPlaceholderVehicle(v, tint);
  const motion = new VehicleMotion(tireRadius(v), v.wheelbaseM);
  let lastCurvature = 0;
  let awning: THREE.Group | null = null;
  return {
    root,
    get pose() { return motion.pose as Readonly<typeof motion.pose>; },
    updateMotion(from: Pose, to: Pose, dt: number, manualCurvature?: number) {
      if (dt <= 0) return;
      const travel = pathMotion(from, to, dt, lastCurvature);
      lastCurvature = manualCurvature ?? travel.curvature; // 手动模式即使不动也能打方向
      motion.step(dt, travel.speed, lastCurvature);
      setPose(motion.pose);
    },
    resetMotion() {
      lastCurvature = 0;
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
