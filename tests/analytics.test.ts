import { describe, expect, it } from 'vitest';
import {
  AID_KEY,
  cleanVersion,
  EVENTS,
  getOrCreateAid,
  isLocalHost,
  isOptedOut,
  isValidAid,
  OPT_OUT_KEY,
  payload,
  PRIVACY_TEXT,
  setOptOut,
  shouldSend,
  successEvent,
  uuidV4,
} from '../src/shared/analytics';
import type { StorageLike } from '../src/shared/devgate';
import mainSrc from '../src/client/main.ts?raw';
import { dayKey } from '../src/shared/ledger';
import { buyAwning, claimDailyGift, collectPending, newGame } from '../src/shared/state';

class Mem implements StorageLike {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}
const UUID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';

describe('T1 匿名统计：客户端规则', () => {
  it('匿名 ID：首次生成并保存，之后复用；格式不对就重建；存储不可用不发', () => {
    const s = new Mem();
    expect(getOrCreateAid(s, () => UUID)).toBe(UUID);
    expect(getOrCreateAid(s, () => 'should-not-be-used')).toBe(UUID);
    s.setItem(AID_KEY, 'garbage');
    expect(getOrCreateAid(s, () => UUID.toUpperCase())).toBe(UUID);
    expect(getOrCreateAid(null, () => UUID)).toBeNull();
    expect(getOrCreateAid(new Mem(), () => 'not-a-uuid')).toBeNull();
    const broken: StorageLike = { getItem: () => { throw new Error('denied'); }, setItem: () => {}, removeItem: () => {} };
    expect(getOrCreateAid(broken, () => UUID)).toBeNull();
  });

  it('关闭统计：不再发送，并删除本机匿名 ID；重新开启后是新 ID', () => {
    const s = new Mem();
    getOrCreateAid(s, () => UUID);
    const ctx = { dev: false, hostname: 'camp-empire.pages.dev', storage: s };
    expect(shouldSend(ctx)).toBe(true);
    setOptOut(s, true);
    expect(isOptedOut(s)).toBe(true);
    expect(s.getItem(AID_KEY)).toBeNull();
    expect(shouldSend(ctx)).toBe(false);
    setOptOut(s, false);
    expect(s.getItem(OPT_OUT_KEY)).toBeNull();
    expect(shouldSend(ctx)).toBe(true);
    expect(getOrCreateAid(s, () => '11111111-1111-4111-8111-111111111111')).not.toBe(UUID);
  });

  it('关闭时存储写入失败（如已满）：仍删掉匿名 ID、报告未保存，本次会话按关闭处理', () => {
    const s = new Mem();
    getOrCreateAid(s, () => UUID);
    const full: StorageLike = {
      getItem: (k) => s.getItem(k),
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: (k) => s.removeItem(k),
    };
    expect(setOptOut(full, true)).toBe(false);
    expect(s.getItem(AID_KEY)).toBeNull();
    const ctx = { dev: false, hostname: 'camp-empire.pages.dev', storage: full };
    expect(shouldSend({ ...ctx, sessionOptOut: true })).toBe(false);
    expect(setOptOut(s, true)).toBe(true);
    expect(setOptOut(null, true)).toBe(false);
  });

  it('调试入口与本机地址（开发、CI 冒烟）一律不发', () => {
    const s = new Mem();
    expect(shouldSend({ dev: true, hostname: 'camp-empire.pages.dev', storage: s })).toBe(false);
    for (const h of ['localhost', '127.0.0.1', '[::1]', 'a.localhost']) {
      expect(isLocalHost(h)).toBe(true);
      expect(shouldSend({ dev: false, hostname: h, storage: s })).toBe(false);
    }
    expect(isLocalHost('camp-empire.pages.dev')).toBe(false);
  });

  it('uuidV4：由随机字节生成合法的 v4 UUID，版本与变体位正确', () => {
    expect(uuidV4(new Uint8Array(16))).toBe('00000000-0000-4000-8000-000000000000');
    expect(uuidV4(new Uint8Array(16).fill(255))).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    for (let i = 0; i < 50; i++) expect(isValidAid(uuidV4(crypto.getRandomValues(new Uint8Array(16))))).toBe(true);
    expect(() => uuidV4(new Uint8Array(15))).toThrow();
  });

  it('请求体只有匿名 ID、事件名、版本号三项', () => {
    const body = JSON.parse(payload(UUID, 'collect', 'ABCdef123456 x'));
    expect(Object.keys(body).sort()).toEqual(['aid', 'ev', 'v']);
    expect(body).toEqual({ aid: UUID, ev: 'collect', v: 'abcdef123456x' });
    expect(cleanVersion('')).toBe('unknown');
    expect(cleanVersion('x'.repeat(60))).toHaveLength(40);
  });

  it('白名单里的每个事件在隐私说明里都有写', () => {
    const text = PRIVACY_TEXT.join('');
    for (const word of ['打开游戏', '收取停车费', '购买侧边帐', '导出露营卡片', '打开车型图鉴', '开车出门']) expect(text).toContain(word);
    expect(EVENTS).toHaveLength(6);
    expect(isValidAid(UUID)).toBe(true);
  });
});

