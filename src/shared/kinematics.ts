/**
 * 车辆运动学（单车模型，后轴中心为参考点）。纯函数、无渲染依赖，可单测、可迁服务端。
 *
 * 坐标系（逻辑层统一用数学平面系）：x 向东、y 向北，yaw 为车头朝向（0 = 朝 +x，逆时针为正），单位米 / 弧度。
 * 渲染层映射见 src/client/scene.ts：three.x = x，three.z = −y，rotation.y = yaw + π/2。
 *
 * 为什么不用物理引擎：转弯包络、自动泊入路径、营地道路宽度验算必须用同一套公式，
 * 才能保证“系统能泊进去的位置，玩家手动也泊得进去”（#1 讨论 D2 / E3）。
 */
import type { Variant } from '../data/models';
import { DRIVING } from './config';

export interface VehicleSpec {
  /** 轴距 L */
  wheelbaseM: number;
  /** 前轮距：公告无此字段时按“车宽 − 0.264 m”假设（A4DB 实测 1998 − 1734 = 264 mm） */
  trackM: number;
  widthM: number;
  lengthM: number;
  frontOverhangM: number;
  rearOverhangM: number;
}

export interface Pose {
  x: number;
  y: number;
  yaw: number;
}

/** 【实时】上汽大通 V80 手册：SH6601A4DB 前轮距 1734 mm、车宽 1998 mm（2026-11-03 查阅） */
export const TRACK_INSET_M = 1.998 - 1.734;

export function specOf(v: Variant): VehicleSpec {
  return {
    wheelbaseM: v.wheelbaseM,
    trackM: v.widthM - TRACK_INSET_M,
    widthM: v.widthM,
    lengthM: v.lengthM,
    frontOverhangM: v.frontOverhangM,
    rearOverhangM: v.rearOverhangM,
  };
}

/**
 * 真实外前轮最小转弯半径。
 * 【实时】A4DB 手册最小转弯直径 16.7 m、轴距 4.175 m → 外轮转角 asin(4.175 / 8.35) = 30.0°；
 * 【假设】手册无 3760 mm 轴距车型数据，全部车型沿用 30° 外轮转角（待 Muse 核实）。
 */
export function realOuterFrontRadius(s: VehicleSpec): number {
  return s.wheelbaseM / Math.sin((DRIVING.realOuterSteerDeg * Math.PI) / 180);
}

/** 游戏内外前轮最小半径 = k × 真实值（风格化缩小，用户 2026-11-04 拍板“缩小一些让它好开”） */
export function gameOuterFrontRadius(s: VehicleSpec, k: number = DRIVING.turnScaleK): number {
  return k * realOuterFrontRadius(s);
}

/** 由外前轮半径反推后轴中心最小半径 Rr = √(R外² − L²) − 轮距/2 */
export function minRearAxleRadius(s: VehicleSpec, k: number = DRIVING.turnScaleK): number {
  const r = gameOuterFrontRadius(s, k);
  return Math.sqrt(r * r - s.wheelbaseM * s.wheelbaseM) - s.trackM / 2;
}

/** 满舵时外前轮转角（度），用于展示“风格化程度” */
export function outerSteerDeg(s: VehicleSpec, k: number = DRIVING.turnScaleK): number {
  return (Math.asin(s.wheelbaseM / gameOuterFrontRadius(s, k)) * 180) / Math.PI;
}

export interface SweptEnvelope {
  rearAxleR: number;
  /** 车身内侧最小半径 */
  innerR: number;
  /** 车头外角半径 */
  outerR: number;
  /** 原始扫掠宽（不含余量） */
  sweptW: number;
  /** 外包络直径（不是“原地掉头”） */
  envelopeD: number;
}

/** 稳态满舵扫掠包络（矩形车身）。车身内侧 = Rr − W/2；车头外角 = √((Rr + W/2)² + (L + 前悬)²) */
export function sweptEnvelope(s: VehicleSpec, rearAxleR: number): SweptEnvelope {
  const innerR = rearAxleR - s.widthM / 2;
  const outerR = Math.hypot(rearAxleR + s.widthM / 2, s.wheelbaseM + s.frontOverhangM);
  return { rearAxleR, innerR, outerR, sweptW: outerR - innerR, envelopeD: 2 * outerR };
}

