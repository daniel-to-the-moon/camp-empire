/**
 * 入口：把 src/shared 的纯逻辑接到场景与界面。
 * 时间：now() = 本机时间 + 开发快进偏移（?dev 面板）。M1 单机原型，存档在 IndexedDB（src/shared/save.ts）。
 */
import '../style.css';
import { CATALOG, findVariant } from '../data/models';
import { stallById, stallRect, staticShapes } from '../shared/camp';
import { DAILY_GIFT, ECONOMY, NPC, SIDE_AWNING } from '../shared/config';
import { pointInPoly, type Shape } from '../shared/geom2d';
import { resolveDrive, type Impact } from '../shared/collision';
import { displayGold } from '../shared/ledger';
import { bodyCenter, footprint, specOf, stepDrive, type DriveState, type Pose } from '../shared/kinematics';
import { feeCents, type CampEvent } from '../shared/npc';
import { parkedPose, planNpcArrival, planNpcDeparture, planParkIn, type PathPose } from '../shared/parking';
import { departHome, type DepartResult } from '../shared/depart';
import { hash32 } from '../shared/rng';
import { devCommand, freshGameAt, isDevEntry, resetSave } from '../shared/devgate';
import { IdbStore, requestWriter, sameVersion, SaveSlot, SaveSupersededError, serialQueue, type LocksLike } from '../shared/save';
import {
  arriveHome,
  awningOut,
  buyAwning,
  claimDailyGift,
  currentVariant,
  recordPose,
  selectVariant,
  setAwningWanted,
  type GameState,
} from '../shared/state';
import { guardAutoRoute, stepTraffic, type Agent } from '../shared/traffic';
import { PathRunner, playerObstacles } from './drive';
import { createCampScene, disposeTree, makeVehicle, placeVehicle, type VehicleView } from './scene';

/** IndexedDB 里的存档键 */
const SAVE_KEY = 'save.v2';
/** 上一版存在 localStorage 的存档键：首次启动时导入 IndexedDB 后删除 */
const LEGACY_SAVE_KEY = 'camp-empire.save.v2';
const DB_NAME = 'camp-empire';
const DEV_KEY = 'camp-empire.devOffsetMs';
const LOCK_NAME = 'camp-empire.writer';
const DEV = isDevEntry(location.search);

let devOffset = DEV ? Number(localStorage.getItem(DEV_KEY) ?? 0) || 0 : 0;
const now = () => Date.now() + devOffset;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

// ---------- 存档：IndexedDB 原子事务 + 单写者锁（见 src/shared/save.ts） ----------
const locks = (navigator as unknown as { locks?: LocksLike }).locks;
const store = typeof indexedDB === 'undefined' ? null : await IdbStore.open(indexedDB, DB_NAME).catch(() => null);
const slot = store ? new SaveSlot(store, SAVE_KEY) : null;
if (slot && (await slot.importIfEmpty(localStorage.getItem(LEGACY_SAVE_KEY)).catch(() => false))) localStorage.removeItem(LEGACY_SAVE_KEY);
const newSeed = () => hash32(`${Date.now()}:${Math.random()}`);
function clearDevOffset() {
  devOffset = 0;
  localStorage.removeItem(DEV_KEY);
}
/**
 * 没有存档时新开一局：按真实时间建局，并清掉残留的开发快进偏移（GPT 审核 #4 第 4 轮第 1 条）。
 * 否则偏移会让新局在 now() 下一开局就跳到“未来”，或在偏移清除后被防回拨逻辑冻结。
 */
function freshGame(): GameState {
  clearDevOffset();
  return freshGameAt(Date.now(), newSeed());
}
let state: GameState = (slot && (await slot.read().catch(() => null))) ?? freshGame();
/** 没有可靠的原子写入或单写者机制：整页只读，提示原因（GPT 审核 #4 第 2 轮第 1 条） */
const unsupported = !slot ? '这个浏览器打不开 IndexedDB（可能是隐私模式），无法可靠保存，本页只读。' : !locks ? '这个浏览器不支持 Web Locks，无法保证只有一个标签页写存档，本页只读。' : null;
/** 本标签页是否持有写权；拿到锁之前一律只读 */
let writer = false;
/** 同一标签页内的存档读写按顺序执行 */
const enqueue = serialQueue();

