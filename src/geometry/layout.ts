/**
 * 占位几何布局（纯数值，不依赖渲染）。
 *
 * 来源只有两类：models.json 公告三围 + 游戏功能需求（锚点、性能预算）。
 * 不含、也不得引入 MXGARAGE 旧生成器的任何参数（CLEANROOM_SPEC 第八节）。
 * 标“占位”的常量是为了能跑通玩法而取的风格化数值，正式模型（Tripo / clean-room）
 * 以 docs/PLACEHOLDER_GEOMETRY.md 中的 bbox 与锚点对齐即可替换，不需要匹配这些常量。
 *
 * 坐标系：原点在地面、位于车辆投影中心；Y 朝上；车头朝 +z；单位米。
 * 由右手系推得：面朝 +z 时，车辆右侧为 −x，左侧为 +x。
 */
import type { Variant } from '../data/models';

/** 占位常量（风格化取值，待正式模型时以真实规格替换） */
export const PLACEHOLDER = {
  /** 车轮半径：占位。待核实：以公告“轮胎规格”字段计算（直径 = 轮辋英寸×25.4 + 2×胎宽×扁平比） */
  wheelRadiusM: 0.36,
  wheelWidthM: 0.22,
  /** 底盘轮距外沿半宽上限：车宽超过此值的（厢式加宽车体）车轮不随车体外扩 */
  maxWheelOuterHalfM: 1.0,
  /** 车身底边离地：占位 */
  bodyBottomM: 0.32,
  /** 机盖高度：占位 */
  hoodTopM: 1.08,
  /** 机盖长度占前悬比例：占位 */
  hoodLenOfFrontOverhang: 0.85,
  /** 前风挡水平进深：占位 */
  windshieldRunM: 0.75,
  /** 眉檐车款（SH5043）驾驶室顶高：占位 */
  cabRoofM: 2.25,
  /** 侧边帐滑门段：从前轴向后偏移起点、长度：占位（功能需求：驾驶室后方滑门段） */
  slidingDoorStartBehindFrontAxleM: 0.35,
  slidingDoorLenM: 2.4,
  /** 尾挂件、牛栏杠外伸量：占位 */
  rearMountOutM: 0.25,
  bullBarOutM: 0.12,
} as const;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type AnchorName =
  | 'roof'
  | 'side_awning'
  | 'bull_bar'
  | 'snorkel'
  | 'rear_mount'
  | 'suspension';

export interface Layout {
  zFront: number;
  zRear: number;
  frontAxleZ: number;
  rearAxleZ: number;
  wheelRadius: number;
  wheelCenterX: number;
  hoodLen: number;
  /** 车身侧视轮廓（z, y），逆时针，用于挤出 */
  profile: Array<[number, number]>;
  /** 驾驶室顶高（无眉檐车 = 整车高） */
  cabRoofY: number;
  windshield: { bottom: [number, number]; top: [number, number] };
  slidingDoor: { zStart: number; zEnd: number };
  anchors: Record<AnchorName, Vec3>;
}

export function computeLayout(v: Variant): Layout {
  const P = PLACEHOLDER;
  const L = v.lengthM;
  const W = v.widthM;
  const H = v.heightM;
  const zFront = L / 2;
  const zRear = -L / 2;
  const frontAxleZ = zFront - v.frontOverhangM;
  const rearAxleZ = zRear + v.rearOverhangM;
  const hoodLen = v.frontOverhangM * P.hoodLenOfFrontOverhang;
  const wsBottom: [number, number] = [zFront - hoodLen, P.hoodTopM + 0.1];

  const wheelOuterHalf = Math.min(W / 2 - 0.02, P.maxWheelOuterHalfM);
  const wheelCenterX = wheelOuterHalf - P.wheelWidthM / 2;

  const yB = P.bodyBottomM;
  // 车身尾面内缩 6 mm，让后窗玻璃落在尾面上且整车尾端仍正好 = −L/2
  const zBodyRear = zRear + 0.006;
  let profile: Array<[number, number]>;
  let cabRoofY: number;
  let wsTop: [number, number];

  if (v.hasBrow) {
    cabRoofY = P.cabRoofM;
    wsTop = [wsBottom[0] - P.windshieldRunM, cabRoofY];
    const browTipZ = wsBottom[0] + 0.15;
    profile = [
      [zBodyRear, yB],
      [zFront, yB],
      [zFront, P.hoodTopM],
      wsBottom,
      wsTop,
      [wsTop[0] - 0.2, cabRoofY],
      [browTipZ, cabRoofY + 0.18],
      [browTipZ - 0.12, H - 0.1],
      [browTipZ - 0.35, H],
      [zBodyRear, H],
    ];
  } else {
    cabRoofY = H;
    wsTop = [wsBottom[0] - P.windshieldRunM, H - 0.1];
    profile = [
      [zBodyRear, yB],
      [zFront, yB],
      [zFront, P.hoodTopM],
      wsBottom,
      wsTop,
      [wsTop[0] - 0.2, H],
      [zBodyRear, H],
    ];
  }

  const sdStart = frontAxleZ - P.slidingDoorStartBehindFrontAxleM;
  const sdEnd = Math.max(sdStart - P.slidingDoorLenM, rearAxleZ + P.wheelRadiusM + 0.1);

  const anchors: Record<AnchorName, Vec3> = {
    roof: { x: 0, y: H, z: (wsTop[0] - 0.2 + zRear) / 2 },
    // 侧边帐装在车辆右侧（−x）：中国右侧通行，右侧为路缘 / 营位侧，与滑门同侧
    side_awning: { x: -W / 2, y: Math.min(H, v.hasBrow ? H - 0.12 : H - 0.08), z: (sdStart + sdEnd) / 2 },
    bull_bar: { x: 0, y: 0.55, z: zFront + P.bullBarOutM },
    // 涉水喉：文字“右前翼子板”= 车辆右侧（−x）。规格同一句又写 x=+W/2，在本右手系里与「右侧」相反。符号未改，证据见 docs/PERF_BODY.md，等维护者定。
    snorkel: { x: -W / 2, y: P.hoodTopM, z: zFront - hoodLen + 0.1 },
    rear_mount: { x: 0, y: 0.75, z: zRear - P.rearMountOutM },
    suspension: { x: 0, y: 0, z: 0 },
  };

  return {
    zFront,
    zRear,
    frontAxleZ,
    rearAxleZ,
    wheelRadius: P.wheelRadiusM,
    wheelCenterX,
    hoodLen,
    profile,
    cabRoofY,
    windshield: { bottom: wsBottom, top: wsTop },
    slidingDoor: { zStart: sdStart, zEnd: sdEnd },
    anchors,
  };
}
