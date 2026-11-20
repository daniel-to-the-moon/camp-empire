import { describe, expect, it } from 'vitest';
// @ts-expect-error functions/ 是 Cloudflare Pages Function 的纯 JS，不在 tsconfig 里
import { EVENTS as SERVER_EVENTS, onRequestPost, parseEvent, shanghaiDay } from '../functions/api/ev.js';
import { EVENTS } from '../src/shared/analytics';

const UUID = '3f2a9c1e-8b7d-4e6f-9a1b-2c3d4e5f6a7b';
const ok = JSON.stringify({ aid: UUID, ev: 'collect', v: 'abc123' });

function fakeDb() {
  const rows: unknown[][] = [];
  return {
    rows,
    prepare(sql: string) {
      return { bind: (...args: unknown[]) => ({ run: async () => rows.push([sql, ...args]) }) };
    },
  };
}
const req = (body: string, headers: Record<string, string> = {}) =>
  new Request('https://camp-empire.pages.dev/api/ev', { method: 'POST', body, headers });

describe('T1 匿名统计：接收端 /api/ev', () => {
  it('事件白名单与客户端一致', () => {
    expect(SERVER_EVENTS).toEqual([...EVENTS]);
  });

  it('只接受 { aid, ev, v } 三项且格式合法', () => {
    expect(parseEvent(ok)).toEqual({ aid: UUID, ev: 'collect', v: 'abc123' });
    const bad = [
      '',
      'not json',
      '[]',
      JSON.stringify({ aid: UUID, ev: 'collect' }),
      JSON.stringify({ aid: UUID, ev: 'collect', v: 'x', ip: '1.2.3.4' }),
      JSON.stringify({ aid: 'abc', ev: 'collect', v: 'x' }),
      JSON.stringify({ aid: UUID, ev: 'buy_gold', v: 'x' }),
      JSON.stringify({ aid: UUID, ev: 'collect', v: 'X Y' }),
      JSON.stringify({ aid: UUID, ev: 'collect', v: 'x'.repeat(600) }),
    ];
    for (const b of bad) expect(parseEvent(b), b).toBeNull();
  });

  it('合法请求写入一行：只有匿名 ID、事件、上海日、服务器时间、版本；不存请求头', async () => {
    const db = fakeDb();
    const r = await onRequestPost({ request: req(ok, { Origin: 'https://camp-empire.pages.dev', 'User-Agent': 'UA', 'CF-Connecting-IP': '1.2.3.4' }), env: { DB: db } });
    expect(r.status).toBe(204);
    expect(db.rows).toHaveLength(1);
    const [, aid, ev, day, ts, v] = db.rows[0] as [string, string, string, number, number, string];
    expect([aid, ev, v]).toEqual([UUID, 'collect', 'abc123']);
    expect(day).toBe(shanghaiDay(ts));
    expect(JSON.stringify(db.rows)).not.toMatch(/1\.2\.3\.4|UA/);
  });

  it('跨站请求 403、非法请求 400，都不写入；未绑定数据库时 204 且不存', async () => {
    const db = fakeDb();
    expect((await onRequestPost({ request: req(ok, { Origin: 'https://evil.example' }), env: { DB: db } })).status).toBe(403);
    expect((await onRequestPost({ request: req('{}'), env: { DB: db } })).status).toBe(400);
    expect(db.rows).toHaveLength(0);
    expect((await onRequestPost({ request: req(ok), env: {} })).status).toBe(204);
  });

  it('上海日界：UTC 16:00 是上海次日 0 点', () => {
    const d0 = Date.UTC(2026, 10, 20, 15, 59, 59);
    const d1 = Date.UTC(2026, 10, 20, 16, 0, 0);
    expect(shanghaiDay(d1) - shanghaiDay(d0)).toBe(1);
  });
});
