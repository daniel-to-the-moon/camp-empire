/**
 * 收起式控制面板与首次快捷键引导（hudnav.ts）：抽屉开合、罗盘指针最短转向、引导只自动弹一次、引导里的按键与实际键位一致。
 */
import { describe, expect, it } from 'vitest';
import { compassAngle, DRAWERS, Drawers, GUIDE_KEY, guideSeen, isDrawerTab, isGuideKey, markGuideSeen, needleTurn, SHORTCUTS } from '../src/shared/hudnav';
import mainSrc from '../src/client/main.ts?raw';
import hudSrc from '../src/client/hud.ts?raw';
import { VIEWS, viewForKey } from '../src/shared/camview';
import html from '../index.html?raw';



describe('抽屉', () => {
  it('点图标打开，再点收起；同侧只开一个，两侧互不影响', () => {
    const d = new Drawers();
    expect(d.toggle('garage')).toBe(true);
    expect(d.toggle('pending')).toBe(true);
    expect(d.open).toEqual({ left: 'garage', right: 'pending' });
    expect(d.toggle('shop')).toBe(true);
    expect(d.isOpen('garage')).toBe(false);
    expect(d.toggle('shop')).toBe(false);
    expect(d.open).toEqual({ left: null, right: 'pending' });
  });
  it('窄屏互斥：打开一侧时收起另一侧', () => {
    const d = new Drawers();
    d.toggle('garage');
    d.toggle('daily', true);
    expect(d.open).toEqual({ left: null, right: 'daily' });
  });
  it('Esc 收起全部，并告诉调用方是否真的收了东西', () => {
    const d = new Drawers();
    expect(d.closeAll()).toBe(false);
    d.toggle('log');
    expect(d.closeAll()).toBe(true);
    expect(d.open).toEqual({ left: null, right: null });
  });
  it('每个抽屉页签在 index.html 里都有对应的 section，并放在正确一侧', () => {
    for (const [tab, { side }] of Object.entries(DRAWERS)) {
      const aside = html.slice(html.indexOf(`id="drawer-${side}"`), html.indexOf('</aside>', html.indexOf(`id="drawer-${side}"`)));
      expect(aside, tab).toContain(`data-tab="${tab}"`);
    }
    expect(isDrawerTab('garage')).toBe(true);
    expect(isDrawerTab('toString')).toBe(false);
  });
  it('原有面板的节点 id 都还在（功能只是收进抽屉，没有删）', () => {
    for (const id of ['garage', 'shop', 'pending', 'spots', 'daily', 'log', 'views', 'speed', 'controls']) expect(html).toContain(`id="${id}"`);
  });
});

describe('罗盘', () => {
  it('四个视图依次在 北 / 东 / 南 / 西', () => {
    expect(VIEWS.map(compassAngle)).toEqual([0, 90, 180, 270]);
  });
  it('指针走最短的一边：西 → 北是 +90°，不倒转 270°', () => {
    expect(needleTurn(270, 'overview')).toBe(360);
    expect(needleTurn(0, 'hood')).toBe(-90);
    expect(needleTurn(0, 'orbit')).toBe(180);
    expect(needleTurn(360, 'follow')).toBe(450);
    expect(needleTurn(-90, 'overview')).toBe(0);
  });
});

describe('罗盘连切（转动途中又换视图）', () => {
  it('同一帧内连按 3、4：指针还在北（0°），直接向西转 90°，不向东绕 270°', () => {
    expect(needleTurn(0, 'orbit')).toBe(180);
    // 起点用指针实际显示的角度（还是 0°），不是上一个目标 180°
    expect(needleTurn(0, 'hood')).toBe(-90);
  });
  it('转到一半（累计 100°）再按 4：从 100° 走最短弧到西（270°），转 170° 而不是 190°', () => {
    expect(needleTurn(100, 'hood')).toBe(270);
    expect(needleTurn(80, 'hood')).toBe(-90);
  });
  it('累计角度很大时也走最短弧', () => {
    expect(needleTurn(725, 'overview')).toBe(720);
    expect(needleTurn(-445, 'orbit')).toBe(-540);
  });
});

describe('首次快捷键引导', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it('没看过就弹，关掉后记下，下次不再自动弹', () => {
    const p = mem();
    expect(guideSeen(p)).toBe(false);
    expect(markGuideSeen(p)).toBe(true);
    expect(p.m.get(GUIDE_KEY)).toBe('1');
    expect(guideSeen(p)).toBe(true);
  });
  it('存储不可用或抛错：照样弹，不报错', () => {
    const bad = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    expect(guideSeen(null)).toBe(false);
    expect(guideSeen(bad)).toBe(false);
    expect(markGuideSeen(bad)).toBe(false);
    expect(markGuideSeen(null)).toBe(false);
  });
  it('H 或 ? 重新打开', () => {
    expect(isGuideKey({ code: 'KeyH', key: 'h' })).toBe(true);
    expect(isGuideKey({ code: 'Slash', key: '?' })).toBe(true);
    expect(isGuideKey({ code: 'Slash', key: '/' })).toBe(false);
  });
  it('引导里的每个按键都真的由 main.ts 的键盘处理（或驾驶键表）响应', () => {
    const NOT_KEYS = new Set(['拖拽', '滚轮', '双指', '点图标']);
    const codeFor = (k: string): string => {
      if (/^\d$/.test(k)) return `Digit${k}`;
      if (/^[A-Z]$/.test(k)) return `Key${k}`;
      return ({ 空格: 'Space', Shift: 'ShiftLeft', Esc: 'Escape' } as Record<string, string>)[k] ?? k;
    };
    const handled = (code: string) => {
      if (code === '?') return isGuideKey({ code: 'Slash', key: '?' });
      if (code === 'KeyH') return isGuideKey({ code, key: 'h' });
      if (/^Digit[1-4]$|^Key[VC]$/.test(code)) return viewForKey(code, 'overview') !== null;
      return mainSrc.includes(`'${code}'`);
    };
    const keys = SHORTCUTS.flatMap((g) => g.rows.flatMap((r) => r.keys)).filter((k) => !NOT_KEYS.has(k));
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(handled(codeFor(k)), `引导里的 ${k}`).toBe(true);
    // 拖拽 / 滚轮 / 双指 对应场景画面上的手势监听
    expect(mainSrc).toMatch(/stage\.addEventListener\(\s*'wheel'/);
    expect(mainSrc).toContain("stage.addEventListener('pointerdown'");
  });

  it('标题不做没有依据的时长承诺（CHARTER 证据规则）', () => {
    expect(hudSrc).not.toMatch(/\d+\s*秒/);
  });

  it('引导里写的镜头键和实际键位一致', () => {
    const cam = SHORTCUTS.find((g) => g.title === '镜头')!;
    expect(cam.rows[0].keys).toEqual(['1', '2', '3', '4']);
    expect(['Digit1', 'Digit2', 'Digit3', 'Digit4'].map((c) => viewForKey(c, 'overview'))).toEqual([...VIEWS]);
    expect(viewForKey('KeyV', 'overview')).toBe('next');
    expect(viewForKey('KeyC', 'overview')).toBe('follow');
    // H 没有被镜头占用
    expect(viewForKey('KeyH', 'overview')).toBeNull();
  });
});
