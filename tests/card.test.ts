/**
 * 露营卡片（issue #30）：当日数据取数与游戏内记录一致、成就显示条件、存档补字段、复制到剪贴板的降级、不自动弹出。
 */
import { describe, expect, it } from 'vitest';
import mainSrc from '../src/client/main.ts?raw';
import cardSrc from '../src/shared/card.ts?raw';
import html from '../index.html?raw';
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

describe('不自动弹出、不强制分享、无分享奖励', () => {
  it('预览框默认隐藏；只有 card 动作（玩家点“生成露营卡片”）会显示它', () => {
    expect(html).toMatch(/<div id="camp-card"[^>]*\bhidden\b/);
    expect(html).toContain('data-act="card"');
    expect(mainSrc.match(/#camp-card'\)\.hidden = false/g)?.length).toBe(1);
    const cardAction = mainSrc.slice(mainSrc.indexOf('async card()'), mainSrc.indexOf('cardDownload()'));
    expect(cardAction).toContain("$('#camp-card').hidden = false");
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
