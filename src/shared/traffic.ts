/**
 * 动态车辆让行（GPT 审核 #4 第 3 条）：NPC 与 NPC、NPC 与玩家（手动驾驶 / 自动驾驶）之间不穿模。
 *
 * 路线规划（parking.ts）只保证不碰静态障碍和停在车位里的车；行驶中的车辆之间由这里逐帧仲裁：
 * - 入口排队：新到的 NPC 先在大门外排队（不可见、不算障碍），起点位姿清空后才进场；
 *   同一分钟到达的两辆车因此先后进场，不会在 GATE_IN 重叠生成。
 * - 让行：每辆沿路径行驶的车，每帧先试算下一位姿；外扩 YIELD_PAD 后与任何其他参与者的当前车身重叠就原地等待。
 *   跟车时后车让前车，前车不受影响。
 * - 解锁：互相挡住（如倒出车位的车与环路上的车）时，NPC 连续等待超过 SKIP_AFTER_S 秒即“跳过动画”：
 *   入场车直接停进车位（只在车位里的停好位姿无重叠时才跳），离场车直接驶离（移除）。
 *   玩家车从不跳过，只等待；挡住玩家的 NPC 要么在走、要么超时跳过，所以玩家不会永久卡住。
 * 参与者由调用方决定：行驶中 / 排队中的 NPC，以及不在家位停好的玩家车。
 * 停在车位里的车以 parked 身份参与，只对玩家自动驾驶（avoidParked）构成障碍、不外扩：NPC 路线规划已按不外扩
 * 避开它们，再加外扩会误判；玩家自动驾驶的路线只避开了规划那一刻停着的车，途中新停好的车由这里兜底，
 * 并由 guardAutoRoute 重新验证 / 重规划剩余路线（GPT 审核 #4 第 3 轮第 2 条）。
 */
import { polysOverlap, type Shape } from './geom2d';
import { footprint, type Pose, type VehicleSpec } from './kinematics';
import { pathCollides, type PathPose } from './parking';

/** 让行判定的车身外扩 0.3 m（提案，待试玩调整） */
export const YIELD_PAD = 0.3;
/**
 * 前瞻距离：不只看下一帧位姿，还看沿路径再往前 LOOKAHEAD_M 米内的位姿，即跟车间距约 2 m（提案）。
 * 原因：前车拐进车位时车身绕后轴转动，车尾会向后外摆；只看下一帧时后车贴得过近（约 0.3 m），
 * 前车下一步就会碰到后车，两车互相等待直到超时（tests/traffic.test.ts 的同分钟到达用例复现过）。
 */
export const LOOKAHEAD_M = 2;
const LOOKAHEAD_STEP_M = 0.5;
/**
 * NPC 互相卡住多久后跳过动画（提案）。推演：NPC 车速 5 m/s，最长车约 6 m，倒车段半速 2.5 m/s，
 * 正常让行等待 ≈ 前车驶过一个车长加间隙 ≈ (6 + 0.3) / 2.5 ≈ 2.5 s；取约 3 倍，正常让行不会被误判为死锁。
 */
export const SKIP_AFTER_S = 8;