// ---------- 提示 ----------
let toastTimer = 0;
function toast(msg: string, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), ms);
}

function summarizeOffline(events: CampEvent[]): string | null {
  const departs = events.filter((e) => e.type === 'depart') as Extract<CampEvent, { type: 'depart' }>[];
  if (!departs.length) return null;
  const sum = departs.reduce((s, e) => s + e.amount, 0);
  return `你不在的时候，${departs.length} 位露营者停完离开，自动结算入账 ${displayGold(sum)} 金`;
}

// ---------- 场景 ----------
const view = createCampScene($('#stage'));
const home = stallById('home');

let spec = specOf(currentVariant(state));
let player: VehicleView = makeVehicle(currentVariant(state));
/** 画面玩家车（spec / player）对应的车型；与 state.variantId 不同说明换车后的画面重建还没执行 */
let playerVariantId = state.variantId;
view.scene.add(player.root);

type Mode = 'parked' | 'driving' | 'auto';
let mode: Mode = state.player.parkedHome ? 'parked' : 'driving';
let drive: DriveState = {
  pose: state.player.parkedHome || !state.player.pose ? parkedPose(spec, home) : state.player.pose,
  speed: 0,
  curvature: 0,
};
let autoRun: PathRunner | null = null;
let autoDone: (() => void) | null = null;
/** 自动驾驶途中停好的车变了时，从当前位姿重规划剩余路线；null = 不能重规划（被挡就交还手动） */
let autoReplan: ((from: Pose, parked: Shape[]) => PathPose[] | null) | null = null;
const AUTO_SPEED = 6;
/** 停好的 NPC 集合变了（到位、跳过、同步增删），自动驾驶需要重新验证剩余路线 */
let parkedDirty = false;
let overview = false;

function rebuildPlayer() {
  view.scene.remove(player.root);
  disposeTree(player.root);
  spec = specOf(currentVariant(state));
  player = makeVehicle(currentVariant(state));
  playerVariantId = state.variantId;
  view.scene.add(player.root);
  if (mode === 'parked') drive.pose = parkedPose(spec, home);
  placeVehicle(player.root, spec, drive.pose);
  player.setAwning(awningOut(state));
}
placeVehicle(player.root, spec, drive.pose);
player.setAwning(awningOut(state));

// ---------- NPC 车 ----------
/** NPC 车是交通参与者：入场时先在大门外排队（pending），行驶中与其他车互相让行（src/shared/traffic.ts） */
interface NpcCar extends Agent {
  parkingId: string;
  view: VehicleView;
}
const npcs = new Map<string, NpcCar>();
const leaving: NpcCar[] = [];
const TINTS = [0xe9e4d8, 0xc9d6df, 0xe8d3b0, 0xb7c9a8, 0xd9c2c2, 0xbfc4cf];

function npcCar(parkingId: string, variantId: string): NpcCar {
  const v = findVariant(variantId)!;
  const vv = makeVehicle(v, TINTS[hash32(parkingId) % TINTS.length]);
  view.scene.add(vv.root);
  return { id: parkingId, parkingId, view: vv, spec: specOf(v), runner: null, pose: { x: 0, y: 0, yaw: 0 }, pending: false, waited: 0 };
}

function removeCar(c: NpcCar) {
  view.scene.remove(c.view.root);
  disposeTree(c.view.root);
}

function clearNpcs() {
  for (const c of [...npcs.values(), ...leaving]) removeCar(c);
  npcs.clear();
  leaving.length = 0;
}

/**
 * NPC 车辆同步的唯一入口：先按事件播放离场 / 入场动画，再按权威状态 state.camp 逐车位补齐或移除。
 * 所有状态动作的事件都经 act() 走到这里，不会因为动作“消费”了事件而漏掉车辆或留下幽灵车。
 */
