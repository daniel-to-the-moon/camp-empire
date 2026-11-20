import { describe, expect, it } from 'vitest';
import {
  ACT_EVENTS,
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
  uuidV4,
} from '../src/shared/analytics';
import type { StorageLike } from '../src/shared/devgate';

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

  it('按钮映射只指向白名单事件；白名单里的每个事件在隐私说明里都有写', () => {
    for (const ev of Object.values(ACT_EVENTS)) expect(EVENTS).toContain(ev);
    const text = PRIVACY_TEXT.join('');
    for (const word of ['打开游戏', '收取停车费', '购买侧边帐', '导出露营卡片', '打开车型图鉴', '开车出门']) expect(text).toContain(word);
    expect(EVENTS).toHaveLength(6);
    expect(isValidAid(UUID)).toBe(true);
  });
});
