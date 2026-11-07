/**
 * 截图（露营卡片 #30）：用临时相机按 w × h 像素渲染一帧，渲染后立即在同一任务里拷进 2D 画布
 *（WebGL 画布未开 preserveDrawingBuffer，合成前缓冲区内容有效），再恢复原尺寸、像素比、雾与标牌并重绘主画面。
 * 渲染器、场景、画布都以最小接口传入，tests/card.test.ts 用假对象验证成功与异常两条路径的状态恢复。
 */

export interface SnapRenderer<S, C> {
  getSize(target: { x: number; y: number; set(x: number, y: number): unknown }): { x: number; y: number };
  getPixelRatio(): number;
  setPixelRatio(r: number): void;
  setSize(w: number, h: number, updateStyle?: boolean): void;
  render(scene: S, camera: C): void;
  domElement: CanvasImageSource;
}

export interface Snap2D {
  width: number;
  height: number;
  getContext(kind: '2d'): { drawImage(img: CanvasImageSource, x: number, y: number, w: number, h: number): void } | null;
}

export interface SnapshotDeps<S extends { fog: unknown }, C, K extends Snap2D> {
  renderer: SnapRenderer<S, C>;
  scene: S;
  /** 主相机：截图后用它重绘主画面 */
  mainCamera: C;
  /** 车位标牌等可隐藏的精灵 */
  labels: Iterable<{ visible: boolean }>;
  createCanvas(): K;
}

export function takeSnapshot<S extends { fog: unknown }, C, K extends Snap2D>(
  deps: SnapshotDeps<S, C, K>,
  shotCamera: C,
  w: number,
  h: number,
  { fog = true, labels: showLabels = true }: { fog?: boolean; labels?: boolean } = {},
): K {
  const { renderer, scene } = deps;
  const v = { x: 0, y: 0, set(x: number, y: number) { this.x = x; this.y = y; return this; } };
  const size = renderer.getSize(v);
  const sw = size.x;
  const sh = size.y;
  const ratio = renderer.getPixelRatio();
  const sceneFog = scene.fog;
  const hidden = showLabels ? [] : [...deps.labels].filter((s) => s.visible);
  const out = deps.createCanvas();
  out.width = w;
  out.height = h;
  try {
    if (!fog) scene.fog = null;
    for (const s of hidden) s.visible = false;
    renderer.setPixelRatio(1);
    renderer.setSize(w, h, false);
    renderer.render(scene, shotCamera);
    const ctx = out.getContext('2d');
    if (!ctx) throw new Error('2D 画布不可用');
    ctx.drawImage(renderer.domElement, 0, 0, w, h);
  } finally {
    scene.fog = sceneFog;
    for (const s of hidden) s.visible = true;
    renderer.setPixelRatio(ratio);
    renderer.setSize(sw, sh, false);
    renderer.render(scene, deps.mainCamera);
  }
  return out;
}
