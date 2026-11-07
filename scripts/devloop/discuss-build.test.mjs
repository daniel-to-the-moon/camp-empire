import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alreadyReviewed, buildPrompt, REVIEW_PREFIX, THREAD_LIMIT, threadText } from './discuss-build.mjs';

const issue = { number: 3, title: '讨论', body: '正文开头', labels: [{ name: 'discussion' }] };
const c = (id, body, login = 'u') => ({ id, body, user: { login }, created_at: `t${id}`, html_url: `https://x/${id}` });
const header = 'HEADER';

test('去重：已有 GPT 云端评审评论 → 首次评审跳过；只有别的评论不算', () => {
  assert.equal(alreadyReviewed([c(1, '普通'), c(2, '执行者：GPT（gpt-6-astra，经 devloop 审核')]), false);
  assert.equal(alreadyReviewed([c(1, `${REVIEW_PREFIX}，openai/codex-action）\n…`)]), true);
});

test('一次带两个讨论标签新建：两次 labeled 运行串行，第二次看到第一次的评论后跳过', () => {
  const before = [c(1, '讨论')];
  assert.equal(alreadyReviewed(before), false); // 第一次运行：评审
  const after = [...before, c(2, `${REVIEW_PREFIX}，openai/codex-action）\n结论…`)];
  assert.equal(alreadyReviewed(after), true); // 第二次运行：跳过
});

test('两条 @gpt 先后排队：各自的提示词只把各自的点名放进“本次点名”', () => {
  const comments = [c(10, '@gpt 问题 A'), c(11, '@gpt 问题 B')];
  const pa = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 10 });
  const pb = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: '11' });
  const sec = (p) => p.slice(p.indexOf('## 本次点名'), p.indexOf('## 讨论全文'));
  assert.match(sec(pa), /问题 A/);
  assert.doesNotMatch(sec(pa), /问题 B/);
  assert.match(sec(pb), /问题 B/);
  assert.doesNotMatch(sec(pb), /问题 A/);
  assert.throws(() => buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 99 }));
});

test('长讨论截断：全文截断但保留开头与最近部分；点名评论不被截掉', () => {
  const long = Array.from({ length: 400 }, (_, i) => c(i + 1, `第${i + 1}条 ${'字'.repeat(600)}`));
  const trigger = c(5000, '@gpt 这条早期点名必须回答');
  const comments = [trigger, ...long];
  const t = threadText(issue, comments);
  assert.ok(t.length <= THREAD_LIMIT + 100);
  assert.match(t, /正文开头/);
  assert.match(t, /第400条/);
  const p = buildPrompt({ header, issue, comments, mode: 'mention', triggerId: 5000 });
  assert.match(p.slice(p.indexOf('## 本次点名'), p.indexOf('## 讨论全文')), /这条早期点名必须回答/);
});

test('首次评审与手动触发没有“本次点名”一节', () => {
  for (const mode of ['first', 'manual']) assert.doesNotMatch(buildPrompt({ header, issue, comments: [c(1, 'x')], mode }), /本次点名/);
});
