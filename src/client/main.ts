/**
 * 入口：把 src/shared 的纯逻辑接到场景与界面。
 * 时间：now() = 本机时间 + 当前这一局的开发快进偏移（?dev 面板；偏移与局标识绑定，见 DevClock）。M1 单机原型，存档在 IndexedDB（src/shared/save.ts）。
 */
import '../style.css';
import { CATALOG, findVariant } from '../data/models';
import { stallById, stallRect, staticShapes } from '../shared/camp';
import { ECONOMY, FRAME_MAX_DT_S, NPC, PENDING, SIDE_AWNING } from '../shared/config';
import { camFor, hoodMount, OrbitGesture, orbitBehind, smoothOrbit, VIEWS, ViewChoice, viewForKey, wheelZoom, type Orbit, type View } from '../shared/camview';
import { BlinkClock, lightsFor, manualBraking } from '../shared/lights';
import { runningLights } from '../shared/runningLights';
import type { LampState } from '../geometry/placeholder';
import { pointInPoly, type Shape } from '../shared/geom2d';
import { resolveDrive, type Impact } from '../shared/collision';
import { displayGold } from '../shared/ledger';
import { bodyCenter, footprint, specOf, stepDrive, type DriveState, type Pose } from '../shared/kinematics';
import { feeCents, type CampEvent } from '../shared/npc';
import { parkedPose, planNpcArrival, planNpcDeparture, planParkIn, type PathPose } from '../shared/parking';
import { hash32 } from '../shared/rng';
import { devCommand, DevClock, freshGameAt, isDevEntry, resetSave } from '../shared/devgate';
import { IdbStore, legacyMayBeHidden, migrateSave, requestWriter, SAVE_KEY, sameVersion, SaveSlot, SaveSupersededError, serialQueue, type LocksLike } from '../shared/save';
import {
  arriveHome,
  awningOut,
  buyAwning,
  claimDailyGift,
  collectPending,
  currentVariant,
  giftStreakView,
  recordPose,
  setAwningWanted,
  type DailyGift,
  type GameState,
} from '../shared/state';
import { LADDER, ladderMeanGold } from '../shared/streak';
import { guardAutoRoute, stepTraffic, type Agent } from '../shared/traffic';
import { PathRunner, playerObstacles } from './drive';
import { homeFlow, type Mode, type ModeLock } from './homeflow';
import { closeWelcomeAfterCollect, departToast, giftLine, offlineSummary, pendingLines, returnPanel } from './welcome';
import { pendingView } from '../shared/economy';
import { createCampScene, disposeTree, makeVehicle, placeVehicle, toThree, type VehicleView } from './scene';
import { cardData, cardFileName, fmtMinutes, todayStats, type ClipboardEnv } from '../shared/card';
import { campShotCamera } from '../shared/cardcam';
import { CAMP_SHOT_H, drawCard, SHOT_W, VEHICLE_SHOT_H } from './card';
import { createCardFlow } from './cardflow';
import { dexView } from '../shared/dex';
import { dexHtml } from './dex';
import { closeGuide, closeMenu, drawers, menuArrow, menuOpen, mountHud, openGuide, guideOpen, openMenu, setBadge, syncCompass, syncDrawers } from './hud';
import { guideSeen, isDrawerTab, isGuideKey, isMenuKey, markGuideSeen, NARROW_PX } from '../shared/hudnav';
import { ENDPOINT, successEvent, getOrCreateAid, uuidV4, isOptedOut, payload, PRIVACY_TEXT, setOptOut, shouldSend, type AnalyticsEvent } from '../shared/analytics';

/** 更早一版存在 localStorage 的存档键：首次启动时导入 IndexedDB 后删除（IndexedDB 存档键见 save.ts SAVE_KEY） */
const LEGACY_SAVE_KEY = 'camp-empire.save.v2';
const DB_NAME = 'camp-empire';
const DEV_KEY = 'camp-empire.devOffsetMs';
const LOCK_NAME = 'camp-empire.writer';
const DEV = isDevEntry(location.search);

/** 浏览器本地存储；拿不到（隐私模式、被禁用）时为 null，读写都走下面的安全包装，不能让启动中断（GPT 审核 #90） */
const prefs = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();
/** 读一个键：读到（含“没有这个键”的 null）返回 { ok: true }；本地存储拿不到或读取抛错返回 { ok: false } */
const tryGet = (k: string): { ok: true; value: string | null } | { ok: false } => {
  try {
    if (!prefs) return { ok: false };
    return { ok: true, value: prefs.getItem(k) };
  } catch {
    return { ok: false };
  }
};
const safeRemove = (k: string) => {
  try {
    prefs?.removeItem(k);
  } catch {
    /* 存储不可用：旧存档留着也不影响 IndexedDB 存档 */
  }
};
/** 给开发快进用的存储适配器：每个方法单独兜底，存储方法抛错不让 ?dev 启动或重开中断（GPT 审核 #90 第 2 轮） */
const safeStorage = {
  getItem: (k: string) => {
    const r = tryGet(k);
    return r.ok ? r.value : null;
  },
  setItem: (k: string, v: string) => {
    try {
      prefs?.setItem(k, v);
    } catch {
      /* 写不进去就只在本页内存里生效 */
    }
  },
  removeItem: safeRemove,
};