/** 车身四角（世界坐标），顺序：右后、右前、左前、左后（逆时针） */
export function footprint(s: VehicleSpec, p: Pose, pad = 0): Array<[number, number]> {
  const c = Math.cos(p.yaw);
  const sn = Math.sin(p.yaw);
  const back = -s.rearOverhangM - pad;
  const front = s.wheelbaseM + s.frontOverhangM + pad;
  const hw = s.widthM / 2 + pad;
  const local: Array<[number, number]> = [
    [back, -hw],
    [front, -hw],
    [front, hw],
    [back, hw],
  ];
  return local.map(([u, v]) => [p.x + u * c - v * sn, p.y + u * sn + v * c]);
}

/** 车身几何中心（后轴中心前移 (L + 前悬 − 后悬)/2） */
export function bodyCenter(s: VehicleSpec, p: Pose): [number, number] {
  const d = (s.wheelbaseM + s.frontOverhangM - s.rearOverhangM) / 2;
  return [p.x + d * Math.cos(p.yaw), p.y + d * Math.sin(p.yaw)];
}

/** 由车身中心反推后轴中心位姿 */
export function poseFromCenter(s: VehicleSpec, cx: number, cy: number, yaw: number): Pose {
  const d = (s.wheelbaseM + s.frontOverhangM - s.rearOverhangM) / 2;
  return { x: cx - d * Math.cos(yaw), y: cy - d * Math.sin(yaw), yaw };
}

export interface DriveState {
  pose: Pose;
  /** 纵向速度 m/s，负为倒车 */
  speed: number;
  /** 曲率 1/m（正 = 左转） */
  curvature: number;
}

export interface DriveInput {
  /** −1..1：正为前进油门，负为刹车/倒车 */
  throttle: number;
  /** −1..1：正为左打方向 */
  steer: number;
}

/** 积分一步（精确圆弧积分，dt 任意大小都不会让转弯半径小于最小半径） */
export function integrate(p: Pose, speed: number, curvature: number, dt: number): Pose {
  const ds = speed * dt;
  if (Math.abs(curvature) < 1e-9) {
    return { x: p.x + ds * Math.cos(p.yaw), y: p.y + ds * Math.sin(p.yaw), yaw: p.yaw };
  }
  const dyaw = ds * curvature;
  const r = 1 / curvature;
  return {
    x: p.x + r * (Math.sin(p.yaw + dyaw) - Math.sin(p.yaw)),
    y: p.y - r * (Math.cos(p.yaw + dyaw) - Math.cos(p.yaw)),
    yaw: wrapAngle(p.yaw + dyaw),
  };
}

export function wrapAngle(a: number): number {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

/** 手动驾驶：油门 / 方向输入 → 新状态（未做碰撞，碰撞由调用方用 footprint 判定后决定是否接受） */
export function stepDrive(s: VehicleSpec, st: DriveState, input: DriveInput, dt: number): DriveState {
  const D = DRIVING;
  const kMax = 1 / minRearAxleRadius(s);
  // 方向：以有限转向速率逼近目标曲率（避免一帧打满）
  const target = clamp(input.steer, -1, 1) * kMax;
  const maxDk = D.steerRatePerS * kMax * dt;
  const curvature = st.curvature + clamp(target - st.curvature, -maxDk, maxDk);
  // 纵向：油门方向与当前速度相反时视为刹车
  let speed = st.speed;
  const t = clamp(input.throttle, -1, 1);
  if (t === 0) {
    speed = approach(speed, 0, D.coastDecel * dt);
  } else if (Math.sign(t) === Math.sign(speed) || speed === 0) {
    speed += t * (t > 0 ? D.accel : D.reverseAccel) * dt;
  } else {
    speed = approach(speed, 0, D.brakeDecel * Math.abs(t) * dt);
  }
  speed = clamp(speed, -D.maxReverseSpeed, D.maxForwardSpeed);
  return { pose: integrate(st.pose, speed, curvature, dt), speed, curvature };
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function approach(v: number, target: number, step: number): number {
  return v > target ? Math.max(target, v - step) : Math.min(target, v + step);
}