function syncNpcs(events: CampEvent[], animate: boolean) {
  parkedDirty = true; // 可能增删了停好的车（未播放动画时直接停在车位里）
  for (const e of events) {
    if (e.type !== 'depart') continue;
    const c = npcs.get(e.spotId);
    if (!c || c.parkingId !== e.stay.parkingId) continue;
    npcs.delete(e.spotId);
    // 还在入场途中就到点离开（只会发生在快进时）：直接移除，不从停好位姿“瞬移”起步
    const plan = animate && !c.runner ? planNpcDeparture(c.spec, stallById(e.spotId), staticShapes()) : null;
    if (plan?.ok) {
      c.runner = new PathRunner(plan.path, 5);
      c.skipTo = null;
      c.waited = 0;
      leaving.push(c);
    } else removeCar(c);
  }
  const arrivedNow = new Set(events.filter((e) => e.type === 'arrive').map((e) => e.stay.parkingId));
  for (const sp of state.camp.spots) {
    const cur = npcs.get(sp.id);
    if (cur && cur.parkingId !== sp.stay?.parkingId) {
      removeCar(cur);
      npcs.delete(sp.id);
    }
    if (sp.stay && !npcs.has(sp.id)) {
      const c = npcCar(sp.stay.parkingId, sp.stay.variantId);
      const stall = stallById(sp.id);
      const plan = animate && arrivedNow.has(sp.stay.parkingId) ? planNpcArrival(c.spec, stall, staticShapes()) : null;
      if (plan?.ok) {
        c.runner = new PathRunner(plan.path, 5);
        c.pose = plan.path[0];
        c.pending = true; // 在大门外排队，起点清空后才进场
        c.skipTo = parkedPose(c.spec, stall);
        c.view.root.visible = false;
      } else c.pose = parkedPose(c.spec, stall);
      placeVehicle(c.view.root, c.spec, c.pose);
      npcs.set(sp.id, c);
    }
  }
}

/** 停在车位里的 NPC 车身（规划玩家自动驾驶路线时的障碍）。行驶中的车不算：它们由 stepTraffic 逐帧让行 */
function parkedNpcShapes(): Shape[] {
  return [...npcs.values()].filter((c) => !c.runner && !c.pending).map((c) => ({ type: 'poly', pts: footprint(c.spec, c.pose), tag: 'npc' }));
}

/** 正在行驶（已进场）的 NPC 车身：玩家手动驾驶时的动态障碍 */
function movingNpcShapes(): Shape[] {
  const out: Shape[] = [];
  for (const c of [...npcs.values(), ...leaving]) {
    if (c.runner && !c.pending) out.push({ type: 'poly', pts: footprint(c.spec, c.pose), tag: 'npc' });
  }
  return out;
}

function announce(events: CampEvent[]) {
  for (const e of events) {
    if (e.type === 'depart' && e.amount > 0) toast(`${stallById(e.spotId).label}的露营者停了 ${fmtDur(e.minutes)}，付你 ${displayGold(e.amount)} 金`);
    if (e.type === 'arrive') toast(`一位露营者开进了${stallById(e.spotId).label}`);
  }
}

const READONLY_MSG = '本页只读：这个存档正在另一个标签页里玩';

/**
 * 所有状态动作的唯一入口：排进本页队列，在 IndexedDB 原子事务里执行（读最新存档 → 动作 → 写回），
 * 提交成功后才采纳新状态，再把动作回放出的 NPC 事件交给 syncNpcs。只读标签页拒绝执行；写入失败时内存状态不变。
 */
function act<R extends { events: CampEvent[] }>(fn: (s: GameState) => R, opts: { animate?: boolean; announce?: boolean } = {}): Promise<R | null> {
  return enqueue(async () => {
    if (!writer || !slot) {
      toast(unsupported ?? READONLY_MSG);
      return null;
    }
    let tx;
    try {
      tx = await slot.transact(state, fn);
    } catch (e) {
      if (e instanceof SaveSupersededError) {
        // 存档已换成另一局（其他标签页重开）或被删除：这次动作针对的是旧局，不重做；画面切到存档里的那一局
        adoptState(e.latest ?? freshGame());
        toast(`${e.message}，这次操作没有生效`);
        return null;
      }
      console.error(e);
      toast('存档写入失败，这次操作没有生效');
      return null;
    }
    state = tx.state;
    if (tx.resynced) resyncView(); // 其他标签页写过：画面按最新存档整体重建
    else syncNpcs(tx.result.events, opts.animate ?? true);
    if (opts.announce ?? true) announce(tx.result.events);
    renderHud();
    return tx.result;
  });
}