/** 开发快进偏移只对记录它的那一局生效（issue #11）；普通入口不读不写 */
const devClock = new DevClock(DEV ? safeStorage : null, DEV_KEY, () => Date.now());
const now = () => devClock.now(state.sid);

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
// 图标列、罗盘先建好：之后任何 renderHud 都只更新它们
mountHud();
/** 与 style.css 窄屏断点同一条媒体查询；变窄时若两侧都开着，只留右侧（Codex 审核 #90） */
const narrowQuery = window.matchMedia(`(max-width: ${NARROW_PX}px)`);
narrowQuery.addEventListener('change', (e) => {
  if (e.matches && drawers.open.left && drawers.open.right) {
    drawers.open.left = null;
    syncDrawers();
  }
});

// ---------- T1 匿名统计（规则见 src/shared/analytics.ts，说明见 docs/ANALYTICS.md） ----------
/** 本次会话的关闭状态：存储写入失败（如已满）时也立即停止发送 */
let sessionOptOut = isOptedOut(prefs);
/** ev 为 null（操作没成功）时不发 */
function track(ev: AnalyticsEvent | null) {
  if (!ev) return;
  if (!shouldSend({ dev: DEV, hostname: location.hostname, storage: prefs, sessionOptOut })) return;
  const aid = getOrCreateAid(prefs, () => uuidV4(crypto.getRandomValues(new Uint8Array(16))));
  if (!aid) return;
  try {
    // text/plain：同源简单请求，不触发预检；失败静默，不影响游戏
    navigator.sendBeacon?.(ENDPOINT, new Blob([payload(aid, ev, __APP_VERSION__)], { type: 'text/plain' }));
  } catch {
    /* 统计失败不影响游戏 */
  }
}
function renderPrivacy() {
  const off = sessionOptOut;
  $('#privacy-body').innerHTML = `${PRIVACY_TEXT.map((t) => `<p>${t}</p>`).join('')}
    <p class="fine">当前：<b>${off ? '已关闭' : '已开启'}</b>${DEV ? '（调试入口不发送）' : ''}</p>`;
  $('#privacy-toggle').textContent = off ? '开启匿名统计' : '关闭匿名统计';
}
track('session_start');

// ---------- 存档：IndexedDB 原子事务 + 单写者锁（见 src/shared/save.ts） ----------
const locks = (navigator as unknown as { locks?: LocksLike }).locks;
const store = typeof indexedDB === 'undefined' ? null : await IdbStore.open(indexedDB, DB_NAME).catch(() => null);
const slot = store ? new SaveSlot(store, SAVE_KEY) : null;
// v3 槽位为空时导入 v2 槽位或 localStorage 旧存档（v2 槽位保留给仍开着的旧版本标签页，见 save.ts SAVE_KEY）
// 旧存档读不到（存储被禁用或读取抛错）和“没有旧档”要分开：读不到时不能当作新玩家写入新档，否则恢复后再也不会迁移（GPT 审核 #90 第 2 轮）
const legacyRead = tryGet(LEGACY_SAVE_KEY);
if (store && (await migrateSave(store, legacyRead.ok ? legacyRead.value : null).catch(() => null)) === 'legacy') safeRemove(LEGACY_SAVE_KEY);
const newSeed = () => hash32(`${Date.now()}:${Math.random()}`);
function clearDevOffset() {
  devClock.clear();
}
/**
 * 没有存档时新开一局：按真实时间建局，并清掉残留的开发快进偏移（GPT 审核 #4 第 4 轮第 1 条）。
 * 否则偏移会让新局在 now() 下一开局就跳到“未来”，或在偏移清除后被防回拨逻辑冻结。
 */
function freshGame(): GameState {
  clearDevOffset();
  return freshGameAt(Date.now(), newSeed());
}
const saved = slot ? await slot.read().catch(() => null) : null;
let state: GameState = saved ?? freshGame();
/** 没有可靠的原子写入或单写者机制：整页只读，提示原因（GPT 审核 #4 第 2 轮第 1 条） */
const unsupported = !slot
  ? '这个浏览器打不开 IndexedDB（可能是隐私模式），无法可靠保存，本页只读。'
  : legacyMayBeHidden(!!saved, legacyRead.ok)
    ? '读不到浏览器本地存储，那里可能还有你的旧存档。为了不覆盖它，本页先只读；请允许本站使用存储后刷新。'
    : !locks ? '这个浏览器不支持 Web Locks，无法保证只有一个标签页写存档，本页只读。' : null;
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

