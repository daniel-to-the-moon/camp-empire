/** 控制面板图标：内联 SVG（不用 emoji，避免缺字体时显示方块），线条随 currentColor */
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICON = {
  /** 车库：一辆小房车 */
  garage: svg('<path d="M3 16V8.5A1.5 1.5 0 0 1 4.5 7H15l3.5 4H21v5"/><path d="M3 16h18"/><circle cx="7.5" cy="17" r="1.8"/><circle cx="16.5" cy="17" r="1.8"/><path d="M6 10h4M15 7v4h3.5"/>'),
  /** 小卖部：遮阳篷 */
  shop: svg('<path d="M4 9l1.5-4h13L20 9"/><path d="M4 9c0 1.4 1.2 2 2 2s2-.6 2-2c0 1.4 1.2 2 2 2s2-.6 2-2c0 1.4 1.2 2 2 2s2-.6 2-2c0 1.4 1.2 2 2 2s2-.6 2-2"/><path d="M5.5 11v8h13v-8"/><path d="M10 19v-4h4v4"/>'),
  /** 露营卡片：相机 */
  card: svg('<rect x="3" y="7" width="18" height="12" rx="2.5"/><path d="M8.5 7l1.5-2.5h4L15.5 7"/><circle cx="12" cy="13" r="3.2"/>'),
  /** 车型图鉴：书 */
  dex: svg('<path d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v15H5.5A1.5 1.5 0 0 0 4 20.5z"/><path d="M20 5.5A1.5 1.5 0 0 0 18.5 4H13v15h5.5a1.5 1.5 0 0 1 1.5 1.5z"/>'),
  /** 隐私与统计：盾牌 */
  privacy: svg('<path d="M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
  /** 待收取：一摞金币 */
  pending: svg('<ellipse cx="12" cy="7" rx="6" ry="2.5"/><path d="M6 7v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5V7"/><path d="M6 11v4c0 1.4 2.7 2.5 6 2.5s6-1.1 6-2.5v-4"/>'),
  /** 车位：P 牌 */
  spots: svg('<rect x="4" y="3" width="16" height="18" rx="3"/><path d="M10 16V8h3a2.5 2.5 0 0 1 0 5h-3"/>'),
  /** 每日：礼物盒 */
  daily: svg('<rect x="4" y="9" width="16" height="11" rx="1.5"/><path d="M3 9h18M12 9v11"/><path d="M12 9c-1.5-3-5-3.5-5-1.5S10 9 12 9zM12 9c1.5-3 5-3.5 5-1.5S14 9 12 9z"/>'),
  /** 流水：清单 */
  log: svg('<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>'),
  /** 快捷键引导：键盘 */
  keys: svg('<rect x="2.5" y="6" width="19" height="12" rx="2.5"/><path d="M6 10h.01M9 10h.01M12 10h.01M15 10h.01M18 10h.01M7 14h10"/>'),
  /** 视图：俯瞰（从上往下的眼） */
  overview: svg('<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"/><circle cx="12" cy="12" r="2.6"/>'),
  /** 视图：跟随（车后的箭头） */
  follow: svg('<path d="M12 4l6 7h-4v8h-4v-8H6z"/>'),
  /** 视图：环绕（环形箭头） */
  orbit: svg('<path d="M20 12a8 8 0 1 1-2.3-5.7"/><path d="M20 4v5h-5"/>'),
  /** 视图：引擎盖（方向盘） */
  hood: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="2"/><path d="M4.5 10.5l5.6 1M19.5 10.5l-5.6 1M12 14v6"/>'),
} as const;
