/**
 * M1 参数。分三类，注释里逐项标明：
 * - 【转述待确认】2026-11-04 与 Claude 本地会话中用户答复的转述，待用户在 issue 中确认；确认前只算转述证据，
 *   不是正式结论（CHARTER 第二节；记录见 docs/ECONOMY_M1.md 第一节）；
 * - 【沿用】前几轮讨论中 GPT 已复算通过的口径或提案值；
 * - 【提案】本 PR 为跑通玩法取的值，待 Muse 定量建模、GPT 评审、用户拍板。改这里必须同步改推演表。
 */

/** 账本单位：1 金 = 100 分（整数），展示向下取整。【转述待确认】 */
export const CENTS_PER_GOLD = 100;

export const ECONOMY = {
  /** 开局金币。【沿用】GDD 第五节“初始 1000 金”，作为本游戏设计参数，非怀旧实证 */
  startingGold: 1000,
  /** 日界：Asia/Shanghai 00:00（UTC+8，无夏令时）。【转述待确认】 */
  dayOffsetMs: 8 * 3600_000,
  /**
   * 日软上限 g(x)：x ≤ 阈值时全额；超出部分按 50% 发放。【沿用】v3 形式。
   * 阈值 1600 是 v3 在好友停车情景下的值；M1 收入来源变了，阈值须按新收入重定（待 Muse）。
   * 按本文件提案费率，M1 日毛收入期望约 680 金，不会触发软上限（见推演表）。
   */
  softCapThresholdGold: 1600,
  softCapRateAbove: 0.5,
} as const;

/** 每日首次登录奖励 C（营地管理员巡视送礼）。发放时点【转述待确认】：每日首次登录；分布【沿用】v3：30/50/80 金，概率 40/30/30%，期望 51 */
export const DAILY_GIFT = [
  { gold: 30, p: 0.4 },
  { gold: 50, p: 0.3 },
  { gold: 80, p: 0.3 },
] as const;

/** NPC 露营者停你的车位（M1 唯一停车收入来源）。机制【转述待确认】，数值【提案】 */
export const NPC = {
  /** 每车每小时付给营主的金币（分）：10 金 / 车·小时【提案】 */
  rateCentsPerHour: 10 * 100,
  /** 单次停靠封顶 12 h，到点自动离开、自动结算【转述待确认】 */
  capMinutes: 12 * 60,
  /** 停靠时长在 [min, cap] 内均匀分布（整分钟）【提案】 */
  minStayMinutes: 2 * 60,
  /** 车位空出后到下一辆 NPC 到达的等待：指数分布，均值 60 分钟【提案】 */
  meanGapMinutes: 60,
  /** 侧边帐在家位展开时，等待均值乘此系数（营地更有吸引力）【提案】 */
  awningGapFactor: 0.75,
} as const;

/** 侧边帐：M1 唯一升级件（四要素：获取途径 / 成本 / 数值收益 / 展示效果） */
export const SIDE_AWNING = {
  /** 获取途径：营地小卖部用金币购买。成本【沿用】v3 L1 价 800 */
  priceGold: 800,
  /** 展开进深 m【沿用】#1 讨论：侧边帐外伸 2.5 m */
  depthM: 2.5,
} as const;

/** 驾驶手感。转弯缩放 k【转述待确认】方向为“缩小”，取值【提案】0.75，待原型试开定 */
export const DRIVING = {
  /** 【实时】A4DB 手册反推外轮最大转角 30°；【假设】其他车型沿用 */
  realOuterSteerDeg: 30,
  turnScaleK: 0.75,
  /** 营地限速约 20 km/h【提案】 */
  maxForwardSpeed: 5.5,
  maxReverseSpeed: 2.5,
  accel: 2.5,
  reverseAccel: 1.8,
  brakeDecel: 6,
  coastDecel: 1.5,
  /** 方向从中位打到满舵约 0.6 s */
  steerRatePerS: 1 / 0.6,
} as const;