/** 回访面板（#28）：离线汇总 + 每日礼物 + 待收取放在同一个面板里，收取一键完成 */
function showReturnPanel(events: CampEvent[], gift: DailyGift | null) {
  const p = returnPanel(events, gift, pendingView(state.ledger.pending, awningOut(state)));
  if (!p) return;
  $('#welcome').innerHTML = `
    <h2>欢迎回到营地</h2>
    ${p.lines.map((l) => `<p>${l}</p>`).join('')}
    <div class="row">
      ${p.collect ? `<button class="primary" data-act="collect" data-arg="close">${p.collect}</button>` : ''}
      <button data-act="closeWelcome">${p.collect ? '稍后再收' : '知道了'}</button>
    </div>`;
  $('#welcome').hidden = false;
}

// ---------- 场景 ----------
const view = createCampScene($('#stage'));
const home = stallById('home');

let spec = specOf(currentVariant(state));
let player: VehicleView = makeVehicle(currentVariant(state));
let playerLights: LampState = {};
/** 画面玩家车（spec / player）对应的车型；与 state.variantId 不同说明换车后的画面重建还没执行 */
let playerVariantId = state.variantId;
view.scene.add(player.root);

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

// ---------- 视图（issue #44：俯瞰 / 跟随 / 环绕 / 引擎盖） ----------
const views = new ViewChoice(); // 默认环绕（issue #82）
let orbit: Orbit = orbitBehind(drive.pose.yaw);
let displayedOrbit: Orbit | null = null;
let hood = hoodMount(currentVariant(state));
const gesture = new OrbitGesture();
/** 加速挡：Shift 按住，或底栏按钮切换（触屏用） */
let boostLatch = false;
const blink = new BlinkClock();

function currentView(): View {
  return views.effective(mode === 'parked');
}

function selectView(v: View) {
  // 进入环绕时从车后方起转，与跟随视图衔接
  if (v === 'orbit' && currentView() !== 'orbit') {
    orbit = orbitBehind(drive.pose.yaw);
    displayedOrbit = null;
  }
  views.select(v, mode === 'parked');
  renderHud();
}

