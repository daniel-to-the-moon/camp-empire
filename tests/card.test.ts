/**
 * 露营卡片（issue #30）：当日数据取数与游戏内记录一致、成就显示条件、存档补字段、复制到剪贴板的降级、不自动弹出。
 */
import { describe, expect, it } from 'vitest';
import mainSrc from '../src/client/main.ts?raw';
import cardSrc from '../src/shared/card.ts?raw';
import html from '../index.html?raw';
import css from '../src/style.css?raw';
import * as THREE from 'three';
import { CAMP_SHOT_H, CARD_H, CARD_W, drawCard, SHOT_W, VEHICLE_SHOT_H } from '../src/client/card';
import { CARD_FAIL_MSG, createCardFlow } from '../src/client/cardflow';
import { takeSnapshot } from '../src/client/snapshot';
import { toThree } from '../src/client/scene';
import { campFrameCorners, campShotCamera, projectNdc, SNAPSHOT_FOV_DEG } from '../src/shared/cardcam';
import { WORLD } from '../src/shared/camp';
import { CARD_STREAK_MIN, cardData, cardFileName, cardStats, copyMessage, copyPng, fmtMinutes, todayStats, type ClipboardEnv } from '../src/shared/card';
import { dayKey, dayLabel, displayGold } from '../src/shared/ledger';
import { advanceCamp, newCampSim, type CampEvent } from '../src/shared/npc';
import { RENTAL_SPOTS } from '../src/shared/camp';
import { newLedger } from '../src/shared/ledger';
import { buyAwning, claimDailyGift, collectPending, currentVariant, loadSave, newGame, tick, type GameState } from '../src/shared/state';

/** 2026-11-dd hh:00 上海时间 */
const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);
const reload = (s: GameState) => loadSave(JSON.stringify(s))!;

/** 由事件独立推算某上海日的到访数与爱心车位公益分钟（对照组） */
function expectedFor(events: CampEvent[], day: number) {
  const love = new Set(RENTAL_SPOTS.filter((s) => s.kind === 'love').map((s) => s.id));
  return {
    arrivals: events.filter((e) => e.type === 'arrive' && dayKey(e.atMs) === day).length,
    loveMinutes: events
      .filter((e): e is Extract<CampEvent, { type: 'depart' }> => e.type === 'depart' && love.has(e.spotId) && dayKey(e.atMs) === day)
      .reduce((s, e) => s + e.minutes, 0),
  };
}

describe('当日统计（camp.daily）', () => {
  it('到访数与公益分钟等于当天事件之和，跨日清零；分段回放与一次回放结果相同', () => {
    const t0 = nov(1, 8);
    const end = nov(4, 20);
    const one = newCampSim(11, t0, RENTAL_SPOTS);
    const events = advanceCamp(one, newLedger(t0), end, { awningOut: false });
    const day = dayKey(end);
    expect(one.daily).toEqual({ day, ...expectedFor(events, day) });
    expect(one.daily.arrivals).toBeGreaterThan(0); // 3.5 天里当天必有到访，测试才有意义

    const step = newCampSim(11, t0, RENTAL_SPOTS);
    const l = newLedger(t0);
    for (let t = t0; t < end; t += 37 * 60_000) advanceCamp(step, l, t, { awningOut: false });
    advanceCamp(step, l, end, { awningOut: false });
    expect(step.daily).toEqual(one.daily);
  });

  it('爱心车位公益分钟累计口径与 loveMinutes 一致（全部天数之和 = 累计）', () => {
    const t0 = nov(1, 0);
    const sim = newCampSim(5, t0, RENTAL_SPOTS);
    const l = newLedger(t0);
    let sum = 0;
    let all: CampEvent[] = [];
    for (let d = 1; d <= 10; d++) {
      const ev = advanceCamp(sim, l, nov(d + 1, 0) - 1, { awningOut: false });
      all = all.concat(ev);
      expect(sim.daily.day).toBe(dayKey(nov(d, 12)));
      expect(sim.daily).toMatchObject(expectedFor(all, sim.daily.day));
      sum += sim.daily.loveMinutes;
    }
    expect(sum).toBe(sim.loveMinutes);
  });
});

