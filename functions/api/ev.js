// T1 匿名统计的接收端（Cloudflare Pages Function，路径 /api/ev）。出处：docs/BUSINESS_PLAN.md T1，用户 2026-11-20 拍板。
// 只收白名单里的事件名与随机匿名 ID；不读、不存 IP、User-Agent、Referer 等任何请求元数据。
// D1 绑定名 DB；未绑定（统计开关未开）时直接 204，什么都不存。测试：tests/analytics-endpoint.test.ts。

/** 与 src/shared/analytics.ts 的 EVENTS 保持一致（测试校验） */
export const EVENTS = ['session_start', 'collect', 'buy_awning', 'card_export', 'dex_open', 'drive_out'];
const AID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const VER = /^[0-9a-z.-]{1,40}$/;
const MAX_BODY = 512;
const DAY_MS = 86_400_000;
const SHANGHAI_OFFSET_MS = 8 * 3_600_000;

/** 上海日序号（自 1970-01-01 上海 0 点起的天数），与游戏日界一致 */
export function shanghaiDay(ms) {
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS);
}

/** 校验请求体，合法时返回 { aid, ev, v }，否则返回 null */
export function parseEvent(text) {
  if (typeof text !== 'string' || text.length === 0 || text.length > MAX_BODY) return null;
  let o;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const keys = Object.keys(o);
  if (keys.length !== 3 || !['aid', 'ev', 'v'].every((k) => keys.includes(k))) return null;
  if (typeof o.aid !== 'string' || !AID.test(o.aid)) return null;
  if (typeof o.ev !== 'string' || !EVENTS.includes(o.ev)) return null;
  if (typeof o.v !== 'string' || !VER.test(o.v)) return null;
  return { aid: o.aid, ev: o.ev, v: o.v };
}

const empty = (status) => new Response(null, { status });

export async function onRequestPost({ request, env }) {
  // 只接受本站页面发来的请求（浏览器跨站请求会带 Origin）
  const origin = request.headers.get('Origin');
  if (origin) {
    let ok = false;
    try {
      ok = new URL(origin).host === new URL(request.url).host;
    } catch {
      ok = false;
    }
    if (!ok) return empty(403);
  }
  const text = await request.text();
  const e = parseEvent(text);
  if (!e) return empty(400);
  if (!env.DB) return empty(204);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO events (aid, ev, day, ts, v) VALUES (?1, ?2, ?3, ?4, ?5)')
    .bind(e.aid, e.ev, shanghaiDay(now), now, e.v)
    .run();
  return empty(204);
}