function rebuildPlayer() {
  view.scene.remove(player.root);
  disposeTree(player.root);
  spec = specOf(currentVariant(state));
  player = makeVehicle(currentVariant(state));
  player.setLights(playerLights);
  playerVariantId = state.variantId;
  hood = hoodMount(currentVariant(state));
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
    if (e.type === 'depart') {
      const msg = departToast(stallById(e.spotId).label, e, fmtDur(e.minutes));
      if (msg) toast(msg);
    }
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

/** 停回家位：视图回到默认环绕，从车后方起转（issue #82） */
function resetViewOnPark() {
  views.onParked();
  orbit = orbitBehind(drive.pose.yaw);
  displayedOrbit = null;
}

/** 按权威状态整体重建画面（玩家车 + 全部 NPC），用于采纳其他标签页写入的存档 */
function resyncView() {
  autoRun = null;
  autoDone = null;
  autoReplan = null;
  const wasParked = mode === 'parked';
  mode = state.player.parkedHome ? 'parked' : 'driving';
  const s = specOf(currentVariant(state));
  drive = { pose: state.player.parkedHome || !state.player.pose ? parkedPose(s, home) : state.player.pose, speed: 0, curvature: 0 };
  if (mode === 'parked' && !wasParked) resetViewOnPark();
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
  // 换成另一局（其他标签页重开）时，本页属于旧局的快进偏移同步失效（issue #11）
  devClock.adopt(s.sid);
  state = s;
  resyncView();
  renderHud();
}

/** 拿到写权后：离线回放 + 每日礼物 */
async function startSession() {
  try {
    const r = await act((s) => claimDailyGift(s, now()), { animate: false, announce: false });
    if (!r) return;
    showReturnPanel(r.events, r.gift);
  } finally {
    maybeAutoGuide();
  }
}

/**
 * 首次快捷键引导：开局处理结束后再决定（Codex 审核 #90）。回访面板开着就等它关掉再弹，免得两层叠在屏幕中央。
 * 只读标签页（没有开局处理）在拿不到写权时弹。只自动弹一次。
 */
let autoGuideDone = false;
function maybeAutoGuide() {
  if (autoGuideDone) return;
  autoGuideDone = true;
  if (guideSeen(prefs)) return;
  if ($('#welcome').hidden) return openGuide();
  new MutationObserver((_, obs) => {
    if (!$('#welcome').hidden) return;
    obs.disconnect();
    if (!guideSeen(prefs) && !guideOpen()) openGuide();
  }).observe($('#welcome'), { attributes: true, attributeFilter: ['hidden'] });
}

function setWriter(w: boolean) {
  const was = writer;
  writer = w;
  $('#readonly').hidden = w;
  if (w !== was) void adoptLatest(); // 交接写权时都以存档为准
  if (w && !was) void startSession();
  else if (!w) maybeAutoGuide();
  renderHud();
}

// ---------- 操作 ----------
/** 改变玩家车模式的动作（出发 / 停回家位）正在等存档提交：期间不重复触发 */
const modeLock: ModeLock = { busy: false };

/** 换车与出库（逻辑在 ./homeflow.ts，tests/homeflow.test.ts 按真实提交时序测试） */
const homeActions = homeFlow({
  act: (fn) => act(fn),
  state: () => state,
  mode: () => mode,
  now,
  home,
  obstacles: () => [...staticShapes(), ...parkedNpcShapes()],
  viewVariantId: () => playerVariantId,
  rebuildPlayer,
  setAwning: (on) => player.setAwning(on),
  startAuto: (path, done) => startAuto(path, done),
  onDeparted: (end) => {
    mode = 'driving';
    drive = { pose: { x: end.x, y: end.y, yaw: end.yaw }, speed: 0, curvature: 0 };
  },
  toast,
  lock: modeLock,
});

const actions: Record<string, (arg: string) => void | Promise<void>> = {
  variant: (id) => homeActions.variant(id),
  async buy() {
    const r = await act((s) => buyAwning(s, now()));
    track(successEvent.buy(r));
    if (!r) return;
    if (!r.ok) return toast(r.error!);
    player.setAwning(awningOut(state));
    toast('买到侧边帐！停在家位时会自动展开，露营者来得更勤');
  },
  async awning() {
    if (!(await act((s) => setAwningWanted(s, now(), !s.awningWanted)))) return;
    player.setAwning(awningOut(state));
  },
  // 按钮与 O 键共用：只有真的起步才计 drive_out（开着车、提交等待中、长按 O 的重复按键都不算）
  async out() {
    track(successEvent.driveOut(await homeActions.out()));
  },
  park() {
    if (mode !== 'driving' || modeLock.busy) return;
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
  view(arg) {
    if ((VIEWS as readonly string[]).includes(arg)) selectView(arg as View);
  },
  boost() {
    boostLatch = !boostLatch;
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
              safeRemove(LEGACY_SAVE_KEY);
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
    devClock.forward(state.sid, cmd.ms);
    const r = await act((s) => claimDailyGift(s, now()), { animate: false, announce: false });
    if (!r) return;
    if (!offlineSummary(r.events)) toast('快进期间没有露营者付费离开');
    showReturnPanel(r.events, r.gift);
  },
  async collect(arg) {
    const r = await act((s) => collectPending(s, now()));
    track(successEvent.collect(r));
    if (!r) return;
    if (closeWelcomeAfterCollect(arg === 'close', !!r.collected)) $('#welcome').hidden = true;
    if (!r.collected) return toast(r.error!);
    const { gross, amount, stays } = r.collected;
    toast(`收取 ${stays} 位露营者的停车费 ${displayGold(amount)} 金${amount !== gross ? `（当日超过软上限，毛收入 ${displayGold(gross)} 金）` : ''}`);
  },
  closeWelcome() {
    $('#welcome').hidden = true;
  },
  // 底栏罗盘：点一下展开 / 收起圆形菜单
  menu() {
    if (!closeMenu()) openMenu();
  },
  menuClose() {
    closeMenu();
  },
  // 圆形菜单里选了抽屉类功能：打开它（一次只开一个）
  drawer(tab) {
    if (isDrawerTab(tab)) drawers.toggle(tab, true);
    syncDrawers();
  },
  // action sheet 的“完成”按钮和遮罩、popover 外点：收起全部
  drawerClose() {
    if (drawers.closeAll()) syncDrawers();
  },
  // 快捷键引导：顶栏按钮 / H / ? 打开；关掉即记为看过
  guide() {
    if (guideOpen()) return actions.guideClose('');
    openGuide();
  },
  guideClose() {
    closeGuide();
    markGuideSeen(prefs);
  },
  // 露营卡片（#30）：只在玩家点按钮时生成，不自动弹出、不接分享渠道、无分享奖励
  async card() {
    await cardFlow.generate();
  },
  cardDownload() {
    track(successEvent.cardExport(cardFlow.download()));
  },
  async cardCopy() {
    track(successEvent.cardExport(await cardFlow.copy()));
  },
  cardClose() {
    cardFlow.close();
  },
  // 车型图鉴（#31）：只读面板，打开期间随 renderHud 刷新
  dex() {
    track(successEvent.dexOpen($('#dex').hidden));
    $('#dex').hidden = false;
  },
  dexClose() {
    $('#dex').hidden = true;
  },
  // T1 隐私与统计面板
  privacy() {
    renderPrivacy();
    $('#privacy').hidden = false;
  },
  privacyToggle() {
    sessionOptOut = !sessionOptOut;
    const saved = setOptOut(prefs, sessionOptOut);
    renderPrivacy();
    toast(`${sessionOptOut ? '已关闭匿名统计' : '已开启匿名统计'}${saved ? '' : '（浏览器存储不可用，只对本次打开有效）'}`);
  },
  privacyClose() {
    $('#privacy').hidden = true;
  },
};

// ---------- 露营卡片 ----------
/** 生成 → 预览 → 下载 / 复制（流程与测试见 cardflow.ts） */
const cardFlow = createCardFlow({
  ui: { box: $('#camp-card'), img: $('#camp-card-img') as HTMLImageElement },
  make() {
    const { canvas, data } = makeCard();
    return { canvas, name: cardFileName(data) };
  },
  createObjectURL: (b) => URL.createObjectURL(b),
  revokeObjectURL: (u) => URL.revokeObjectURL(u),
  createAnchor() {
    const a = document.createElement('a');
    document.body.appendChild(a);
    return a;
  },
  clipboard: () => ({
    clipboard: navigator.clipboard as unknown as ClipboardEnv['clipboard'],
    ClipboardItem: (window as unknown as { ClipboardItem?: ClipboardEnv['ClipboardItem'] }).ClipboardItem,
  }),
  toast: (m) => toast(m),
  log: (e) => console.error(e),
});

/** 取数（与界面同源）+ 车辆特写 + 营地俯视全景，排成一张竖版卡片 */
function makeCard() {
  const data = cardData(state, now());
  const v = currentVariant(state);
  const [cx, cy] = bodyCenter(spec, drive.pose);
  // 车辆特写：从车头右前方 45°（侧边帐在右侧）稍高处看向车身中部
  const a = drive.pose.yaw - Math.PI / 4;
  const d = v.lengthM * 0.9 + 4;
  const vehicleShot = view.snapshot(toThree(cx + Math.cos(a) * d, cy + Math.sin(a) * d, v.heightM + 2.2), toThree(cx, cy, v.heightM * 0.45), SHOT_W, VEHICLE_SHOT_H, { labels: false });
  // 营地全景：按营地边界与截图宽高比取景，整个营地（含围栏、大门）都在画面内（cardcam.ts，有测试），不加雾
  const cam = campShotCamera(SHOT_W / CAMP_SHOT_H);
  const campShot = view.snapshot(toThree(...cam.pos), toThree(...cam.look), SHOT_W, CAMP_SHOT_H, { fog: false });
  return { canvas: drawCard(data, vehicleShot, campShot), data };
}

function startAuto(path: PathPose[], done: () => void, replan: typeof autoReplan = null) {
  mode = 'auto';
  autoRun = new PathRunner(path, AUTO_SPEED);
  autoDone = done;
  autoReplan = replan;
  playerAgent.waited = 0;
}

async function settleHome() {
  if (modeLock.busy) return;
  modeLock.busy = true;
  const from = mode;
  try {
    const r = await act((s) => arriveHome(s, now()));
    // 提交失败，或等待期间画面已按其他标签页的存档重建：不改模式
    if (!r || mode !== from || !state.player.parkedHome) return;
  } finally {
    modeLock.busy = false;
  }
  mode = 'parked';
  boostLatch = false;
  drive = { pose: parkedPose(spec, home), speed: 0, curvature: 0 };
  resetViewOnPark(); // 停回家位：回到默认环绕（issue #82），停着时可再选别的视图
  placeVehicle(player.root, spec, drive.pose);
  player.setAwning(awningOut(state));
  toast('已停回家位');
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  renderHud();
  const act = el.dataset.act!;
  // 圆形菜单里选了任何一格（视图或功能）都先收起菜单；选了抽屉时焦点交给抽屉，不还回罗盘
  if (act !== 'menu' && act !== 'menuClose' && el.closest('#radial')) closeMenu(act !== 'drawer');
  // 统计不在这里发：点击不等于成功，各操作确认成功后自己上报（GPT 审核 #66 第 2 轮）
  void Promise.resolve(actions[act]?.(el.dataset.arg ?? '')).finally(renderHud);
});

// ---------- 键盘 ----------
const keys = new Set<string>();
const DRIVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
window.addEventListener('keydown', (e) => {
  // 焦点在引导里的按钮上时，空格 / 回车按原生方式点按钮，不当作驾驶输入（GPT 审核 #90）
  if (guideOpen() && (e.target as HTMLElement | null)?.closest?.('#guide')) {
    if (e.code === 'Escape' || (isGuideKey(e) && !e.repeat)) void actions.guideClose('');
    return;
  }
  // 键盘聚焦在按钮上时，空格 / 回车按原生方式点这个按钮，不当作刹车（GPT 审核 #90 第 2 轮）；
  // 鼠标点过的按钮焦点不让出，空格照样刹车（见 isKeyboardFocusedButton）
  if ((e.code === 'Space' || e.code === 'Enter') && isKeyboardFocusedButton(e.target)) return;
  // 圆形菜单开着、焦点在菜单里：方向键绕圈挪焦点，不当作驾驶
  if (menuOpen() && (e.target as HTMLElement | null)?.closest?.('#radial') && menuArrow(e.code)) {
    e.preventDefault();
    return;
  }
  if (DRIVE_KEYS.includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.repeat) return;
  if (e.code === 'Escape') {
    // Esc 先关引导，再收圆形菜单，再收抽屉
    if (guideOpen()) void actions.guideClose('');
    else if (closeMenu()) return;
    else if (drawers.closeAll()) syncDrawers();
    return;
  }
  if (isMenuKey(e) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    if (!closeMenu()) openMenu(true);
    return;
  }
  if (isGuideKey(e) && !e.ctrlKey && !e.metaKey && !e.altKey) {
    void actions.guide('');
    return;
  }
  const v = viewForKey(e.code, currentView());
  if (v) selectView(v === 'next' ? views.next(mode === 'parked') : v);
  if (e.code === 'KeyP') void actions.park('');
  if (e.code === 'KeyO') {
    void Promise.resolve(actions.out('')).finally(renderHud);
  }
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
/**
 * 焦点来源：鼠标 / 触摸点过的按钮焦点不算键盘焦点，按空格仍是刹车；只有 Tab 走到的按钮才让空格按原生方式点它。
 * 不用 :focus-visible 判断——鼠标点过的按钮在按下任意键后也会变成 focus-visible（Codex 审核 #90）。
 */
const keyboardFocused = new WeakSet<EventTarget>();
let pointerFocus = false;
window.addEventListener('pointerdown', () => (pointerFocus = true), true);
window.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') pointerFocus = false;
}, true);
document.addEventListener('focusin', (e) => {
  if (!e.target) return;
  if (pointerFocus) keyboardFocused.delete(e.target);
  else keyboardFocused.add(e.target);
});
function isKeyboardFocusedButton(t: EventTarget | null): boolean {
  return t instanceof HTMLButtonElement && keyboardFocused.has(t);
}
const k = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);

