/**
 * T1 匿名统计的客户端规则（出处：docs/BUSINESS_PLAN.md T1，用户 2026-11-20 拍板）。纯函数，测试见 tests/analytics.test.ts。
 *
 * - 只发白名单里的几种事件，每条只带：随机匿名 ID、事件名、版本号。不带存档内容、金币、设备、页面地址。
 * - 匿名 ID 是浏览器本地生成的随机 UUID，与账号、设备无关；清掉网站数据就换一个新的。
 * - 玩家可在“隐私与统计”里一键关闭；关闭后不再发送任何请求。
 * - ?dev 调试入口、本机地址（开发、CI 冒烟）一律不发，避免污染统计。
 */
import type { StorageLike } from './devgate';


/** 与 functions/api/ev.js 的 EVENTS 一致（tests/analytics-endpoint.test.ts 校验） */
export const EVENTS = ['session_start', 'collect', 'buy_awning', 'card_export', 'dex_open', 'drive_out'] as const;
export type AnalyticsEvent = (typeof EVENTS)[number];

/** 界面按钮（data-act）→ 统计事件。只统计这些动作，其余按钮不发 */
export const ACT_EVENTS: Readonly<Record<string, AnalyticsEvent>> = {
  collect: 'collect',
  buy: 'buy_awning',
  cardDownload: 'card_export',
  cardCopy: 'card_export',
  dex: 'dex_open',
  out: 'drive_out',
};

export const AID_KEY = 'ce.analytics.aid';
export const OPT_OUT_KEY = 'ce.analytics.optout';
export const ENDPOINT = './api/ev';

const AID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 由 16 个随机字节拼出 UUID v4（用 crypto.getRandomValues，不依赖只在安全上下文可用的 crypto.randomUUID） */
export function uuidV4(bytes: Uint8Array): string {
  if (bytes.length !== 16) throw new Error('需要 16 个随机字节');
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function isValidAid(s: unknown): s is string {
  return typeof s === 'string' && AID_RE.test(s);
}

/** 本机地址：开发服务器与 CI 冒烟（vite preview）都在这里，不发统计 */
export function isLocalHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]' || hostname.endsWith('.localhost');
}

export function isOptedOut(storage: StorageLike | null): boolean {
  try {
    return storage?.getItem(OPT_OUT_KEY) === '1';
  } catch {
    return false;
  }
}

/** 关闭统计时顺带删掉匿名 ID；重新打开时生成新的，不与之前的记录关联 */
export function setOptOut(storage: StorageLike | null, out: boolean): void {
  try {
    if (out) {
      storage?.setItem(OPT_OUT_KEY, '1');
      storage?.removeItem(AID_KEY);
    } else {
      storage?.removeItem(OPT_OUT_KEY);
    }
  } catch {
    /* 存储不可用：本次会话按默认处理 */
  }
}

/** 取本地匿名 ID，没有或格式不对就新建；存储不可用时返回 null（不发送，不用临时 ID 充数） */
export function getOrCreateAid(storage: StorageLike | null, randomUUID: () => string): string | null {
  if (!storage) return null;
  try {
    const cur = storage.getItem(AID_KEY);
    if (isValidAid(cur)) return cur;
    const id = randomUUID().toLowerCase();
    if (!isValidAid(id)) return null;
    storage.setItem(AID_KEY, id);
    return storage.getItem(AID_KEY) === id ? id : null;
  } catch {
    return null;
  }
}

export interface SendContext {
  dev: boolean;
  hostname: string;
  storage: StorageLike | null;
}

export function shouldSend(ctx: SendContext): boolean {
  return !ctx.dev && !isLocalHost(ctx.hostname) && !isOptedOut(ctx.storage);
}

/** 版本号只取字母数字点横线、最长 40，与接收端一致 */
export function cleanVersion(v: string): string {
  const s = v.toLowerCase().replace(/[^0-9a-z.-]/g, '').slice(0, 40);
  return s || 'unknown';
}

export function payload(aid: string, ev: AnalyticsEvent, version: string): string {
  return JSON.stringify({ aid, ev, v: cleanVersion(version) });
}

/** 隐私说明（界面“隐私与统计”面板原文；改这里同时改 docs/ANALYTICS.md） */
export const PRIVACY_TEXT = [
  '为了知道有多少人在玩、第二天有多少人回来，游戏会记录几种匿名事件：打开游戏、收取停车费、购买侧边帐、导出露营卡片、打开车型图鉴、开车出门。',
  '每条记录只有：一串在你浏览器里随机生成的编号、事件名、游戏版本号，以及服务器收到的日期。不记录你的名字、联系方式、设备型号、IP 地址、存档内容或金币数。',
  '记录保存在本游戏自己的数据库里，满 180 天自动删除，只用于统计玩家数量和留存，不出售、不用于广告。',
  '你可以随时关闭。关闭后不再发送任何记录，并删除本机的随机编号；重新打开会生成新编号，与之前的记录无关。',
];
