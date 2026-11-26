// 性能验收（scripts/e2e/gates-lib.mjs）的统计与预算判定
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { checkBudgets, perfTable, summarize } from '../e2e/gates-lib.mjs';

const frames = (n, calls, tris = 100) => Array.from({ length: n }, (_, i) => ({ calls, tris, ms: i ? 16 : 0 }));

test('summarize：中位数、最大值；第一帧不计帧时间', () => {
  const s = summarize([...frames(30, 10), ...frames(31, 20, 300)]);
  assert.equal(s.frames, 61);
  assert.equal(s.callsMedian, 20);
  assert.equal(s.callsMax, 20);
  assert.equal(s.trisMax, 300);
  assert.equal(s.msMedian, 16);
  assert.deepEqual(summarize([]), { frames: 0, callsMedian: 0, callsMax: 0, trisMedian: 0, trisMax: 0, msMedian: 0 });
});

test('CI 摘要列本次采样，不用预算或零值补缺失的场景与帧时间', () => {
  const camp = summarize([...frames(32, 10), ...frames(30, 20, 300)]);
  assert.ok(perfTable({ camp }).includes('| camp | 62 | 10 / 20 | 100 | 16 |'));
  assert.ok(perfTable({ camp }).includes('| driving | 未采到 | — | — | — |'));
  assert.ok(perfTable({ driving: summarize(frames(1, 7)) }).includes('| driving | 1 | 7 / 7 | 100 | — |'));
});

test('checkBudgets：超预算、缺场景、帧数不足、0 draw call 都失败', () => {
  const budgets = { scenes: { camp: { callsMedian: 100, callsMax: 120 }, driving: { trisMedian: 1000 } } };
  assert.deepEqual(checkBudgets({ camp: summarize(frames(60, 97)), driving: summarize(frames(60, 50, 900)) }, budgets), []);
  assert.match(checkBudgets({ camp: summarize(frames(60, 101)), driving: summarize(frames(60, 50)) }, budgets).join(), /camp 的 callsMedian = 101，超出预算 100/);
  assert.match(checkBudgets({ camp: summarize(frames(60, 97)) }, budgets).join(), /driving 没有采到数据/);
  assert.match(checkBudgets({ camp: summarize(frames(10, 97)), driving: summarize(frames(60, 1)) }, budgets).join(), /只采到 10 帧/);
  assert.match(checkBudgets({ camp: summarize(frames(60, 0)), driving: summarize(frames(60, 1)) }, budgets).join(), /没有任何 draw call/);
});

test('budgets.json：两个固定场景都有预算，且不低于记录的基线', () => {
  const b = JSON.parse(readFileSync(new URL('../e2e/budgets.json', import.meta.url), 'utf8'));
  assert.ok(b.scenes.camp.callsMedian >= 97 && b.scenes.driving.callsMedian >= 51);
});