/** 按权威状态整体重建画面（玩家车 + 全部 NPC），用于采纳其他标签页写入的存档 */
function resyncView() {
  autoRun = null;
  autoDone = null;
  autoReplan = null;
  mode = state.player.parkedHome ? 'parked' : 'driving';
  const s = specOf(currentVariant(state));
  drive = { pose: state.player.parkedHome || !state.player.pose ? parkedPose(s, home) : state.player.pose, speed: 0, curvature: 0 };
  rebuildPlayer();
  clearNpcs();
  syncNpcs([], false);
}

/** 以存档为准刷新（排在本页队列里，不与正在进行的事务交错） */
function adoptLatest(): Promise<void> {
  return enqueue(async () => {
    if (!slot) return;
    const latest = await slot.read().catch(() => null);
    // 同时比较局标识与修订号：重开后新局的修订号可能与旧局相同（GPT 审核 #4 第 3 轮第 1 条）
    if (latest && !sameVersion(latest, state)) adoptState(latest);
  });
}

/** 采纳另一份权威状态（其他标签页写入或重开的存档），整体重建画面 */
function adoptState(s: GameState) {
  state = s;
  resyncView();
  renderHud();
}

/** 拿到写权后：离线回放 + 每日礼物 */
async function startSession() {
  const r = await act((s) => claimDailyGift(s, now()), { animate: false, announce: false });
  if (!r) return;
  const parts = [summarizeOffline(r.events), r.gift ? `营地管理员巡视送来 ${r.gift.gold} 金（每日首次登录）` : null].filter(Boolean);
  if (parts.length) toast(parts.join('；'), 6000);
}

function setWriter(w: boolean) {
  const was = writer;
  writer = w;
  $('#readonly').hidden = w;
  if (w !== was) void adoptLatest(); // 交接写权时都以存档为准
  if (w && !was) void startSession();
  renderHud();
}

// ---------- 操作 ----------
/** 改变玩家车模式的动作（出发 / 停回家位）正在等存档提交：期间不重复触发 */
let modeBusy = false;

const actions: Record<string, (arg: string) => void | Promise<void>> = {
  async variant(id) {
    const r = await act((s) => selectVariant(s, now(), id));
    if (!r) return;
    if (!r.ok) return toast(r.error!);
    // 出库可能已抢先按新车型重建并起步：车型没变就不再重建（避免打断进行中的路线显示）
    if (playerVariantId !== state.variantId) rebuildPlayer();
  },
  async buy() {
    const r = await act((s) => buyAwning(s, now()));
    if (!r) return;
    if (!r.ok) return toast(r.error!);
    player.setAwning(awningOut(state));
    toast('买到侧边帐！停在家位时会自动展开，露营者来得更勤');
  },
  async awning() {
    if (!(await act((s) => setAwningWanted(s, now(), !s.awningWanted)))) return;
    player.setAwning(awningOut(state));
  },
  async out() {
    if (mode !== 'parked' || modeBusy) return;
    modeBusy = true;
    let r: DepartResult | null;
    try {
      // 路线在事务内按存档里的最新车型规划：排在未提交的换车之后也不会用旧车型路线（issue #12）
      r = await act((s) => departHome(s, now(), home, () => [...staticShapes(), ...parkedNpcShapes()]));
      // 等待提交期间画面可能已按其他标签页的存档重建：只在仍停在家位时起步
      if (!r || mode !== 'parked' || state.player.parkedHome) return;
    } finally {
      modeBusy = false;
    }
    if (!r.ok) return toast(r.error!);
    // 换车的画面重建可能还没跑到：先按路线所用车型重建玩家车，起点就是新车型的家位位姿
    if (playerVariantId !== r.variantId) rebuildPlayer();
    const end = r.path[r.path.length - 1];
    player.setAwning(false);
    startAuto(r.path, () => {
      mode = 'driving';
      drive = { pose: { x: end.x, y: end.y, yaw: end.yaw }, speed: 0, curvature: 0 };
    });
  },
  park() {
    if (mode !== 'driving' || modeBusy) return;
    if (!writer) return toast(unsupported ?? READONLY_MSG);
    const plan = planParkIn(spec, drive.pose, home, [...staticShapes(), ...parkedNpcShapes()]);
    if (!plan.ok) return toast(plan.reason!);
    startAuto(
      plan.path,
      () => {
        mode = 'driving'; // 提交失败时停在家位前，可继续手动驾驶
        void settleHome();
      },
      (from, parkedNow) => {
        const p = planParkIn(spec, from, home, [...staticShapes(), ...parkedNow]);
        return p.ok ? p.path : null;
      },
    );
  },
  overview() {
    overview = !overview;
  },
  takeover() {
    if (unsupported) return toast(unsupported);
    requestWriter(locks, LOCK_NAME, true, setWriter);
  },
  async dev(arg) {
    // 普通入口不能执行快进 / 重开存档（GPT 审核 #4 第 2 轮第 2 条）
    const cmd = devCommand(DEV, writer, arg);
    if (cmd.kind === 'denied') return toast(cmd.reason);
    if (cmd.kind === 'reset') {
      await enqueue(async () => {
        if (!slot) return;
        try {
          // 一个事务整份换成按真实时间新建的局（新 sid），旧局的标签页之后的写入都会被拒绝；
          // 存档替换成功后才清除快进偏移，重载后的时间基准与建局时一致（GPT 审核 #4 第 4 轮第 1 条）
          await resetSave({
            realNowMs: Date.now(),
            seed: newSeed(),
            replace: (fresh) => slot.reset(fresh),
            clearDevState: () => {
              localStorage.removeItem(LEGACY_SAVE_KEY);
              clearDevOffset();
            },
          });
        } catch (e) {
          console.error(e);
          toast('重开存档失败，存档和快进偏移都没有变');
          return;
        }
        location.reload();
      });
      return;
    }
    devOffset += cmd.ms;
    localStorage.setItem(DEV_KEY, String(devOffset));
    const r = await act((s) => claimDailyGift(s, now()), { animate: false, announce: false });
    if (!r) return;
    toast([summarizeOffline(r.events) ?? '快进期间没有露营者离开', r.gift ? `管理员送来 ${r.gift.gold} 金` : null].filter(Boolean).join('；'));
  },
};

