/**
 * 家位上的两个玩家动作：换车与出库（O）。从 main.ts 抽出，便于在 node 里按真实的提交时序做回归测试（GPT 审核 #14 第 1 条）。
 *
 * 不依赖 three / DOM：画面相关的操作（重建玩家车、起步自动驾驶、提示）都通过 deps 注入，main.ts 只负责接线。
 * 存档动作统一经 deps.act 进入本页队列与原子事务；路线在事务里按最新车型规划（issue #12，见 src/shared/depart.ts）。
 */
import type { Stall } from '../shared/camp';
import { departHome } from '../shared/depart';
import type { Shape } from '../shared/geom2d';
import type { PathPose } from '../shared/parking';
import { selectVariant, type GameState } from '../shared/state';
import type { CampEvent } from '../shared/npc';

export type Mode = 'parked' | 'driving' | 'auto';

/** 改变玩家车模式的动作（出发 / 停回家位）正在等存档提交：期间不重复触发。main.ts 的停回家位共用同一个标志 */
export interface ModeLock {
  busy: boolean;
}

export interface HomeFlowDeps {
  /** main.ts 的 act()：排队 → 事务 → 提交成功后采纳状态；只读页或写入失败返回 null */
  act<R extends { events: CampEvent[] }>(fn: (s: GameState) => R): Promise<R | null>;
  /** 当前（已提交并采纳的）状态 */
  state(): GameState;
  /** 画面玩家车的模式 */
  mode(): Mode;
  now(): number;
  home: Stall;
  /** 事务执行时才取：静态障碍 + 停好的 NPC 车身 */
  obstacles(): Shape[];
  /** 画面玩家车当前对应的车型 */
  viewVariantId(): string;
  /** 按 state() 的车型重建画面玩家车；停在家位时位姿重置为新车型的家位位姿 */
  rebuildPlayer(): void;
  setAwning(on: boolean): void;
  /** 沿路线自动驾驶，走完调用 done */
  startAuto(path: PathPose[], done: () => void): void;
  /** 出库走完：切到手动驾驶并停在 end */
  onDeparted(end: PathPose): void;
  toast(msg: string): void;
  lock: ModeLock;
}

export function homeFlow(d: HomeFlowDeps) {
  return {
    async variant(id: string): Promise<void> {
      const r = await d.act((s) => selectVariant(s, d.now(), id));
      if (!r) return;
      if (!r.ok) return d.toast(r.error!);
      // 出库可能已抢先按新车型重建并起步：车型没变就不再重建（避免把进行中的路线重置回家位）
      if (d.viewVariantId() !== d.state().variantId) d.rebuildPlayer();
    },

    /** 返回是否真的起步了（统计 drive_out 只算这种，Codex 审核 #66：开着车、自动出库中、提交等待中或长按 O 都不算） */
    async out(): Promise<boolean> {
      if (d.mode() !== 'parked' || d.lock.busy) return false;
      d.lock.busy = true;
      let r;
      try {
        // 路线在事务内按存档里的最新车型规划：排在未提交的换车之后也不会用旧车型路线（issue #12）
        r = await d.act((s) => departHome(s, d.now(), d.home, d.obstacles));
      } finally {
        d.lock.busy = false;
      }
      if (!r) return false; // 只读或写入失败：act 已提示
      // 车后被挡等：存档未变（仍停在家位），先把原因告诉玩家（GPT 审核 #14 第 2 条）
      if (!r.ok) {
        d.toast(r.error!);
        return false;
      }
      // 等待提交期间画面可能已按其他标签页的存档重建：只在画面仍停在家位、存档已离开家位时起步
      if (d.mode() !== 'parked' || d.state().player.parkedHome) return false;
      // 换车的画面重建可能还没跑到：先按路线所用车型重建玩家车，起点就是新车型的家位位姿
      if (d.viewVariantId() !== r.variantId) d.rebuildPlayer();
      const end = r.path[r.path.length - 1];
      d.setAwning(false);
      d.startAuto(r.path, () => d.onDeparted(end));
      return true;
    },
  };
}
