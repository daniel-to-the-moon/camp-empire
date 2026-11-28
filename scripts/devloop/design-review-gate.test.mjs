import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gate } from './design-review-gate.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const OWNER = 'daniel-to-the-moon';
const issue = (labels, extra = {}) => ({ number: 7, state: 'open', labels: labels.map((name) => ({ name })), ...extra });
const owner = { login: OWNER, type: 'User' };
const labeled = (label, labels, extra = {}) => ({ action: 'labeled', label: { name: label }, issue: issue(labels), sender: owner, ...extra });

test('打 proposal / discussion → 首评', () => {
  assert.deepEqual(gate('issues', labeled('proposal', ['proposal']), OWNER), { run: true, issue: 7, mode: 'first', dry: false, reason: '打上 proposal 标签' });
  assert.equal(gate('issues', labeled('discussion', ['discussion', 'proposal']), OWNER).mode, 'first');
});

test('其他标签、已带 devloop / gpt-design、PR、已关闭 → 跳过', () => {
  assert.equal(gate('issues', labeled('bug', ['bug']), OWNER).run, false);
  assert.equal(gate('issues', labeled('devloop', ['proposal', 'devloop']), OWNER).run, false);
  assert.match(gate('issues', labeled('proposal', ['proposal', 'devloop']), OWNER).reason, /devloop/);
  assert.match(gate('issues', labeled('discussion', ['discussion', 'gpt-design']), OWNER).reason, /gpt-design/);
  assert.equal(gate('issues', { ...labeled('proposal', ['proposal']), issue: issue(['proposal'], { pull_request: {} }) }, OWNER).run, false);
  assert.equal(gate('issues', { ...labeled('proposal', ['proposal']), issue: issue(['proposal'], { state: 'closed' }) }, OWNER).run, false);
});

test('只认仓库所有者亲手打的标签', () => {
  assert.equal(gate('issues', labeled('proposal', ['proposal'], { sender: { login: 'stranger', type: 'User' } }), OWNER).run, false);
  assert.equal(gate('issues', labeled('proposal', ['proposal'], { sender: { login: 'github-actions[bot]', type: 'Bot' } }), OWNER).run, false);
  assert.equal(gate('issues', labeled('proposal', ['proposal']), undefined).run, false); // 没传 OWNER 不放行
});

test('新建 issue 不处理（另有 labeled 事件）', () => {
  assert.equal(gate('issues', { action: 'opened', issue: issue(['proposal']), sender: owner }, OWNER).run, false);
});

test('改正文 → status；只改标题、不带讨论标签 → 跳过', () => {
  const ed = (changes, labels = ['proposal']) => ({ action: 'edited', changes, issue: issue(labels), sender: owner });
  assert.equal(gate('issues', ed({ body: { from: 'old' } }), OWNER).mode, 'status');
  assert.equal(gate('issues', ed({ title: { from: 'old' } }), OWNER).run, false);
  assert.equal(gate('issues', ed(undefined), OWNER).run, false);
  assert.equal(gate('issues', ed({ body: { from: 'old' } }, ['bug']), OWNER).run, false);
  // 已带 devloop 的帖子改正文仍可更新状态行：只改已有首评，不调模型
  assert.equal(gate('issues', ed({ body: { from: 'old' } }, ['proposal', 'devloop']), OWNER).mode, 'status');
});

test('手动触发：默认试跑；dry_run=false 才发评论；fixture 强制试跑；编号与 fixture 名校验', () => {
  assert.equal(gate('workflow_dispatch', { inputs: { issue: '7' } }).dry, true);
  assert.equal(gate('workflow_dispatch', { inputs: { issue: '7', dry_run: 'false' } }).dry, false);
  assert.equal(gate('workflow_dispatch', { inputs: { issue: '7', dry_run: false } }).dry, false);
  assert.deepEqual(gate('workflow_dispatch', { inputs: { issue: '0', fixture: 'proposal-basic', dry_run: false } }), { run: true, issue: 0, mode: 'first', dry: true, reason: '手动试跑 fixture proposal-basic' });
  for (const bad of ['', '0', '-1', '3; rm -rf /', 'abc']) assert.equal(gate('workflow_dispatch', { inputs: { issue: bad } }).run, false, bad);
  assert.equal(gate('workflow_dispatch', { inputs: { issue: '1', fixture: '../x' } }).run, false);
});

test('不处理其他事件', () => {
  assert.equal(gate('issue_comment', { action: 'created', issue: issue(['proposal']) }, OWNER).run, false);
});

test('命令行：读 OWNER，写入 GITHUB_OUTPUT', () => {
  const dir = mkdtempSync(join(tmpdir(), 'drgate-'));
  try {
    const ev = join(dir, 'ev.json');
    const out = join(dir, 'out');
    writeFileSync(ev, JSON.stringify(labeled('proposal', ['proposal'])));
    writeFileSync(out, '');
    execFileSync(process.execPath, [join(HERE, 'design-review-gate.mjs'), 'issues', ev], { env: { ...process.env, GITHUB_OUTPUT: out, OWNER } });
    assert.match(readFileSync(out, 'utf8'), /^run=true\nissue=7\nmode=first\ndry=false\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
