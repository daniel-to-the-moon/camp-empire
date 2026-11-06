// node --test scripts/devloop/
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decide, marker, MAX_ROUNDS, parseMarkers, roundsUsed, shouldReview } from './policy.mjs';

const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const ok = { verdict: 'approve', findings: [] };
const minorOnly = { verdict: 'approve', findings: [{ severity: 'minor' }] };
const major = { verdict: 'approve', findings: [{ severity: 'major' }] };
const reject = { verdict: 'request_changes', findings: [] };
const now = { labels: [], base: B, mergeable: 'MERGEABLE' };
const ciOk = { status: 'ok', base: B };
const base = { ci: ciOk, review: ok, now, roundsBefore: 0, allowMerge: true };

test('全部通过才合并；只有 minor 也可合并', () => {
  assert.equal(decide(base).merge, true);
  assert.equal(decide({ ...base, review: minorOnly }).merge, true);
});

test('approve 但带 major 视为未通过', () => {
  assert.equal(decide({ ...base, review: major }).state, 'changes');
});

test('测试失败、GPT 拒绝、冲突都进入 changes', () => {
  assert.equal(decide({ ...base, ci: { status: 'failed', base: B } }).state, 'changes');
  assert.equal(decide({ ...base, review: reject }).state, 'changes');
  assert.equal(decide({ ...base, now: { ...now, mergeable: 'CONFLICTING' } }).state, 'changes');
});

test('合并前一刻出现 hold / needs-user 标签：不合并，可重试', () => {
  for (const l of ['hold', 'needs-user']) {
    const d = decide({ ...base, now: { ...now, labels: [l] } });
    assert.equal(d.merge, false);
    assert.equal(d.state, 'retry');
  }
});

test('测试之后 main 变了：不合并（测试结果不代表合并后的代码）', () => {
  const d = decide({ ...base, now: { ...now, base: 'c'.repeat(40) } });
  assert.equal(d.merge, false);
  assert.equal(d.state, 'retry');
});

test('CI 基础设施出错、--no-merge：retry，不消耗轮次', () => {
  assert.equal(decide({ ...base, ci: { status: 'error', base: null } }).state, 'retry');
  assert.equal(decide({ ...base, allowMerge: false }).state, 'retry');
});

test(`第 ${MAX_ROUNDS} 轮仍未通过：stopped + needs-user`, () => {
  const d = decide({ ...base, review: reject, roundsBefore: MAX_ROUNDS - 1 });
  assert.equal(d.state, 'stopped');
  assert.equal(d.addLabel, 'needs-user');
});

test('shouldReview：终态 head 不再审；retry 的 head 会重审；暂停标签跳过', () => {
  const body = (s, h = H) => `审核意见…\n${marker(s, h, B)}`;
  assert.equal(shouldReview({ head: H, labels: [], bodies: [] }), true);
  for (const s of ['changes', 'merged', 'stopped']) assert.equal(shouldReview({ head: H, labels: [], bodies: [body(s)] }), false);
  assert.equal(shouldReview({ head: H, labels: [], bodies: [body('retry')] }), true);
  assert.equal(shouldReview({ head: H, labels: [], bodies: [body('changes', 'd'.repeat(40))] }), true);
  assert.equal(shouldReview({ head: H, labels: ['hold'], bodies: [] }), false);
});

test('轮次按不同 head 的 changes 计数；标记可解析', () => {
  const bodies = [marker('changes', H, B), marker('changes', H, B), marker('retry', 'e'.repeat(40), B), marker('changes', 'f'.repeat(40), B)];
  assert.equal(roundsUsed(bodies), 2);
  assert.deepEqual(parseMarkers([marker('merged', H, B)]), [{ state: 'merged', head: H, base: B }]);
});
