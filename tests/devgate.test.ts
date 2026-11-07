/**
 * 调试入口（GPT 审核 #4 第 2 轮第 2 条）：普通入口不展示、也不能执行快进与重开存档；?dev 入口可以。
 * 测试环境没有浏览器渲染，界面部分检查 index.html 与 style.css 的静态约束（#dev 默认 hidden，且 hidden 不会被 display 覆盖）。
 */
import { describe, expect, it } from 'vitest';
import html from '../index.html?raw';
import main from '../src/client/main.ts?raw';
import { devCommand, isDevEntry } from '../src/shared/devgate';
import css from '../src/style.css?raw';

describe('入口识别', () => {
  it('只有带 dev 参数的地址是调试入口', () => {
    expect(isDevEntry('')).toBe(false);
    expect(isDevEntry('?foo=1')).toBe(false);
    expect(isDevEntry('?developer=1')).toBe(false);
    expect(isDevEntry('?dev')).toBe(true);
    expect(isDevEntry('?a=1&dev=1')).toBe(true);
  });
});

describe('调试动作闸门', () => {
  it('普通入口：快进与重开存档都被拒绝（即使是写者）', () => {
    for (const arg of ['3600000', '43200000', '86400000', 'reset']) {
      expect(devCommand(false, true, arg).kind).toBe('denied');
    }
  });

  it('?dev 入口的写者：可以快进和重开', () => {
    expect(devCommand(true, true, '3600000')).toEqual({ kind: 'forward', ms: 3600000 });
    expect(devCommand(true, true, 'reset')).toEqual({ kind: 'reset' });
  });

  it('?dev 入口的只读页、以及非法参数：拒绝', () => {
    expect(devCommand(true, false, '3600000').kind).toBe('denied');
    expect(devCommand(true, false, 'reset').kind).toBe('denied');
    for (const bad of ['', 'abc', '-3600000', '0', 'Infinity']) expect(devCommand(true, true, bad).kind).toBe('denied');
  });

  it('main.ts 的 dev 动作经过闸门，且只有 ?dev 入口才取消面板的 hidden', () => {
    const dev = main.slice(main.indexOf('async dev(arg)'));
    expect(dev.indexOf('devCommand(DEV, writer, arg)')).toBeGreaterThan(0);
    expect(dev.indexOf('devCommand(DEV')).toBeLessThan(dev.indexOf('devClock.forward('));
    expect(main).toMatch(/if \(DEV\) \{\s*\$\('#dev'\)\.hidden = false;/);
    expect(main.match(/#dev'\)\.hidden/g)).toHaveLength(1);
  });
});

describe('普通入口不展示调试面板', () => {
  it('index.html 里 #dev 默认带 hidden', () => {
    expect(html).toMatch(/<div id="dev" hidden>/);
  });

  it('style.css 有全局 [hidden] { display: none !important }，#dev 的 display:flex 不能覆盖它', () => {
    expect(css).toMatch(/(^|\n)\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/);
    // #dev 自身设置了 display，必须靠上面的 !important 规则压住
    expect(css).toMatch(/#dev\s*\{[^}]*display:\s*flex/);
  });
});
