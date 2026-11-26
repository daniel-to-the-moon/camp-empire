/** CLEANROOM_SPEC §5 前部：以下截面为风格化提案，非原厂量测。
 * 车头漆面、灯座和格栅共用同一条从门槛到腰线的斜面与切角。
 */
export const noseFloor = 0.4;
export const noseBelt = 1.19;
export function noseProfile(front: number, y: number) {
  const t = (y - noseFloor) / (noseBelt - noseFloor);
  return { z: front - 0.023 + 0.019 * t, cut: 0.10 - 0.027 * t };
}

// 灯壳内端与主格栅两端共边；壳体饰面比钣金高 1 mm，避免共面闪烁。
export const grille = { halfWidth: 0.36, bottom: 0.96, top: 1.135, proud: 0.001 } as const;