function startAuto(path: PathPose[], done: () => void, replan: typeof autoReplan = null) {
  mode = 'auto';
  autoRun = new PathRunner(path, AUTO_SPEED);
  autoDone = done;
  autoReplan = replan;
  playerAgent.waited = 0;
}

async function settleHome() {
  if (modeBusy) return;
  modeBusy = true;
  const from = mode;
  try {
    const r = await act((s) => arriveHome(s, now()));
    // 提交失败，或等待期间画面已按其他标签页的存档重建：不改模式
    if (!r || mode !== from || !state.player.parkedHome) return;
  } finally {
    modeBusy = false;
  }
  mode = 'parked';
  drive = { pose: parkedPose(spec, home), speed: 0, curvature: 0 };
  placeVehicle(player.root, spec, drive.pose);
  player.setAwning(awningOut(state));
  toast('已停回家位');
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  renderHud();
  void Promise.resolve(actions[el.dataset.act!]?.(el.dataset.arg ?? '')).finally(renderHud);
});

// ---------- 键盘 ----------
const keys = new Set<string>();
const DRIVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
window.addEventListener('keydown', (e) => {
  if (DRIVE_KEYS.includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyC') actions.overview('');
  if (e.code === 'KeyP') void actions.park('');
  if (e.code === 'KeyO') void Promise.resolve(actions.out('')).finally(renderHud);
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const k = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);

// ---------- 主循环 ----------
const obstacles = playerObstacles();
let lastTick = 0;
let lastSave = 0;
let lastSettleTry = 0;
/** 上一次每秒结算 / 跟随刷新还没完成时不再排新的 */
let ticking = false;
let bumpUntil = 0;
let lastDust = 0;
const HIT_NAMES: Record<string, string> = { island: '篝火岛路缘', fence: '围栏', tree: '树', npc: '露营者的车', gate: '大门拦杆' };

/** 碰撞反馈：烟尘 + 震屏 + 提示。擦边持续接触时限频，避免每帧都喷 */
function onImpact(hit: Impact, t: number) {
  const hard = hit.strength;
  if (hard < 0.15) return;
  if (hard > 0.8 || t - lastDust > 140) {
    view.dust(hit.point, hit.n, hard);
    lastDust = t;
  }
  view.shake(Math.min(1, hard / 4));
  if (hard > 0.6) {
    const what = HIT_NAMES[hit.tag] ?? (hit.tag.startsWith('p') || hit.tag === 'love' ? '出租车位' : '障碍物');
    $('#bump').textContent = `${hard > 3 ? '砰！' : '咚'} 撞到${what}（${(hard * 3.6).toFixed(0)} km/h）`;
    bumpUntil = t + 900;
  }
}
let prev = performance.now();
/** 时间倍率：只有 ?dev 调试入口会改（冻结画面截图用） */
let timeScale = 1;

/** 玩家车作为交通参与者：手动驾驶时静止（位姿由物理更新），自动驾驶时沿路径走并让行；从不跳过 */
const playerAgent: Agent = { id: 'player', spec, pose: drive.pose, runner: null, pending: false, waited: 0, avoidParked: true };

function frame(t: number) {
  // 先排下一帧：本帧逻辑即使抛异常，主循环也不会停
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - prev) / 1000) * timeScale;
  prev = t;

  // 停回家位正在提交时冻结手动输入，避免提交后位姿跳变
  if (mode === 'driving' && writer && !modeBusy) {
    let throttle = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
    if (keys.has('Space')) throttle = drive.speed > 0 ? -1 : drive.speed < 0 ? 1 : 0;
    const steer = k('KeyA', 'ArrowLeft') - k('KeyD', 'ArrowRight');
    const next = stepDrive(spec, drive, { throttle, steer }, dt);
    const r = resolveDrive(spec, drive, next, [...obstacles, ...movingNpcShapes()]);
    drive = r.state;
    if (r.impact) onImpact(r.impact, t);
    // 手动停进家位：车停稳且四角都在家位里
    if (t - lastSettleTry > 1000 && Math.abs(drive.speed) < 0.05 && footprint(spec, drive.pose).every((p) => pointInPoly(p, stallRect(home)))) {
      lastSettleTry = t; // 提交失败时限频重试
      void settleHome();
    }
    if (t - lastSave > 2000 && mode === 'driving') {
      lastSave = t;
      const pose = { ...drive.pose };
      void act((s) => recordPose(s, now(), pose));
    }
  }

  // 交通：玩家车（不在家位时）+ 行驶 / 排队中的 NPC，按顺序让行（玩家优先）
  const traffic: Agent[] = [];
  if (mode !== 'parked') {
    playerAgent.spec = spec;
    if (mode === 'auto' && autoRun) {
      playerAgent.runner = autoRun;
      playerAgent.pose = autoRun.current;
    } else {
      playerAgent.runner = null;
      playerAgent.pose = drive.pose;
    }
    traffic.push(playerAgent);
  }
  // 停好的 NPC 以 parked 身份参与：只挡玩家自动驾驶（GPT 审核 #4 第 3 轮第 2 条）
  for (const c of [...npcs.values(), ...leaving]) {
    c.parked = !c.runner && !c.pending;
    if (c.runner || c.parked) traffic.push(c);
  }
  const step = stepTraffic(traffic, dt);
  if ([...step.finished, ...step.skipped].some((a) => a !== playerAgent)) parkedDirty = true;

  if (mode === 'auto' && autoRun) {
    // 停好的车变了（NPC 刚停好、跳过动画、存档重建）：重新验证剩余路线，被挡则重规划，规划不了或被挡太久就交还手动
    const parkedNow = [...npcs.values()].filter((c) => !c.runner && !c.pending); // 含本帧刚停好 / 跳过到位的车
    const g = guardAutoRoute(playerAgent, parkedNow, parkedDirty, autoReplan ?? (() => null), AUTO_SPEED);
    if (g.kind === 'replanned') autoRun = playerAgent.runner;
    else if (g.kind === 'abort') {
      autoRun = null;
      autoDone = null;
      autoReplan = null;
      mode = 'driving';
      drive = { pose: { ...playerAgent.pose }, speed: 0, curvature: 0 };
      toast(`${g.reason}，已切回手动驾驶`);
    }
  }
  parkedDirty = false;

  if (mode === 'auto' && autoRun) {
    drive = { pose: playerAgent.pose, speed: 0, curvature: 0 };
    if (step.finished.includes(playerAgent)) {
      autoRun = null;
      autoReplan = null;
      const d = autoDone;
      autoDone = null;
      d?.();
    }
  }
  placeVehicle(player.root, spec, drive.pose);

  for (const a of traffic) {
    if (a === playerAgent) continue;
    const c = a as NpcCar;
    const i = leaving.indexOf(c);
    if (i >= 0 && !c.runner) {
      // 离场走完或超时跳过：移除
      leaving.splice(i, 1);
      removeCar(c);
      continue;
    }
    c.view.root.visible = !c.pending;
    placeVehicle(c.view.root, c.spec, c.pose);
  }

  if (t - lastTick > 1000) {
    lastTick = t;
    if (!ticking) {
      ticking = true;
      // 写者回放 + 结算；只读页不回放、不写存档，每秒从存档跟随刷新
      const job = writer
        ? act((s) => claimDailyGift(s, now())).then((r) => {
            if (r?.gift) toast(`新的一天！营地管理员巡视送来 ${r.gift.gold} 金`);
          })
        : adoptLatest();
      void job.finally(() => (ticking = false));
    }
    renderHud();
  }

  const [cx, cy] = bodyCenter(spec, drive.pose);
  view.follow({ x: cx, y: cy, yaw: drive.pose.yaw, h: spec.lengthM / 4 }, overview || mode === 'parked');
  $('#bump').hidden = t > bumpUntil;
  $('#speed').textContent = `${Math.abs(drive.speed * 3.6).toFixed(0)} km/h${drive.speed < -0.05 ? ' 倒车' : ''}`;
  view.render(dt);
}