describe('todayStats：与界面同源', () => {
  it('当日实得 = ledger.today.issued = 当天入账流水之和（礼物 + 收取）', () => {
    const s = newGame(nov(1, 8), 3);
    claimDailyGift(s, nov(1, 9));
    claimDailyGift(s, nov(2, 9));
    collectPending(s, nov(2, 21));
    const t = todayStats(s, nov(2, 22));
    const day = dayKey(nov(2, 22));
    const credited = s.ledger.entries.filter((e) => e.day === day && (e.kind === 'daily_gift' || e.kind === 'parking_collect'));
    expect(credited.length).toBeGreaterThan(1);
    expect(t.issuedCents).toBe(credited.reduce((a, e) => a + e.amount, 0));
    expect(t.issuedCents).toBe(s.ledger.today.issued);
    expect(t.visitors).toBe(s.camp.daily.arrivals);
    expect(t.loveMinutes).toBe(s.camp.daily.loveMinutes);
  });

  it('统计桶停在更早的日子：当天数据为 0，不把昨天的数字当今天', () => {
    const s = newGame(nov(1, 8), 3);
    claimDailyGift(s, nov(1, 23));
    s.camp.daily.arrivals = 4; // 昨天的到访
    s.camp.daily.loveMinutes = 90;
    // 第二天还没有任何回放 / 入账
    const t = todayStats(s, nov(2, 0) + 60_000);
    expect(t).toEqual({ day: dayKey(nov(2, 1)), visitors: 0, issuedCents: 0, loveMinutes: 0 });
  });

  it('时钟回拨：按有效时间所在的日子计，不倒退', () => {
    const s = newGame(nov(1, 8), 3);
    tick(s, nov(2, 12));
    expect(todayStats(s, nov(1, 9)).day).toBe(dayKey(nov(2, 12)));
  });
});

describe('cardData', () => {
  it('四类内容：车型、当日数据、日期与游戏名；数字与 todayStats 一致', () => {
    const s = newGame(nov(1, 8), 9);
    claimDailyGift(s, nov(1, 9));
    tick(s, nov(1, 20));
    const d = cardData(s, nov(1, 20));
    const t = todayStats(s, nov(1, 20));
    const v = currentVariant(s);
    expect(d.game).toContain('camp·empire');
    expect(d.date).toBe('2026-11-01');
    expect(d.date).toBe(dayLabel(t.day));
    expect(d.vehicle.model).toBe(v.model);
    expect(d.vehicle.roof).toBe(v.roofLabel);
    expect(d.visitors).toBe(t.visitors);
    expect(d.goldToday).toBe(displayGold(t.issuedCents));
    expect(d.loveMinutesToday).toBe(t.loveMinutes);
    expect(cardStats(d).map((x) => x.value)).toEqual([`${t.visitors} 位`, `${displayGold(t.issuedCents).toLocaleString('zh-CN')} 金`, fmtMinutes(t.loveMinutes)]);
  });

  it('上海日：UTC 前一天 16:00 之后已是上海的第二天', () => {
    const s = newGame(nov(1, 8), 9);
    expect(cardData(s, Date.UTC(2026, 10, 1, 16, 30)).date).toBe('2026-11-02');
  });

  it('里程碑：新开局第 1 天没有任何里程碑（整块不显示）', () => {
    const s = newGame(nov(1, 8), 9);
    claimDailyGift(s, nov(1, 8));
    expect(cardData(s, nov(1, 8)).milestones).toEqual([]);
  });

  it(`里程碑：侧边帐、连续登录 ≥ ${CARD_STREAK_MIN} 天、累计公益停靠`, () => {
    const s = newGame(nov(1, 8), 9);
    for (let d = 1; d <= 3; d++) claimDailyGift(s, nov(d, 9));
    s.ledger.balance += 1_000_000; // 测试里直接给够钱买侧边帐
    s.ledger.entries.push({ key: 't', atMs: nov(3, 9), day: dayKey(nov(3, 9)), kind: 'start', gross: 1_000_000, amount: 1_000_000, note: 't' });
    expect(buyAwning(s, nov(3, 10)).ok).toBe(true);
    s.camp.loveMinutes = 125;
    const m = cardData(s, nov(3, 11)).milestones;
    expect(m).toContain('已拥有侧边帐（正在展开）');
    expect(m).toContain('连续登录 3 天');
    expect(m).toContain('爱心车位累计公益停靠 2 小时 05 分');
  });

  it('连续登录只认今天已领的记录（不预测今天领取后的天数）', () => {
    const s = newGame(nov(1, 8), 9);
    claimDailyGift(s, nov(1, 9));
    claimDailyGift(s, nov(2, 9));
    // 第 3 天还没领：不显示“连续 3 天”
    expect(cardData(s, nov(3, 0) + 60_000).milestones.some((x) => x.startsWith('连续登录'))).toBe(false);
  });

  it('文件名带日期', () => {
    expect(cardFileName({ date: '2026-11-08' })).toBe('camp-empire-2026-11-08.png');
  });
});

