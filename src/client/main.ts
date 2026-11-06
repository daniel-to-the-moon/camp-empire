/**
 * 入口：把 src/shared 的纯逻辑接到场景与界面。
 * 时间：now() = 本机时间 + 开发快进偏移（?dev 面板）。M1 单机原型，存档在 localStorage。
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
import { parkedPose, planNpcArrival, planNpcDeparture, planParkIn, planReverseOut, type PathPose } from '../shared/parking';
import { hash32 } from '../shared/rng';
import {
  arriveHome,
  awningOut,
  buyAwning,
  claimDailyGift,
  currentVariant,
  leaveHome,
  loadSave,
  newGame,
  selectVariant,
  setAwningWanted,
  tick,
  type GameState,
} from '../shared/state';
import { PathRunner, playerObstacles } from './drive';
import { createCampScene, disposeTree, makeVehicle, placeVehicle, type VehicleView } from './scene';

const SAVE_KEY = 'camp-empire.save.v2';
const DEV_KEY = 'camp-empire.devOffsetMs';
const DEV = new URLSearchParams(location.search).has('dev');

let devOffset = DEV ? Number(localStorage.getItem(DEV_KEY) ?? 0) || 0 : 0;
const now = () => Date.now() + devOffset;

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

let state: GameState = loadSave(localStorage.getItem(SAVE_KEY)) ?? newGame(now(), hash32(`${Date.now()}:${Math.random()}`));
const save = () => localStorage.setItem(SAVE_KEY, JSON.stringify(state));

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
let overview = false;

function rebuildPlayer() {
  view.scene.remove(player.root);
  disposeTree(player.root);
  spec = specOf(currentVariant(state));
  player = makeVehicle(currentVariant(state));
  view.scene.add(player.root);
  if (mode === 'parked') drive.pose = parkedPose(spec, home);
  placeVehicle(player.root, spec, drive.pose);
  player.setAwning(awningOut(state));
}
placeVehicle(player.root, spec, drive.pose);
player.setAwning(awningOut(state));

// ---------- NPC 车 ----------
interface NpcCar {
  parkingId: string;
  view: VehicleView;
  spec: ReturnType<typeof specOf>;
  runner: PathRunner | null;
  pose: Pose;
}
const npcs = new Map<string, NpcCar>();
const leaving: NpcCar[] = [];
const TINTS = [0xe9e4d8, 0xc9d6df, 0xe8d3b0, 0xb7c9a8, 0xd9c2c2, 0xbfc4cf];

function npcCar(parkingId: string, variantId: string): NpcCar {
  const v = findVariant(variantId)!;
  const vv = makeVehicle(v, TINTS[hash32(parkingId) % TINTS.length]);
  view.scene.add(vv.root);
  return { parkingId, view: vv, spec: specOf(v), runner: null, pose: { x: 0, y: 0, yaw: 0 } };
}

function removeCar(c: NpcCar) {
  view.scene.remove(c.view.root);
  disposeTree(c.view.root);
}

function syncNpcs(events: CampEvent[], animate: boolean) {
  for (const e of events) {
    if (e.type !== 'depart') continue;
    const c = npcs.get(e.spotId);
    if (!c || c.parkingId !== e.stay.parkingId) continue;
    npcs.delete(e.spotId);
    const plan = animate ? planNpcDeparture(c.spec, stallById(e.spotId), staticShapes()) : null;
    if (plan?.ok) {
      c.runner = new PathRunner(plan.path, 5);
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
      } else c.pose = parkedPose(c.spec, stall);
      placeVehicle(c.view.root, c.spec, c.pose);
      npcs.set(sp.id, c);
    }
  }
}

function movingNpcShapes(): Shape[] {
  const out: Shape[] = [];
  for (const c of [...npcs.values(), ...leaving]) {
    if (c.runner) out.push({ type: 'poly', pts: footprint(c.spec, c.pose), tag: 'npc' });
  }
  return out;
}

// ---------- 开局：离线回放 + 每日礼物 ----------
{
  const off = tick(state, now());
  syncNpcs(off, false);
  const msg = summarizeOffline(off);
  const gift = claimDailyGift(state, now());
  save();
  const parts = [msg, gift ? `营地管理员巡视送来 ${gift.gold} 金（每日首次登录）` : null].filter(Boolean);
  if (parts.length) toast(parts.join('；'), 6000);
}

// ---------- 操作 ----------
const actions: Record<string, (arg: string) => void> = {
  variant(id) {
    const r = selectVariant(state, now(), id);
    if (!r.ok) return toast(r.error!);
    rebuildPlayer();
    save();
  },
  buy() {
    const r = buyAwning(state, now());
    if (!r.ok) return toast(r.error!);
    player.setAwning(awningOut(state));
    save();
    toast('买到侧边帐！停在家位时会自动展开，露营者来得更勤');
  },
  awning() {
    setAwningWanted(state, now(), !state.awningWanted);
    player.setAwning(awningOut(state));
    save();
  },
  out() {
    if (mode !== 'parked') return;
    const plan = planReverseOut(spec, home, staticShapes());
    if (!plan.ok) return toast(plan.reason!);
    const end = plan.path[plan.path.length - 1];
    leaveHome(state, now(), { x: end.x, y: end.y, yaw: end.yaw });
    player.setAwning(false);
    save();
    startAuto(plan.path, () => {
      mode = 'driving';
      drive = { pose: { x: end.x, y: end.y, yaw: end.yaw }, speed: 0, curvature: 0 };
    });
  },
  park() {
    if (mode !== 'driving') return;
    const parked = [...npcs.values()].map((c) => ({ type: 'poly' as const, pts: footprint(c.spec, c.pose), tag: 'npc' }));
    const plan = planParkIn(spec, drive.pose, home, [...staticShapes(), ...parked]);
    if (!plan.ok) return toast(plan.reason!);
    startAuto(plan.path, settleHome);
  },
  overview() {
    overview = !overview;
  },
  dev(arg) {
    if (arg === 'reset') {
      localStorage.removeItem(SAVE_KEY);
      localStorage.removeItem(DEV_KEY);
      location.reload();
      return;
    }
    devOffset += Number(arg);
    localStorage.setItem(DEV_KEY, String(devOffset));
    const ev = tick(state, now());
    syncNpcs(ev, false);
    const gift = claimDailyGift(state, now());
    save();
    toast([summarizeOffline(ev) ?? '快进期间没有露营者离开', gift ? `管理员送来 ${gift.gold} 金` : null].filter(Boolean).join('；'));
    renderHud();
  },
};

function startAuto(path: PathPose[], done: () => void) {
  mode = 'auto';
  autoRun = new PathRunner(path, 6);
  autoDone = done;
}

function settleHome() {
  arriveHome(state, now());
  mode = 'parked';
  drive = { pose: parkedPose(spec, home), speed: 0, curvature: 0 };
  placeVehicle(player.root, spec, drive.pose);
  player.setAwning(awningOut(state));
  save();
  toast('已停回家位');
}

document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-act]');
  if (!el || (el as HTMLButtonElement).disabled) return;
  actions[el.dataset.act!]?.(el.dataset.arg ?? '');
  renderHud();
});

// ---------- 键盘 ----------
const keys = new Set<string>();
const DRIVE_KEYS = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'];
window.addEventListener('keydown', (e) => {
  if (DRIVE_KEYS.includes(e.code)) e.preventDefault();
  keys.add(e.code);
  if (e.code === 'KeyC') actions.overview('');
  if (e.code === 'KeyP') actions.park('');
  if (e.code === 'KeyO') actions.out('');
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
const k = (...codes: string[]) => (codes.some((c) => keys.has(c)) ? 1 : 0);

// ---------- 主循环 ----------
const obstacles = playerObstacles();
let lastTick = 0;
let lastSave = 0;
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

function frame(t: number) {
  const dt = Math.min(0.05, (t - prev) / 1000) * timeScale;
  prev = t;

  if (mode === 'driving') {
    let throttle = k('KeyW', 'ArrowUp') - k('KeyS', 'ArrowDown');
    if (keys.has('Space')) throttle = drive.speed > 0 ? -1 : drive.speed < 0 ? 1 : 0;
    const steer = k('KeyA', 'ArrowLeft') - k('KeyD', 'ArrowRight');
    const next = stepDrive(spec, drive, { throttle, steer }, dt);
    const r = resolveDrive(spec, drive, next, [...obstacles, ...movingNpcShapes()]);
    drive = r.state;
    if (r.impact) onImpact(r.impact, t);
    // 手动停进家位：车停稳且四角都在家位里
    if (Math.abs(drive.speed) < 0.05 && footprint(spec, drive.pose).every((p) => pointInPoly(p, stallRect(home)))) {
      settleHome();
    }
    if (t - lastSave > 2000 && mode === 'driving') {
      state.player.pose = drive.pose;
      save();
      lastSave = t;
    }
  } else if (mode === 'auto' && autoRun) {
    const p = autoRun.step(dt);
    drive = { pose: p, speed: 0, curvature: 0 };
    if (autoRun.done) {
      autoRun = null;
      const d = autoDone;
      autoDone = null;
      d?.();
    }
  }
  placeVehicle(player.root, spec, drive.pose);

  for (const c of [...npcs.values(), ...leaving]) {
    if (!c.runner) continue;
    c.pose = c.runner.step(dt);
    placeVehicle(c.view.root, c.spec, c.pose);
    if (c.runner.done) {
      c.runner = null;
      const i = leaving.indexOf(c);
      if (i >= 0) {
        leaving.splice(i, 1);
        removeCar(c);
      }
    }
  }

  if (t - lastTick > 1000) {
    lastTick = t;
    const ev = tick(state, now());
    if (ev.length) {
      syncNpcs(ev, true);
      for (const e of ev) {
        if (e.type === 'depart' && e.amount > 0) toast(`${stallById(e.spotId).label}的露营者停了 ${fmtDur(e.minutes)}，付你 ${displayGold(e.amount)} 金`);
        if (e.type === 'arrive') toast(`一位露营者开进了${stallById(e.spotId).label}`);
      }
      save();
    }
    const gift = claimDailyGift(state, now());
    if (gift) {
      save();
      toast(`新的一天！营地管理员巡视送来 ${gift.gold} 金`);
    }
    renderHud();
  }

  const [cx, cy] = bodyCenter(spec, drive.pose);
  view.follow({ x: cx, y: cy, yaw: drive.pose.yaw, h: spec.lengthM / 4 }, overview || mode === 'parked');
  $('#bump').hidden = t > bumpUntil;
  $('#speed').textContent = `${Math.abs(drive.speed * 3.6).toFixed(0)} km/h${drive.speed < -0.05 ? ' 倒车' : ''}`;
  view.render(dt);
  requestAnimationFrame(frame);
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
renderHud();
requestAnimationFrame(frame);