// ---------- 场景画面手势（环绕视图；规则见 src/shared/camview.ts OrbitGesture） ----------
const stage = $('#stage');
stage.addEventListener('pointerdown', (e) => {
  // 点场景画面就收起抽屉，把画面还给营地
  if (drawers.closeAll()) syncDrawers();
  if (currentView() !== 'orbit' || (e.pointerType === 'mouse' && e.button !== 0)) return;
  stage.setPointerCapture(e.pointerId);
  gesture.down(e.pointerId, e.clientX, e.clientY);
});
stage.addEventListener('pointermove', (e) => {
  if (currentView() !== 'orbit') return;
  const o = gesture.move(e.pointerId, e.clientX, e.clientY, orbit);
  if (o) orbit = o;
});
for (const ev of ['pointerup', 'pointercancel'] as const) stage.addEventListener(ev, (e) => gesture.up(e.pointerId));
stage.addEventListener(
  'wheel',
  (e) => {
    if (currentView() !== 'orbit') return;
    e.preventDefault();
    orbit = wheelZoom(orbit, e.deltaY);
  },
  { passive: false },
);

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
  // 步长上限 FRAME_MAX_DT_S：加速挡下每帧位移也有上限，碰撞不穿透（config.ts 推演）
  const dt = Math.min(FRAME_MAX_DT_S, (t - prev) / 1000) * timeScale;
  prev = t;
  const prevPose = { ...(mode === 'auto' && autoRun ? autoRun.current : drive.pose) };
  /** 车灯用的输入：手动驾驶时为玩家方向 / 刹车 */
  let steerIn = 0;
  let brakingIn = false;
  const boost = boostLatch || keys.has('ShiftLeft') || keys.has('ShiftRight');

  // 停回家位正在提交时冻结手动输入，避免提交后位姿跳变
  if (mode === 'driving' && writer && !modeLock.busy) {
    let throttle = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
    if (keys.has('Space')) throttle = drive.speed > 0 ? -1 : drive.speed < 0 ? 1 : 0;
    const steer = k('KeyA', 'ArrowLeft') - k('KeyD', 'ArrowRight');
    steerIn = steer;
    brakingIn = manualBraking(throttle, drive.speed, keys.has('Space'));
    const next = stepDrive(spec, drive, { throttle, steer, boost }, dt);
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

  const running = runningLights(now());
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
    c.view.setLights(running);
    placeVehicle(c.view.root, c.spec, c.pose);
  }

  if (t - lastTick > 1000) {
    lastTick = t;
    if (!ticking) {
      ticking = true;
      // 写者回放 + 结算；只读页不回放、不写存档，每秒从存档跟随刷新
      const job = writer
        ? act((s) => claimDailyGift(s, now())).then((r) => {
            if (r?.gift) toast(`新的一天！${giftLine(r.gift)}`);
          })
        : adoptLatest();
      void job.finally(() => (ticking = false));
    }
    renderHud();
  }

  // 车灯（自动灯光，规则见 src/shared/lights.ts）。自动驾驶时没有方向 / 速度输入，用本帧实际位移推算
  let lightSpeed = drive.speed;
  let autoCurv = 0;
  if (mode === 'auto' && dt > 0) {
    const p = drive.pose;
    const ds = (p.x - prevPose.x) * Math.cos(p.yaw) + (p.y - prevPose.y) * Math.sin(p.yaw);
    lightSpeed = ds / dt;
    brakingIn = Math.abs(ds) < 1e-4; // 让行停住
    const dyaw = Math.atan2(Math.sin(p.yaw - prevPose.yaw), Math.cos(p.yaw - prevPose.yaw));
    autoCurv = Math.abs(ds) > 1e-4 ? dyaw / ds : 0;
  }
  const ls = lightsFor({ mode, steer: steerIn, curvature: autoCurv, speed: lightSpeed, braking: brakingIn });
  const bl = blink.update(ls, t / 1000);
  playerLights = { ...running, turnL: bl.left, turnR: bl.right, brake: ls.brake, reverse: ls.reverse };
  player.setLights(playerLights);

  const [cx, cy] = bodyCenter(spec, drive.pose);
  const activeView = currentView();
  displayedOrbit = activeView === 'orbit' ? smoothOrbit(displayedOrbit ?? orbit, orbit, dt) : null;
  view.setCamera(camFor(activeView, { x: cx, y: cy, yaw: drive.pose.yaw, h: spec.lengthM / 4 }, displayedOrbit ?? orbit, hood));
  $('#bump').hidden = t > bumpUntil;
  const boosting = mode === 'driving' && boost;
  $('#speed').textContent = `${Math.abs(drive.speed * 3.6).toFixed(0)} km/h${drive.speed < -0.05 ? ' 倒车' : ''}${boosting ? ' · 加速挡' : ''}`;
  view.render(dt);
}