export class PathRunner {
  private cum: number[] = [0];
  private s = 0;
  readonly total: number;
  constructor(
    readonly path: PathPose[],
    private speed = 4,
  ) {
    for (let i = 1; i < path.length; i++) {
      this.cum.push(this.cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y));
    }
    this.total = this.cum[this.cum.length - 1];
  }
  get done(): boolean {
    return this.s >= this.total;
  }
  /** 试算前进 dt 后的位姿，不改变进度 */
  peek(dt: number): PathPose {
    return this.at(this.advance(dt));
  }
  /** 前进 dt，返回当前位姿（倒车段速度减半） */
  step(dt: number): PathPose {
    this.s = this.advance(dt);
    return this.at(this.s);
  }
  get current(): PathPose {
    return this.at(this.s);
  }
  /** 剩余里程（米） */
  get remaining(): number {
    return this.total - this.s;
  }
  /** 剩余路线：当前位姿 + 之后的全部路径点 */
  remainingPath(): PathPose[] {
    return [this.current, ...this.path.filter((_, i) => this.cum[i] > this.s)];
  }
  /** 从当前进度再往前 d 米处的位姿（不超过终点），不改变进度 */
  ahead(d: number): PathPose {
    return this.at(Math.min(this.total, this.s + d));
  }
  private advance(dt: number): number {
    const cur = this.at(this.s);
    return Math.min(this.total, this.s + dt * this.speed * (cur.dir < 0 ? 0.5 : 1));
  }
  private at(s: number): PathPose {
    let lo = 0;
    let hi = this.cum.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    const a = this.path[lo];
    const b = this.path[hi];
    const seg = this.cum[hi] - this.cum[lo];
    const t = seg > 0 ? (s - this.cum[lo]) / seg : 0;
    const dy = Math.atan2(Math.sin(b.yaw - a.yaw), Math.cos(b.yaw - a.yaw));
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, yaw: a.yaw + dy * t, dir: b.dir };
  }
}

export interface Agent {
  id: string;
  spec: VehicleSpec;
  pose: Pose;
  /** 沿路径行驶；null = 静止参与者（如手动驾驶中的玩家车，位姿由调用方每帧更新） */
  runner: PathRunner | null;
  /** 在大门外排队：不可见、不算障碍 */
  pending: boolean;
  /** 连续被挡的秒数 */
  waited: number;
  /** 超时跳过：入场 NPC = 停好位姿；离场 NPC = null（直接移除）；undefined = 不能跳过（玩家） */
  skipTo?: Pose | null;
  /** 停在车位里的车：只对 avoidParked 的参与者构成障碍，且不外扩（NPC 路线规划已按不外扩避开它们） */
  parked?: boolean;
  /** 也要避让停好的车（玩家自动驾驶：路线只避开了规划那一刻停着的车，GPT 审核 #4 第 3 轮第 2 条） */
  avoidParked?: boolean;
}

export interface TrafficStep {
  /** 本帧走完路径的参与者 */
  finished: Agent[];
  /** 本帧跳过动画的参与者（skipTo 为位姿时已瞬移到位并停下；为 null 时调用方应移除） */
  skipped: Agent[];
}

/** 与他车重叠：行驶中的车按 pad 外扩判定，停好的车不外扩 */
function overlapsAny(spec: VehicleSpec, pose: Pose, pad: number, others: Agent[]): boolean {
  let padded: ReturnType<typeof footprint> | null = null;
  let bare: ReturnType<typeof footprint> | null = null;
  return others.some((o) => {
    const me = o.parked ? (bare ??= footprint(spec, pose)) : (padded ??= footprint(spec, pose, pad));
    return polysOverlap(me, footprint(o.spec, o.pose));
  });
}

/** 下一位姿以及前方 LOOKAHEAD_M 米内的路径位姿都不与他车重叠 */
function clearAhead(a: Agent, runner: PathRunner, next: Pose, others: Agent[]): boolean {
  if (overlapsAny(a.spec, next, YIELD_PAD, others)) return false;
  for (let d = LOOKAHEAD_STEP_M; d <= LOOKAHEAD_M; d += LOOKAHEAD_STEP_M) {
    if (overlapsAny(a.spec, runner.ahead(d), YIELD_PAD, others)) return false;
  }
  return true;
}

/**
 * 推进一帧。agents 的顺序即优先级（先处理的先走）。会就地修改 agent 的 pose / pending / waited / runner。
 */