describe('存档', () => {
  it('当日统计随存档保存与读取', () => {
    const s = newGame(nov(1, 8), 9);
    tick(s, nov(1, 22));
    expect(reload(s).camp.daily).toEqual(s.camp.daily);
  });

  it('本字段加入前的存档：补为从加载时起计（0），不拒绝存档', () => {
    const s = newGame(nov(1, 8), 9);
    tick(s, nov(1, 22));
    const old = JSON.parse(JSON.stringify(s));
    delete old.camp.daily;
    const r = loadSave(JSON.stringify(old))!;
    expect(r).not.toBeNull();
    expect(r.camp.daily).toEqual({ day: dayKey(s.camp.lastMs), arrivals: 0, loveMinutes: 0 });
    expect(r.ledger.balance).toBe(s.ledger.balance);
  });

  it('非法统计值同样补为 0', () => {
    const s = newGame(nov(1, 8), 9);
    const bad = JSON.parse(JSON.stringify(s));
    bad.camp.daily = { day: 'x', arrivals: -1, loveMinutes: 0 };
    expect(loadSave(JSON.stringify(bad))!.camp.daily).toEqual({ day: dayKey(s.camp.lastMs), arrivals: 0, loveMinutes: 0 });
  });
});

describe('复制到剪贴板', () => {
  const blob = new Blob(['png'], { type: 'image/png' });
  class Item {
    constructor(public items: Record<string, Blob>) {}
  }

  it('支持时写入 image/png', async () => {
    const written: unknown[][] = [];
    const env: ClipboardEnv = { ClipboardItem: Item, clipboard: { write: async (x) => void written.push(x) } };
    expect(await copyPng(blob, env)).toBe('copied');
    expect((written[0][0] as Item).items['image/png']).toBe(blob);
    expect(copyMessage('copied')).toContain('已复制');
  });

  it('不支持（无 ClipboardItem 或无 clipboard.write）：返回 unsupported，提示改用下载', async () => {
    expect(await copyPng(blob, {})).toBe('unsupported');
    expect(await copyPng(blob, { clipboard: { write: async () => {} } })).toBe('unsupported');
    expect(await copyPng(blob, { ClipboardItem: Item, clipboard: {} })).toBe('unsupported');
    expect(copyMessage('unsupported')).toContain('下载 PNG');
  });

  it('浏览器拒绝写入：返回 failed，不抛异常', async () => {
    const env: ClipboardEnv = { ClipboardItem: Item, clipboard: { write: () => Promise.reject(new Error('NotAllowedError')) } };
    expect(await copyPng(blob, env)).toBe('failed');
    expect(copyMessage('failed')).toContain('下载 PNG');
  });
});

// ---------- 截图与导出的行为测试（GPT 审核 #39 第 1 轮 major） ----------

/** 记录绘制调用的假 2D 上下文 / 画布 */
function fakeCanvas() {
  const calls: Array<{ fn: string; args: unknown[] }> = [];
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      return (...args: unknown[]) => void calls.push({ fn: k, args });
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  });
  const canvas = { width: 0, height: 0, getContext: (kind: string) => (kind === '2d' ? (ctx as unknown as CanvasRenderingContext2D) : null) };
  return { canvas, ctx, calls };
}