// ---------- 界面 ----------
const fmtDur = (min: number) => `${Math.floor(min / 60)} 小时 ${String(min % 60).padStart(2, '0')} 分`;
const clock = (ms: number) =>
  new Date(ms).toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, hour: '2-digit', minute: '2-digit' });

/** 内容没变就不重写：每秒的 HUD 刷新不再替换抽屉里的按钮节点，玩家点击（和 e2e 的真实点击）不会点到被换掉的节点（GPT 审核 #90） */
function setHtml(sel: string, html: string) {
  const el = $(sel);
  if (el.dataset.html === html) return;
  el.innerHTML = html;
  el.dataset.html = html;
}

function renderHud() {
  const v = currentVariant(state);
  const t = now();
  $('#coins').textContent = displayGold(state.ledger.balance).toLocaleString('zh-CN');
  $('#clock').textContent = `上海 ${clock(t)}${devClock.offsetFor(state.sid) ? ' · 已快进' : ''}`;

  const parkedHome = mode === 'parked';
  const ts = todayStats(state, t);
  const dv = dexView(state.dex);
  const dexLabel = `车型图鉴 ${dv.lit} / ${dv.total}`;
  if ($('#dex-entry').getAttribute('aria-label') !== dexLabel) {
    $('#dex-entry').setAttribute('aria-label', dexLabel);
  }
  setBadge('dex', dv.lit ? `${dv.lit}` : '');
  if (!$('#dex').hidden) {
    // 内容没变就不重写，避免每秒刷新打断滚动
    const html = dexHtml(dv);
    if ($('#dex').dataset.html !== html) {
      $('#dex').innerHTML = html;
      $('#dex').dataset.html = html;
    }
  }
  setHtml('#garage', `
    <h2>车库</h2>
    <p class="hint">${parkedHome ? '选一辆你的车（尺寸为公告三围，占位外观）' : '停回家位后才能换车'}</p>
    <ul class="models">${CATALOG.map(
      (m) => `<li>
        <div class="model-name">${m.model}<span>${m.variants[0].lengthM.toFixed(2)} × ${m.variants[0].widthM.toFixed(2)} m</span></div>
        <div class="chips">${m.variants
          .map((x) => `<button class="chip ${x.id === v.id ? 'on' : ''}" data-act="variant" data-arg="${x.id}" ${parkedHome ? '' : 'disabled'}>${x.roofLabel}</button>`)
          .join('')}</div></li>`,
    ).join('')}</ul>`);

  const out = awningOut(state);
  setHtml('#shop', `
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
    </div>`);

  setHtml('#spots', `
    <h2>我的营地车位</h2>
    <p class="hint">露营者自己开来、自己离开，离开时付停车费进入待收取：${NPC.rateCentsPerHour / 100} 金 / 小时，单次最多 ${NPC.capMinutes / 60} 小时。爱心车位免费给露营者停。</p>
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
    <p class="fine">今天到访 ${ts.visitors} 位露营者，爱心车位公益停靠 ${fmtMinutes(ts.loveMinutes)}（上海日，露营卡片同源）</p>
    <p class="fine">爱心车位累计公益停靠 ${fmtDur(state.camp.loveMinutes)}</p>`);

  const pv = pendingView(state.ledger.pending, out);
  const pl = pendingLines(pv);
  // 图标角标：待收取金额（有钱就跳）、车位占用、买得起侧边帐、礼物未领
  setBadge('pending', pv.pending > 0 ? displayGold(pv.pending).toLocaleString('zh-CN') : '', pv.pending > 0);
  const busy = state.camp.spots.filter((sp) => sp.stay).length;
  setBadge('spots', busy ? `${busy}/${state.camp.spots.length}` : '');
  setBadge('shop', !state.awningOwned && state.ledger.balance >= SIDE_AWNING.priceGold * 100 ? '!' : '');
  setHtml('#pending', `
    <h2>待收取</h2>
    <div class="card">
      <div class="row"><b>停车费</b><span class="coin">${displayGold(pv.pending).toLocaleString('zh-CN')}</span></div>
      <div class="bar"><i style="width:${((pv.pending / pv.cap) * 100).toFixed(1)}%"></i></div>
      <p class="${pv.full ? 'warn' : ''}">${pl.status}</p>
      ${pl.lost ? `<p class="lost">${pl.lost}</p>` : ''}
      <button data-act="collect" ${pv.pending > 0 ? '' : 'disabled'}>收取</button>
    </div>
    <p class="fine">上限 = ${PENDING.capHours} 小时的期望停车收入（${PENDING.capGold} 金，提案值）。收取的金额按收取当天计入每日软上限。</p>`);

  const sv = giftStreakView(state, now());
  setBadge('daily', sv.claimedToday ? '' : '!', true);
  setHtml('#daily', `
    <h2>每日</h2>
    <p class="hint">每天首次登录，营地管理员巡视送礼。连续登录 7 日梯度（金额固定，无抽取，第 8 天起循环）：</p>
    <ol class="ladder">${LADDER.map((gold, i) => `<li class="${i + 1 === sv.today ? 'today' : ''}"><span>第 ${i + 1} 天</span><b>${gold}</b></li>`).join('')}</ol>
    <p>今天第 ${sv.today} 天（连续 ${sv.streak} 天）${sv.claimedToday ? `，已领 ${sv.claimedGold} 金` :`，可领 ${sv.todayGold} 金`}；明天继续登录可领 ${sv.tomorrowGold} 金。</p>
    <p class="fine">断签只回到第 1 天，已领的金币不扣、不清零。连续 7 天共 ${LADDER.reduce((s, g) => s + g, 0)} 金，平均每天 ${ladderMeanGold().toFixed(1)} 金（提案值）。日界为上海时间 0 点。</p>
    <p class="fine">今日已入账 ${displayGold(ts.issuedCents)} 金；当日收入超过 ${ECONOMY.softCapThresholdGold} 金的部分按 ${ECONOMY.softCapRateAbove * 100}% 发放。</p>`);

  setHtml('#log', state.ledger.entries
    .slice(-6)
    .reverse()
    .map((e) => {
      const capped = e.amount !== e.gross ? `（软上限后，毛收入 ${displayGold(e.gross)}）` : '';
      const where = e.kind === 'npc_parking' ? `${stallById(e.key.split('#')[0]).label} · ` : '';
      return `<li><span class="when">${clock(e.atMs)}</span>${where}${e.note}<b class="${e.amount < 0 ? 'neg' : ''}">${e.amount >= 0 ? '+' : ''}${displayGold(e.amount)}</b>${capped}</li>`;
    })
    .join(''));

  $('#controls').innerHTML =
    mode === 'parked'
      ? `<button class="primary" data-act="out">开出去兜一圈 <kbd>O</kbd></button>`
      : mode === 'driving'
        ? `<button class="primary" data-act="park">自动泊回家位 <kbd>P</kbd></button><button class="boost ${boostLatch ? 'on' : ''}" data-act="boost" aria-pressed="${boostLatch}">加速挡 <kbd>Shift</kbd></button><span class="keys"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> 驾驶 · <kbd>空格</kbd> 刹车</span>`
        : `<span class="keys">自动驾驶中…</span>`;
  // 罗盘（#44 的四个视图 + 1–4 / V 键）：节点只建一次，这里只转指针；环绕视图下提示手势
  const cv = currentView();
  syncCompass(cv);
  if (cv === 'orbit') $('#controls').insertAdjacentHTML('beforeend', `<span class="keys">拖拽画面环绕 · 滚轮 / 双指缩放</span>`);
}