// ---------- 界面 ----------
const fmtDur = (min: number) => `${Math.floor(min / 60)} 小时 ${String(min % 60).padStart(2, '0')} 分`;
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });

function renderHud() {
  const v = currentVariant(state);
  const t = now();
  $('#coins').textContent = displayGold(state.ledger.balance).toLocaleString('zh-CN');
  $('#clock').textContent = `上海 ${clock(t)}${devOffset ? ' · 已快进' : ''}`;

  const parkedHome = mode === 'parked';
  $('#garage').innerHTML = `
    <h2>车库</h2>
    <p class="hint">${parkedHome ? '选一辆你的车（尺寸为公告三围，占位外观）' : '停回家位后才能换车'}</p>
    <ul class="models">${CATALOG.map(
      (m) => `<li>
        <div class="model-name">${m.model}<span>${m.variants[0].lengthM.toFixed(2)} × ${m.variants[0].widthM.toFixed(2)} m</span></div>
        <div class="chips">${m.variants
          .map((x) => `<button class="chip ${x.id === v.id ? 'on' : ''}" data-act="variant" data-arg="${x.id}" ${parkedHome ? '' : 'disabled'}>${x.roofLabel}</button>`)
          .join('')}</div></li>`,
    ).join('')}</ul>`;

  const out = awningOut(state);
  $('#shop').innerHTML = `
    <h2>营地小卖部</h2>
    <div class="card">
      <div class="row"><b>侧边帐</b><span class="coin">${SIDE_AWNING.priceGold}</span></div>
      <p>装在车身右侧（滑门侧），外伸 ${SIDE_AWNING.depthM} m。停在家位并展开时，露营者平均等待时间 ×${NPC.awningGapFactor}（来得更勤）。</p>
      ${
        state.awningOwned
          ? `<button data-act="awning">${state.awningWanted ? '收起侧边帐' : '展开侧边帐'}</button>
             <p class="fine">${out ? '已展开，正在吸引露营者' : state.awningWanted ? '车不在家位，开回去自动展开' : '已收起'}</p>`
          : `<button data-act="buy" ${state.ledger.balance < SIDE_AWNING.priceGold * 100 ? 'disabled' : ''}>购买</button>`
      }
    </div>`;

  $('#spots').innerHTML = `
    <h2>我的营地车位</h2>
    <p class="hint">露营者自己开来、自己离开，离开时自动付费：${NPC.rateCentsPerHour / 100} 金 / 小时，单次最多 ${NPC.capMinutes / 60} 小时。爱心车位免费给露营者停。</p>
    ${state.camp.spots
      .map((sp) => {
        const label = stallById(sp.id).label;
        if (!sp.stay) return `<div class="spot empty"><b>${label}</b><span>空位 · 等露营者</span></div>`;
        const done = Math.floor((t - sp.stay.arriveMs) / 60000);
        const total = Math.round((sp.stay.departMs - sp.stay.arriveMs) / 60000);
        const pay = sp.kind === 'love' ? '公益停靠' : `离开时付 ${displayGold(feeCents(total))} 金`;
        return `<div class="spot"><b>${label}</b><span>${sp.stay.variantId.replace('_', ' · ')} mm</span>
          <div class="bar"><i style="width:${Math.min(100, (done / total) * 100).toFixed(1)}%"></i></div>
          <span class="sub">已停 ${fmtDur(Math.max(0, done))} / 共 ${fmtDur(total)} · ${pay}</span></div>`;
      })
      .join('')}
    <p class="fine">爱心车位累计公益停靠 ${fmtDur(state.camp.loveMinutes)}</p>`;

  const today = state.ledger.today;
  $('#daily').innerHTML = `
    <h2>每日</h2>
    <p class="hint">每天首次登录，营地管理员巡视送礼：${DAILY_GIFT.map((g) => `${g.gold} 金 ${Math.round(g.p * 100)}%`).join(' / ')}（期望 ${DAILY_GIFT.reduce((s, g) => s + g.gold * g.p, 0)} 金）。日界为上海时间 0 点。</p>
    <p class="fine">今日已入账 ${displayGold(today.issued)} 金；当日收入超过 ${ECONOMY.softCapThresholdGold} 金的部分按 ${ECONOMY.softCapRateAbove * 100}% 发放。</p>`;

  $('#log').innerHTML = state.ledger.entries
    .slice(-6)
    .reverse()
    .map((e) => {
      const capped = e.amount !== e.gross ? `（软上限后，毛收入 ${displayGold(e.gross)}）` : '';
      const where = e.kind === 'npc_parking' ? `${stallById(e.key.split('#')[0]).label} · ` : '';
      return `<li><span class="when">${clock(e.atMs)}</span>${where}${e.note}<b class="${e.amount < 0 ? 'neg' : ''}">${e.amount >= 0 ? '+' : ''}${displayGold(e.amount)}</b>${capped}</li>`;
    })
    .join('');

  $('#controls').innerHTML =
    mode === 'parked'
      ? `<button class="primary" data-act="out">开出去兜一圈 <kbd>O</kbd></button>`
      : mode === 'driving'
        ? `<button class="primary" data-act="park">自动泊回家位 <kbd>P</kbd></button><span class="keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 驾驶 · <kbd>空格</kbd> 刹车 · <kbd>C</kbd> 俯瞰</span>`
        : `<span class="keys">自动驾驶中…</span>`;
}