describe('drawCard：卡片排版', () => {
  const s = newGame(nov(1, 8), 9);
  claimDailyGift(s, nov(1, 9));
  const vShot = { tag: 'vehicle' } as unknown as CanvasImageSource;
  const cShot = { tag: 'camp' } as unknown as CanvasImageSource;
  const draw = (d: ReturnType<typeof cardData>) => {
    const f = fakeCanvas();
    const out = drawCard(d, vShot, cShot, () => f.canvas as unknown as HTMLCanvasElement);
    return { ...f, out, texts: f.calls.filter((c) => c.fn === 'fillText').map((c) => String(c.args[0])) };
  };

  it('竖版 720 × 1440；两张截图按设定尺寸画在卡片内；四类内容都有文字', () => {
    const d = cardData(s, nov(1, 20));
    const r = draw(d);
    expect([r.out.width, r.out.height]).toEqual([CARD_W, CARD_H]);
    const imgs = r.calls.filter((c) => c.fn === 'drawImage');
    expect(imgs.map((c) => c.args[0])).toEqual([vShot, cShot]);
    expect(imgs.map((c) => c.args.slice(3))).toEqual([[SHOT_W, VEHICLE_SHOT_H], [SHOT_W, CAMP_SHOT_H]]);
    for (const c of imgs) {
      const [x, y, w, h] = c.args.slice(1) as number[];
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x + w).toBeLessThanOrEqual(CARD_W);
      expect(y + h).toBeLessThanOrEqual(CARD_H);
    }
    expect(r.texts).toEqual(expect.arrayContaining([d.game, d.date, d.vehicle.model, ...cardStats(d).flatMap((x) => [x.label, x.value])]));
  });

  it('没有里程碑时整块不画；有时逐条画出', () => {
    const d = cardData(s, nov(1, 20));
    expect(d.milestones).toEqual([]);
    expect(draw(d).texts).not.toContain('营地里程碑');
    const withM = draw({ ...d, milestones: ['连续登录 3 天', '已拥有侧边帐'] }).texts;
    expect(withM).toEqual(expect.arrayContaining(['营地里程碑', '连续登录 3 天', '已拥有侧边帐']));
  });
});

describe('takeSnapshot：截图并恢复渲染状态', () => {
  function rig(opts: { failRender?: boolean; failCtx?: boolean } = {}) {
    const fog = { tag: 'fog' };
    const scene = { fog: fog as unknown };
    const labels = [{ visible: true }, { visible: false }, { visible: true }];
    const mainCamera = { tag: 'main' };
    const shotCamera = { tag: 'shot' };
    const seen: Array<{ cam: unknown; fog: unknown; labels: boolean[]; size: [number, number]; ratio: number }> = [];
    let size: [number, number] = [1280, 720];
    let ratio = 2;
    const domElement = { tag: 'webgl' } as unknown as CanvasImageSource;
    const renderer = {
      domElement,
      getSize: (v: { x: number; y: number; set(x: number, y: number): unknown }) => (v.set(size[0], size[1]), v),
      getPixelRatio: () => ratio,
      setPixelRatio: (r: number) => void (ratio = r),
      setSize: (w: number, h: number) => void (size = [w, h]),
      render(_s: typeof scene, cam: unknown) {
        seen.push({ cam, fog: scene.fog, labels: labels.map((l) => l.visible), size: [...size], ratio });
        if (opts.failRender && cam === shotCamera) throw new Error('context lost');
      },
    };
    const f = fakeCanvas();
    if (opts.failCtx) f.canvas.getContext = () => null;
    const deps = { renderer, scene, mainCamera, labels, createCanvas: () => f.canvas };
    const after = () => ({ fog: scene.fog, labels: labels.map((l) => l.visible), size, ratio });
    return { deps, shotCamera, mainCamera, fog, seen, f, domElement, after };
  }
  const restored = (fog: unknown) => ({ fog, labels: [true, false, true], size: [1280, 720], ratio: 2 });

  it('成功：截图那一帧无雾、隐藏标牌、像素比 1、尺寸 w × h，并拷进 2D 画布；之后全部恢复并用主相机重绘', () => {
    const r = rig();
    const out = takeSnapshot(r.deps, r.shotCamera, 640, 380, { fog: false, labels: false });
    expect(out).toBe(r.f.canvas);
    expect([out.width, out.height]).toEqual([640, 380]);
    expect(r.seen[0]).toEqual({ cam: r.shotCamera, fog: null, labels: [false, false, false], size: [640, 380], ratio: 1 });
    expect(r.f.calls).toEqual([{ fn: 'drawImage', args: [r.domElement, 0, 0, 640, 380] }]);
    expect(r.seen[1]).toEqual({ cam: r.mainCamera, ...restored(r.fog) });
    expect(r.after()).toEqual(restored(r.fog));
  });

  it('默认保留雾与标牌（原本隐藏的标牌仍隐藏）', () => {
    const r = rig();
    takeSnapshot(r.deps, r.shotCamera, 640, 340);
    expect(r.seen[0]).toMatchObject({ fog: r.fog, labels: [true, false, true] });
  });

  it('渲染抛异常：照样恢复尺寸、像素比、雾与标牌，并用主相机重绘，异常继续抛出', () => {
    const r = rig({ failRender: true });
    expect(() => takeSnapshot(r.deps, r.shotCamera, 640, 380, { fog: false, labels: false })).toThrow('context lost');
    expect(r.seen.at(-1)!.cam).toBe(r.mainCamera);
    expect(r.after()).toEqual(restored(r.fog));
  });

  it('2D 画布不可用：抛异常并恢复', () => {
    const r = rig({ failCtx: true });
    expect(() => takeSnapshot(r.deps, r.shotCamera, 640, 380, { fog: false, labels: false })).toThrow();
    expect(r.after()).toEqual(restored(r.fog));
  });
});