if (DEV) {
  $('#dev').hidden = false;
  // 调试入口（仅 ?dev），用于车辆截图和撞击效果检查
  (window as unknown as { __campDebug: unknown }).__campDebug = {
    vehicleShot(angle: 'front34' | 'side' | 'entrySide' | 'rear34', lit = false): string {
      const [forward, left] = { front34: [7, -5.5], side: [0, 9], entrySide: [0, -9], rear34: [-7, 5.5] }[angle];
      const [cx, cy] = bodyCenter(spec, drive.pose);
      const cos = Math.cos(drive.pose.yaw);
      const sin = Math.sin(drive.pose.yaw);
      // 固定灯态，让两张截图的区别不依赖 runner 时间。即使截图失败也恢复玩家车。
      player.setLights({ head: lit, tail: lit, marker: lit, turnL: lit, turnR: lit, reverse: lit, brake: lit });
      try {
        return view.snapshot(
          toThree(cx + forward * cos - left * sin, cy + forward * sin + left * cos, 2.6),
          toThree(cx, cy, 1.2),
          1280, 800, { fog: false, labels: false },
        ).toDataURL('image/png');
      } finally {
        player.setLights(playerLights);
      }
    },
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
// 首次打开：快捷键引导（看过就不再自动弹，H / ? / 顶栏按钮可再开）
// 首次快捷键引导在 maybeAutoGuide 里弹：等开局处理（每日礼物 / 回访面板）结束之后
setTimeout(maybeAutoGuide, 4000); // 兜底：拿写权或开局迟迟没结束时也要弹