// GPT 审核 #66 第 2 轮：点了按钮不算，操作确认成功才上报
describe('统计只在操作成功后上报', () => {
  const nov = (d: number, hour = 10) => Date.UTC(2026, 10, d, hour - 8);

  it('收取：有停车费且提交成功才算；池空（重复点击的第二次）、只读或提交失败（null）都不算', () => {
    const s = newGame(nov(5, 8), 17);
    claimDailyGift(s, nov(5, 8));
    claimDailyGift(s, nov(5, 20)); // 回放 12 小时，停车费进池
    expect(s.ledger.pending.gross).toBeGreaterThan(0);
    const first = collectPending(s, nov(5, 20));
    const second = collectPending(s, nov(5, 20));
    expect([first, second].map(successEvent.collect)).toEqual(['collect', null]);
    expect(successEvent.collect(null)).toBeNull();
    expect(successEvent.collect(undefined)).toBeNull();
  });

  it('购买侧边帐：买成功才算；钱不够、已经买过（重复点击）、只读或提交失败都不算', () => {
    const poor = newGame(nov(1, 8), 9);
    poor.ledger.balance = 0;
    expect(successEvent.buy(buyAwning(poor, nov(1, 9)))).toBeNull(); // 金币不足
    const s = newGame(nov(1, 8), 9);
    s.ledger.balance += 1_000_000;
    s.ledger.entries.push({ key: 't', atMs: nov(1, 9), day: dayKey(nov(1, 9)), kind: 'start', gross: 1_000_000, amount: 1_000_000, note: 't' });
    expect(successEvent.buy(buyAwning(s, nov(1, 10)))).toBe('buy_awning');
    expect(successEvent.buy(buyAwning(s, nov(1, 11)))).toBeNull(); // 已拥有
    expect(successEvent.buy(null)).toBeNull();
  });

  it('卡片导出、图鉴、出门：只认真正发生的那次', () => {
    expect(successEvent.cardExport(true)).toBe('card_export');
    expect(successEvent.cardExport(false)).toBeNull();
    expect(successEvent.dexOpen(true)).toBe('dex_open');
    expect(successEvent.dexOpen(false)).toBeNull(); // 已经开着
    expect(successEvent.driveOut(true)).toBe('drive_out');
    expect(successEvent.driveOut(false)).toBeNull();
  });

  it('main.ts：点击处理器不直接上报；每个事件都经 successEvent 判定', () => {
    const src = mainSrc;
    const click = src.slice(src.indexOf("document.addEventListener('click'"), src.indexOf('// ---------- 键盘'));
    expect(click).not.toMatch(/track\(/);
    const calls = [...src.matchAll(/track\(([^;]*)\);/g)].map((m) => m[1]);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c === "'session_start'" || c.startsWith('successEvent.')).toBe(true);
    for (const k of ['collect', 'buy', 'cardExport', 'dexOpen', 'driveOut']) expect(src).toContain(`successEvent.${k}(`);
  });
});