describe('营地全景取景：整个营地在截图内', () => {
  const aspect = SHOT_W / CAMP_SHOT_H;
  const cam = campShotCamera(aspect);

  it('自算投影：8 个角点（WORLD 外扩围栏 + 门柱 / 牌子高度）都落在 NDC [-1, 1] 内', () => {
    for (const p of campFrameCorners()) {
      const n = projectNdc(cam.pos, cam.look, SNAPSHOT_FOV_DEG, aspect, p)!;
      expect(n).not.toBeNull();
      expect(Math.abs(n[0])).toBeLessThanOrEqual(1);
      expect(Math.abs(n[1])).toBeLessThanOrEqual(1);
    }
    // 南边界（含大门）与北边界都在画面里
    expect(campFrameCorners().some((p) => p[1] < WORLD.minY)).toBe(true);
  });

  it('与 three 的真实相机投影一致（同一 fov / 宽高比 / lookAt），且在远裁剪面 400 m 以内', () => {
    const c = new THREE.PerspectiveCamera(SNAPSHOT_FOV_DEG, aspect, 0.1, 400);
    c.position.copy(toThree(...cam.pos));
    c.lookAt(toThree(...cam.look));
    c.updateMatrixWorld();
    for (const p of campFrameCorners()) {
      const v = toThree(...p).project(c);
      const mine = projectNdc(cam.pos, cam.look, SNAPSHOT_FOV_DEG, aspect, p)!;
      expect(v.x).toBeCloseTo(mine[0], 6);
      expect(v.y).toBeCloseTo(mine[1], 6);
      expect(Math.abs(v.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(v.y)).toBeLessThanOrEqual(1);
      expect(v.z).toBeLessThan(1); // 在远裁剪面之内
      expect(c.position.distanceTo(toThree(...p))).toBeLessThan(400);
    }
  });

  it('取景是紧的：至少一个角点贴近画面边缘（不是退得过远把营地缩成一小块）', () => {
    const edge = Math.max(...campFrameCorners().map((p) => {
      const n = projectNdc(cam.pos, cam.look, SNAPSHOT_FOV_DEG, aspect, p)!;
      return Math.max(Math.abs(n[0]), Math.abs(n[1]));
    }));
    expect(edge).toBeGreaterThan(0.99);
  });

  it('回归：旧机位（南侧上空 85 m 看 (0,-4)）会裁掉南边界', () => {
    const n = projectNdc([0, -37, 85], [0, -4, 0], SNAPSHOT_FOV_DEG, aspect, [0, WORLD.minY, 0])!;
    expect(Math.abs(n[1])).toBeGreaterThan(1);
  });
});

describe('生成 → 预览 → 下载 / 复制', () => {
  const png = new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  function rig(opts: { blob?: Blob | null; throws?: boolean } = {}) {
    const ui = { box: { hidden: true }, img: { src: '' } };
    const log: string[] = [];
    const toasts: string[] = [];
    const anchors: Array<{ href: string; download: string; clicked: number; removed: boolean }> = [];
    let n = 0;
    let clip: ClipboardEnv = {};
    const flow = createCardFlow({
      ui,
      make() {
        if (opts.throws) throw new Error('webgl lost');
        return {
          name: 'camp-empire-2026-11-08.png',
          canvas: {
            toBlob(cb, type) {
              log.push(`toBlob:${type}`);
              cb(opts.blob === undefined ? png : opts.blob);
            },
          },
        };
      },
      createObjectURL: () => `blob:${++n}`,
      revokeObjectURL: (u) => void log.push(`revoke:${u}`),
      createAnchor() {
        const a = { href: '', download: '', clicked: 0, removed: false, click() { this.clicked++; }, remove() { this.removed = true; } };
        anchors.push(a);
        return a;
      },
      clipboard: () => clip,
      toast: (m) => void toasts.push(m),
    });
    return { flow, ui, log, toasts, anchors, setClip: (c: ClipboardEnv) => (clip = c) };
  }

  it('成功：按 image/png 导出，显示预览；下载的是同一张 PNG、文件名带日期，链接用完即移除', async () => {
    const r = rig();
    expect(await r.flow.generate()).toBe(true);
    expect(r.log).toEqual(['toBlob:image/png']);
    expect(r.ui.box.hidden).toBe(false);
    expect(r.ui.img.src).toBe('blob:1');
    expect(r.flow.shown!.blob).toBe(png);
    expect(r.flow.shown!.blob.type).toBe('image/png');
    expect(r.flow.download()).toBe(true);
    expect(r.anchors).toEqual([expect.objectContaining({ href: 'blob:1', download: 'camp-empire-2026-11-08.png', clicked: 1, removed: true })]);
  });

  it('再次生成：释放上一张的 URL，预览换成新的', async () => {
    const r = rig();
    await r.flow.generate();
    await r.flow.generate();
    expect(r.log).toContain('revoke:blob:1');
    expect(r.ui.img.src).toBe('blob:2');
  });

  it('导出失败（toBlob 给 null）或生成抛异常：提示失败，不显示预览，也不能下载', async () => {
    for (const r of [rig({ blob: null }), rig({ throws: true })]) {
      expect(await r.flow.generate()).toBe(false);
      expect(r.toasts).toEqual([CARD_FAIL_MSG]);
      expect(r.ui.box.hidden).toBe(true);
      expect(r.flow.download()).toBe(false);
      expect(r.anchors).toEqual([]);
    }
  });

  it('复制写入的是预览里那张 PNG；不支持时提示改用下载；关闭只隐藏预览', async () => {
    const r = rig();
    await r.flow.generate();
    const written: unknown[][] = [];
    class Item {
      constructor(public items: Record<string, Blob>) {}
    }
    r.setClip({ ClipboardItem: Item, clipboard: { write: async (x) => void written.push(x) } });
    expect(await r.flow.copy()).toBe(true); // 真的复制成功才计 card_export
    expect((written[0][0] as Item).items['image/png']).toBe(png);
    r.setClip({});
    expect(await r.flow.copy()).toBe(false);
    r.setClip({ ClipboardItem: Item, clipboard: { write: async () => Promise.reject(new Error('denied')) } });
    expect(await r.flow.copy()).toBe(false);
    expect(r.toasts.slice(0, 2)).toEqual([copyMessage('copied'), copyMessage('unsupported')]);
    r.flow.close();
    expect(r.ui.box.hidden).toBe(true);
    expect(r.flow.shown).not.toBeNull();
  });

  it('没生成过就不下载、不复制', async () => {
    const r = rig();
    expect(r.flow.download()).toBe(false);
    expect(await r.flow.copy()).toBe(false);
    expect(r.toasts).toEqual([]);
  });
});

describe('提示不被卡片遮挡', () => {
  const z = (sel: string) => Number(new RegExp(`${sel} \\{[^}]*?z-index: (\\d+)`).exec(css)![1]);
  it('#toast 的层级高于露营卡片与回访面板', () => {
    expect(z('#toast')).toBeGreaterThan(z('#camp-card'));
    expect(z('#toast')).toBeGreaterThan(z('#welcome'));
  });
});

describe('不自动弹出、不强制分享、无分享奖励', () => {
  it('预览框默认隐藏；页面加载时不生成卡片，只有 card 动作（玩家点“生成露营卡片”）调用生成', () => {
    expect(html).toMatch(/<div id="camp-card"[^>]*\bhidden\b/);
    expect(html).toContain('data-act="card"');
    expect(mainSrc.match(/cardFlow\.generate\(\)/g)?.length).toBe(1);
    const cardAction = mainSrc.slice(mainSrc.indexOf('async card()'), mainSrc.indexOf('cardDownload()'));
    expect(cardAction).toContain('cardFlow.generate()');
  });

  it('卡片逻辑不入账、不改状态，也没有分享渠道或回流链接', () => {
    expect(cardSrc).not.toMatch(/\bcredit\(|\bspend\(|\bdeposit\(/);
    expect(cardSrc).not.toMatch(/https?:\/\//);
    const s = newGame(nov(1, 8), 9);
    claimDailyGift(s, nov(1, 9));
    const before = JSON.stringify(s);
    cardData(s, nov(1, 20));
    expect(JSON.stringify(s)).toBe(before);
  });
});
