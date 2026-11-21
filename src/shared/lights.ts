/**
 * 车灯（issue #44 第 5 项；用户 2026-11-08 拍板“自动灯光”）。纯函数，只决定亮灭，不做任何惩罚或扣分。
 *
 * 规则：
 * - 转向灯：随转向输入自动亮——左打方向亮左侧、右打亮右侧；方向回正即灭；车停稳（|速度| ≤ stopSpeed）不闪。
 *   自动驾驶时没有方向输入，用路径的实际曲率代替（|曲率| > autoTurnCurvature 才算转弯）。
 * - 刹车灯（红）：玩家正在刹车（反向油门或空格）时亮，含停稳后仍踩着刹车；自动驾驶让行停住时亮。滑行减速不亮（现实中松油门不亮刹车灯）。
 * - 倒车灯（白）：车在倒退时亮（现实中以白色倒车灯区分倒车，GPT 在 #44 评审第 6 条）。
 * - 停回家位（parked）：全部熄灭。
 */
export const LIGHTS = {
  /**
   * 闪光频率 1.5 Hz（90 次/分）。【待核实】常见法规要求转向灯闪光频率 60–120 次/分（如 GB 4785 / ECE R48 口径），
   * 取中值；条文原文与版本未在本 PR 中查证。
   */
  blinkHz: 1.5,
  /** 低于此速度视为停稳 m/s（与 main.ts 自动停家位判定同口径） */
  stopSpeed: 0.05,
  /** 方向输入超过此值才算转向（避免手柄 / 触屏微小偏移误触发）【提案】 */
  steerThreshold: 0.1,
  /** 自动驾驶时曲率超过此值才算转弯 1/m【提案】：约等于转弯半径 < 33 m；环路弯道半径 9 m（曲率 0.11）会亮，直线段不亮 */
  autoTurnCurvature: 0.03,
} as const;

export type LightMode = 'parked' | 'driving' | 'auto';

export interface LightInput {
  mode: LightMode;
  /** −1..1，正 = 左打方向（手动驾驶时为玩家输入） */
  steer: number;
  /** 自动驾驶时的路径曲率（正 = 左转）；手动驾驶时忽略 */
  curvature?: number;
  /** 纵向速度 m/s，负为倒车 */
  speed: number;
  /** 正在刹车（手动：反向油门或空格；自动：让行停住） */
  braking: boolean;
}

export interface LightState {
  /** 左 / 右转向灯处于“开启”状态（实际亮灭再按 blinkOn 闪） */
  left: boolean;
  right: boolean;
  brake: boolean;
  reverse: boolean;
}

export const LIGHTS_OFF: LightState = { left: false, right: false, brake: false, reverse: false };

export function lightsFor(i: LightInput): LightState {
  if (i.mode === 'parked') return LIGHTS_OFF;
  const moving = Math.abs(i.speed) > LIGHTS.stopSpeed;
  let turn = 0;
  if (moving) {
    if (i.mode === 'auto') {
      const k = i.curvature ?? 0;
      turn = Math.abs(k) > LIGHTS.autoTurnCurvature ? Math.sign(k) : 0;
    } else turn = Math.abs(i.steer) > LIGHTS.steerThreshold ? Math.sign(i.steer) : 0;
  }
  return { left: turn > 0, right: turn < 0, brake: i.braking, reverse: i.speed < -LIGHTS.stopSpeed };
}

/**
 * 转向灯闪烁相位：开启那一刻先亮（现实中拨杆即亮），亮、灭各占半个周期。
 * sinceS = 本次转向灯开启后经过的秒数。
 */
export function blinkOn(sinceS: number, hz: number = LIGHTS.blinkHz): boolean {
  if (sinceS < 0) return false;
  return (sinceS * hz) % 1 < 0.5;
}

/** 手动驾驶是否算“在刹车”：按空格，或油门方向与当前速度相反（stepDrive 里同样按刹车处理） */
export function manualBraking(throttle: number, speed: number, spaceHeld: boolean): boolean {
  if (spaceHeld) return true;
  return throttle !== 0 && speed !== 0 && Math.sign(throttle) !== Math.sign(speed);
}

/**
 * 转向灯开启时刻跟踪：返回每侧开启后经过的秒数（未开启为 −1）。状态由调用方保存。
 * 同一侧持续开启时计时连续，切换方向或熄灭后重新从 0 开始。
 */
export class BlinkClock {
  private leftSince = -1;
  private rightSince = -1;

  update(s: LightState, tS: number): { left: boolean; right: boolean } {
    this.leftSince = s.left ? (this.leftSince < 0 ? tS : this.leftSince) : -1;
    this.rightSince = s.right ? (this.rightSince < 0 ? tS : this.rightSince) : -1;
    return {
      left: this.leftSince >= 0 && blinkOn(tS - this.leftSince),
      right: this.rightSince >= 0 && blinkOn(tS - this.rightSince),
    };
  }
}
