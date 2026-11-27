/**
 * 收起式控制面板与首次快捷键引导（hudnav.ts）：抽屉开合、罗盘指针最短转向、引导只自动弹一次、引导里的按键与实际键位一致。
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { cameraHeading, dialTurn, DRAWERS, Drawers, GUIDE_KEY, guideSeen, isDrawerTab, isGuideKey, isMenuKey, markGuideSeen, polar, RING_ITEMS, ringSectors, sectorPath, SHORTCUTS } from '../src/shared/hudnav';
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

describe('罗盘实时朝向', () => {
  /** 镜头放在 pos、看向 look 时的朝向四元数（和 scene.ts 一样用 lookAt） */
  const cam = (pos: [number, number, number], look: [number, number, number]) => {
    const c = new THREE.PerspectiveCamera();
    c.position.set(...pos);
    c.lookAt(...look);
    return c.quaternion;
  };
  it('斜着看：画面朝北（−Z）是 0°、朝东（+X）是 90°、朝南 180°、朝西 270°', () => {
    expect(cameraHeading(cam([0, 5, 10], [0, 0, 0]))).toBeCloseTo(0);
    expect(cameraHeading(cam([-10, 5, 0], [0, 0, 0]))).toBeCloseTo(90);
    expect(cameraHeading(cam([0, 5, -10], [0, 0, 0]))).toBeCloseTo(180);
    expect(cameraHeading(cam([10, 5, 0], [0, 0, 0]))).toBeCloseTo(270);
  });
  it('环绕一圈：朝向随镜头连续变化', () => {
    for (let a = 0; a < 360; a += 30) {
      const r = (a * Math.PI) / 180;
      // 镜头在目标的 a+180° 方向，看向目标：画面朝向 a
      const h = cameraHeading(cam([-Math.sin(r) * 10, 6, Math.cos(r) * 10], [0, 0, 0]))!;
      expect(Math.abs(((h - a + 540) % 360) - 180)).toBeLessThan(0.01);
    }
  });
  it('几乎正俯视：改用画面上方在地面的方向，不会乱跳', () => {
    const c = new THREE.PerspectiveCamera();
    c.position.set(0, 40, 0);
    c.up.set(1, 0, 0); // 画面上方朝东
    c.lookAt(0, 0, 0);
    expect(cameraHeading(c.quaternion)).toBeCloseTo(90);
  });
  it('盘面转到 −朝向，走最短弧：跨过正北不倒转一圈', () => {
    expect(dialTurn(0, 90)).toBe(-90);
    expect(dialTurn(-350, 10)).toBe(-370); // 盘面在 −350°（朝向 350°），朝向转到 10°：只再转 −20°
    expect(dialTurn(-10, 350)).toBe(10); // 朝向从 10° 转到 350°：盘面 +20°
    expect(dialTurn(720, 0)).toBe(720);
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
    const NOT_KEYS = new Set(['拖拽', '滚轮', '双指', '点菜单']);
    const codeFor = (k: string): string => {
      if (/^\d$/.test(k)) return `Digit${k}`;
      if (/^[A-Z]$/.test(k)) return `Key${k}`;
      return ({ 空格: 'Space', Shift: 'ShiftLeft', Esc: 'Escape' } as Record<string, string>)[k] ?? k;
    };
    const handled = (code: string) => {
      if (code === '?') return isGuideKey({ code: 'Slash', key: '?' });
      if (code === 'KeyH') return isGuideKey({ code, key: 'h' });
      if (code === 'KeyM') return isMenuKey({ code }) && mainSrc.includes('isMenuKey(e)');
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

describe('圆形菜单', () => {
  it('外圈收齐视图以外的全部功能：每个抽屉和卡片 / 图鉴 / 隐私各一格，不重复', () => {
    const tabs = RING_ITEMS.filter((i) => i.tab).map((i) => i.tab);
    expect(new Set(tabs)).toEqual(new Set(Object.keys(DRAWERS)));
    expect(tabs).toHaveLength(Object.keys(DRAWERS).length);
    expect(RING_ITEMS.filter((i) => i.act).map((i) => i.act).sort()).toEqual(['card', 'dex', 'privacy']);
  });
  it('扇区平均分、首格以正北为中线、首尾相接铺满一圈', () => {
    const s = ringSectors(9);
    expect(s[0]).toEqual({ from: -20, to: 20, mid: 0 });
    for (let i = 1; i < s.length; i++) {
      expect(s[i].from).toBeCloseTo(s[i - 1].to);
      expect(s[i].to - s[i].from).toBeCloseTo(40);
    }
    expect(s[8].to - s[0].from).toBeCloseTo(360);
    expect(ringSectors(4).map((x) => x.mid)).toEqual([0, 90, 180, 270]);
  });
  it('极坐标：0° 在正上方、90° 在右侧', () => {
    const [x0, y0] = polar(100, 100, 50, 0);
    expect([x0, y0].map(Math.round)).toEqual([100, 50]);
    const [x1, y1] = polar(100, 100, 50, 90);
    expect([x1, y1].map(Math.round)).toEqual([150, 100]);
  });
  it('扇区路径是闭合的圆环片', () => {
    const d = sectorPath(200, 200, 100, 190, ringSectors(9)[0]);
    expect(d).toMatch(/^M[\d. -]+A190 190 0 0 1 [\d. -]+L[\d. -]+A100 100 0 0 0 [\d. -]+Z$/);
  });
  it('M 键开合菜单', () => {
    expect(isMenuKey({ code: 'KeyM' })).toBe(true);
    expect(isMenuKey({ code: 'KeyN' })).toBe(false);
  });
});
