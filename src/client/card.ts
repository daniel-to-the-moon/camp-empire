/**
 * 露营卡片绘制（issue #30）：竖版 720 × 1440 PNG。取数与文案在 src/shared/card.ts（有测试），这里只负责排版。
 * 版式尺寸是界面排版，不是玩法数值。美术与文案均为原创占位。
 */
import { cardStats, type CardData } from '../shared/card';

export const CARD_W = 720;
export const CARD_H = 1440;
/** 车辆特写与营地全景截图尺寸（像素） */
export const SHOT_W = 640;
export const VEHICLE_SHOT_H = 340;
export const CAMP_SHOT_H = 380;

const SANS = '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const C = { bg: '#182921', panel: '#2b4639', birch: '#ece6d6', dim: 'rgba(236,230,214,0.6)', canvas: '#e0892e', coin: '#f2c14e', moss: '#9cbd76', love: '#d99a9a' };

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

function shot(ctx: CanvasRenderingContext2D, img: CanvasImageSource, x: number, y: number, w: number, h: number) {
  ctx.save();
  rounded(ctx, x, y, w, h, 18);
  ctx.clip();
  ctx.drawImage(img, x, y, w, h);
  ctx.restore();
  ctx.strokeStyle = 'rgba(236,230,214,0.25)';
  ctx.lineWidth = 2;
  rounded(ctx, x, y, w, h, 18);
  ctx.stroke();
}

/** 卡片画布：默认新建 <canvas>；测试传入记录绘制调用的假画布 */
export function drawCard<K extends HTMLCanvasElement>(
  d: CardData,
  vehicleShot: CanvasImageSource,
  campShot: CanvasImageSource,
  createCanvas: () => K = () => document.createElement('canvas') as K,
): K {
  const c = createCanvas();
  c.width = CARD_W;
  c.height = CARD_H;
  const ctx = c.getContext('2d')!;
  const x0 = (CARD_W - SHOT_W) / 2;

  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, CARD_W, CARD_H);

  // 抬头：游戏名 + 日期
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = C.birch;
  ctx.font = `800 40px ${SANS}`;
  ctx.fillText(d.game, x0, 92);
  ctx.fillStyle = C.dim;
  ctx.font = `500 24px ${MONO}`;
  ctx.textAlign = 'right';
  ctx.fillText(d.date, x0 + SHOT_W, 92);
  ctx.textAlign = 'left';

  // 车型：特写 + 名称
  let y = 124;
  shot(ctx, vehicleShot, x0, y, SHOT_W, VEHICLE_SHOT_H);
  y += VEHICLE_SHOT_H + 48;
  ctx.fillStyle = C.canvas;
  ctx.font = `700 30px ${SANS}`;
  ctx.fillText(d.vehicle.model, x0, y);
  ctx.fillStyle = C.dim;
  ctx.font = `400 22px ${SANS}`;
  ctx.fillText(`${d.vehicle.roof} · ${d.vehicle.size}`, x0, y + 34);

  // 营地全景
  y += 66;
  shot(ctx, campShot, x0, y, SHOT_W, CAMP_SHOT_H);
  y += CAMP_SHOT_H + 28;

  // 当日数据：三列
  const stats = cardStats(d);
  const colW = SHOT_W / stats.length;
  rounded(ctx, x0, y, SHOT_W, 128, 18);
  ctx.fillStyle = C.panel;
  ctx.fill();
  ctx.textAlign = 'center';
  stats.forEach((s, i) => {
    const cx = x0 + colW * i + colW / 2;
    ctx.fillStyle = [C.moss, C.coin, C.love][i];
    ctx.font = `700 ${s.value.length > 8 ? 26 : 34}px ${SANS}`;
    ctx.fillText(s.value, cx, y + 62);
    ctx.fillStyle = C.dim;
    ctx.font = `400 20px ${SANS}`;
    ctx.fillText(s.label, cx, y + 100);
  });
  ctx.textAlign = 'left';
  y += 128 + 50;

  // 成就 / 里程碑：没有就整块不显示
  if (d.milestones.length) {
    ctx.fillStyle = C.birch;
    ctx.font = `700 24px ${SANS}`;
    ctx.fillText('营地里程碑', x0, y);
    ctx.font = `400 22px ${SANS}`;
    d.milestones.forEach((m, i) => {
      ctx.fillStyle = C.coin;
      ctx.fillText('★', x0, y + 40 + i * 36);
      ctx.fillStyle = C.birch;
      ctx.fillText(m, x0 + 32, y + 40 + i * 36);
    });
  }

  // 页脚
  ctx.fillStyle = C.dim;
  ctx.font = `400 18px ${SANS}`;
  ctx.textAlign = 'center';
  ctx.fillText(`今日数据按上海日 ${d.date} 统计 · 车辆与营地为占位外观`, CARD_W / 2, CARD_H - 36);
  return c;
}
