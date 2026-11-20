import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { claudePrompt, combineReviews, extractClaude } from './combine-review.mjs';
import { validateReview } from './review-format.mjs';

const approve = { verdict: 'approve', summary: '没问题', findings: [] };
const minor = { severity: 'minor', file: 'a.ts', line: 3, issue: '命名', suggestion: '改名' };
const major = { severity: 'major', file: 'b.ts', line: 9, issue: '缺测试', suggestion: '补测试' };

test('combineReviews：两方都通过才通过', () => {
  assert.equal(combineReviews(approve, approve).verdict, 'approve');
  const withMinor = { ...approve, findings: [minor] };
  assert.equal(combineReviews(withMinor, approve).verdict, 'approve');
});

test('combineReviews：任一方需修改即需修改，意见带来源', () => {
  const rc = { verdict: 'request_changes', summary: '缺测试', findings: [major] };
  for (const [g, c] of [[rc, approve], [approve, rc], [rc, rc]]) {
    const m = combineReviews(g, c);
    assert.equal(m.verdict, 'request_changes');
    assert.equal(validateReview(m), '');
  }
  const m = combineReviews({ ...approve, findings: [minor] }, rc);
  assert.deepEqual(m.findings.map((f) => f.issue), ['[GPT] 命名', '[Claude] 缺测试']);
  assert.match(m.summary, /^GPT（通过）：没问题\n\nClaude（需修改）：缺测试$/);
});

test('combineReviews：不合法的结论直接抛错，不会被当成通过', () => {
  assert.throws(() => combineReviews(approve, { verdict: 'approve', summary: 'x' }), /Claude 结论不合法/);
  assert.throws(() => combineReviews({ verdict: 'lgtm', summary: '', findings: [] }, approve), /GPT 结论不合法/);
});

test('extractClaude：取 structured_output；失败、缺失、不合法都抛错', () => {
  const ok = { type: 'result', subtype: 'success', is_error: false, structured_output: approve };
  assert.deepEqual(extractClaude(JSON.stringify(ok)), approve);
  // 没有 structured_output 时退回解析 result 文本
  assert.deepEqual(extractClaude(JSON.stringify({ subtype: 'success', result: JSON.stringify(approve) })), approve);
  assert.throws(() => extractClaude('not json'), /不是 JSON/);
  assert.throws(() => extractClaude(JSON.stringify({ subtype: 'error_max_turns', is_error: true })), /未成功：error_max_turns/);
  assert.throws(() => extractClaude(JSON.stringify({ subtype: 'success', result: '我觉得可以' })), /没有给出结构化结论/);
  assert.throws(() => extractClaude(JSON.stringify({ subtype: 'success', structured_output: { verdict: 'approve' } })), /不合法/);
});

test('claudePrompt：基于真实的审核提示词改身份，保留全部必查项', () => {
  const gpt = readFileSync(new URL('./review-prompt.md', import.meta.url), 'utf8');
  const p = claudePrompt(gpt);
  assert.match(p.split('\n')[0], /第二审核方 Claude/);
  assert.ok(!p.split('\n')[0].includes('审核方 GPT'));
  for (const line of gpt.split('\n').slice(1)) assert.ok(p.includes(line), `缺少：${line}`);
  assert.match(p, /验收标准/);
  assert.throws(() => claudePrompt('别的格式'), /找不到/);
});