export function stepTraffic(agents: Agent[], dt: number): TrafficStep {
  const finished: Agent[] = [];
  const skipped: Agent[] = [];
  const gone = new Set<Agent>();
  const othersOf = (a: Agent) => agents.filter((o) => o !== a && !o.pending && !gone.has(o) && (!o.parked || a.avoidParked));

  for (const a of agents) {
    if (!a.runner) continue;
    const others = othersOf(a);
    let blocked: boolean;
    if (a.pending) {
      blocked = !clearAhead(a, a.runner, a.pose, others);
      if (!blocked) a.pending = false;
    } else {
      blocked = !clearAhead(a, a.runner, a.runner.peek(dt), others);
      if (!blocked) a.pose = a.runner.step(dt);
    }
    if (!blocked) {
      a.waited = 0;
      if (a.runner.done) {
        a.runner = null;
        finished.push(a);
      }
      continue;
    }
    a.waited += dt;
    if (a.skipTo === undefined || a.waited < SKIP_AFTER_S) continue;
    if (a.skipTo === null) {
      gone.add(a);
      a.runner = null;
      skipped.push(a);
    } else if (!overlapsAny(a.spec, a.skipTo, 0, others)) {
      a.pose = a.skipTo;
      a.pending = false;
      a.runner = null;
      a.waited = 0;
      skipped.push(a);
    }
  }
  return { finished, skipped };
}

/**
 * 玩家自动驾驶被挡多久后放弃、交还手动驾驶（提案）。挡路的 NPC 最迟 SKIP_AFTER_S 秒后跳过动画让开，
 * 取其 2 倍：正常让行不会触发；只有被停好的车或玩家看不见的原因长期挡住时才放弃，避免永久“自动驾驶中”。
 */
export const PLAYER_GIVE_UP_S = 2 * SKIP_AFTER_S;

export type AutoGuard = { kind: 'keep' } | { kind: 'replanned' } | { kind: 'abort'; reason: string };

/**
 * 玩家自动驾驶的路线守护（GPT 审核 #4 第 3 轮第 2 条）。每帧 stepTraffic 之后调用：
 * - parkedChanged：本帧有车停好 / 跳过动画停进车位 / 被移除等，停好的车集合变了。此时检查剩余路线
 *   是否碰到停好的车；碰到就从当前位姿重规划（replan 返回 null 或新路线仍碰撞则放弃）。
 * - 被挡超过 PLAYER_GIVE_UP_S：放弃自动驾驶。
 * 放弃时把 player.runner 置空，调用方切回手动驾驶（玩家车停在原地，当前位姿已保证不与任何车重叠）。
 */
export function guardAutoRoute(
  player: Agent,
  parked: Agent[],
  parkedChanged: boolean,
  replan: (from: Pose, obstacles: Shape[]) => PathPose[] | null,
  speed: number,
): AutoGuard {
  const runner = player.runner;
  if (!runner) return { kind: 'keep' };
  if (player.waited >= PLAYER_GIVE_UP_S) {
    player.runner = null;
    return { kind: 'abort', reason: '自动驾驶被挡住太久' };
  }
  if (!parkedChanged) return { kind: 'keep' };
  const shapes: Shape[] = parked.map((o) => ({ type: 'poly', pts: footprint(o.spec, o.pose), tag: o.id }));
  if (!pathCollides(player.spec, runner.remainingPath(), shapes)) return { kind: 'keep' };
  const from = runner.current;
  const path = replan({ x: from.x, y: from.y, yaw: from.yaw }, shapes);
  if (path && path.length > 1 && !pathCollides(player.spec, path, shapes)) {
    player.runner = new PathRunner(path, speed);
    player.waited = 0;
    return { kind: 'replanned' };
  }
  player.runner = null;
  return { kind: 'abort', reason: '刚停好的露营者挡住了路线' };
}

/** 检查用：所有可见参与者两两之间（不外扩）是否有车身重叠 */
export function anyOverlap(agents: Agent[]): [Agent, Agent] | null {
  const vis = agents.filter((a) => !a.pending);
  for (let i = 0; i < vis.length; i++) {
    for (let j = i + 1; j < vis.length; j++) {
      if (polysOverlap(footprint(vis[i].spec, vis[i].pose), footprint(vis[j].spec, vis[j].pose))) return [vis[i], vis[j]];
    }
  }
  return null;
}