if (DEV) {
  $('#dev').hidden = false;
  // 调试入口（仅 ?dev）：在车头前方模拟一次撞击，用于检查烟尘 / 震屏 / 提示
  (window as unknown as { __campDebug: unknown }).__campDebug = {
    setTimeScale(v: number) {
      timeScale = v;
    },
    /** 当前可见的烟尘粒子数（不透明度 > 0.05） */
    dustVisible() {
      let n = 0;
      view.scene.traverse((o) => {
        const sp = o as import('three').Sprite;
        if (sp.isSprite && sp.visible && sp.material.map && sp.material.opacity > 0.05 && sp.material.depthTest) n++; // 标牌精灵 depthTest = false，不计入
      });
      return n;
    },
    impact(strength: number, tag = 'island', at: 'front' | 'rear' = 'front') {
      const p = drive.pose;
      const sign = at === 'front' ? 1 : -1;
      const f = at === 'front' ? spec.wheelbaseM + spec.frontOverhangM : spec.rearOverhangM;
      const point: [number, number] = [p.x + sign * f * Math.cos(p.yaw), p.y + sign * f * Math.sin(p.yaw)];
      onImpact({ point, n: [-sign * Math.cos(p.yaw), -sign * Math.sin(p.yaw)], strength, tag }, performance.now());
    },
  };
}
syncNpcs([], false); // 先按存档摆好车；拿到写权后再回放离线时间
renderHud();
if (unsupported) {
  // 没有可靠的写入机制：整页只读，说明原因；没有“在这里玩”按钮
  $('#readonly-msg').textContent = unsupported;
  $('#readonly button').hidden = true;
  setWriter(false);
} else requestWriter(locks, LOCK_NAME, false, setWriter);
requestAnimationFrame(frame);
