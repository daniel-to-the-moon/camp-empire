/**
 * 收起式控制面板与首次快捷键引导（hudnav.ts）：抽屉开合、罗盘指针最短转向、引导只自动弹一次、引导里的按键与实际键位一致。
 */
import { describe, expect, it } from 'vitest';
import { compassAngle, DRAWERS, Drawers, GUIDE_KEY, guideSeen, isDrawerTab, isGuideKey, markGuideSeen, needleTurn, SHORTCUTS } from '../src/shared/hudnav';
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
