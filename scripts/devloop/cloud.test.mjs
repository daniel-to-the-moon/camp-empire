// 云端审核 cloud.mjs：选择逻辑、后续动作、select 子命令（假 gh）以及 gpt-review.yml 的权限结构
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { finalize, followUps, pickPr, trustedReviewer } from './cloud.mjs';
import { roundsUsed } from './policy.mjs';
import { marker } from './policy.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'cloud-'));
after(() => rmSync(root, { recursive: true, force: true }));
const KEY = 'k';
const H = 'a'.repeat(40);
const B = 'b'.repeat(40);
const open = { state: 'OPEN', isDraft: false, baseRefName: 'main', labels: [], markers: [] };

test('pickPr：按编号取第一个需要审的；跳过改工作流的、已有终态的、暂停的、草稿', () => {
  const s = (n, extra = {}) => ({ number: n, headRefOid: `${n}`.repeat(40).slice(0, 40), files: ['src/a.ts'], ...open, ...extra });
  assert.equal(pickPr([s(5), s(3)]).number, 3);
  assert.equal(pickPr([s(3, { files: ['.github/workflows/ci.yml', 'src/a.ts'] }), s(5)]).number, 5);
  assert.equal(pickPr([s(3, { labels: ['hold'] }), s(4, { isDraft: true }), s(5)]).number, 5);
  const done = s(3);
  done.markers = [{ state: 'changes', reason: 'none', head: done.headRefOid, base: B }];
  assert.equal(pickPr([done]), null);
  assert.equal(pickPr([]), null);
});

test('followUps：需修改 → 触发 claude.yml 修复；合并 → 触发 main 发布；其余无后续', () => {
  assert.deepEqual(followUps('changes', 7), [['workflow', 'run', 'claude.yml', '-f', 'pr=7']]);
  assert.deepEqual(followUps('merged', 7), [['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'deploy_main=true']]);
  for (const st of ['retry', 'stopped']) assert.deepEqual(followUps(st, 7), []);
});

/** 假 gh：pr list / pr view / commits/main；记录调用；`api user` 一律失败（GITHUB_TOKEN 无法查 user） */
function fakeGh(prs) {
  const dir = mkdtempSync(join(root, 'gh-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const p of prs) writeFileSync(join(dir, `pr-${p.number}.json`), JSON.stringify(p.view));
  writeFileSync(join(dir, 'list.json'), JSON.stringify(prs.map((p) => ({ number: p.number }))));
  writeFileSync(
    join(bin, 'gh'),
    `#!/usr/bin/env bash
echo "$*" >> "${dir}/gh.log"
if [ "$1 $2" = "api user" ]; then echo "Resource not accessible by integration" >&2; exit 1; fi
if [ "$1 $2" = "pr list" ]; then cat "${dir}/list.json"; exit 0; fi
if [ "$1 $2" = "pr view" ]; then cat "${dir}/pr-$3.json"; exit 0; fi
if [ "$1" = api ] && [[ "$2" == repos/*/commits/main ]]; then echo "${B}"; exit 0; fi
echo "unexpected: $*" >&2; exit 1
`,
  );
  chmodSync(join(bin, 'gh'), 0o755);
  return { path: `${bin}:${process.env.PATH}`, log: () => readFileSync(join(dir, 'gh.log'), 'utf8') };
}

const view = (head, { files = ['src/a.ts'], comments = [] } = {}) => ({
  title: 't', body: 'b', headRefOid: head, headRefName: 'claude/x', isCrossRepository: false, baseRefName: 'main',
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', labels: [], comments, files: files.map((path) => ({ path })),
});
const botReview = (pr, state, head) => ({ author: { login: 'github-actions' }, body: `执行者：GPT（云端）\n${marker(KEY, { pr, state, head, base: B })}` });

function select(prs, extraArgs = []) {
  const g = fakeGh(prs);
  const out = join(root, `out-${Math.random()}`);
  writeFileSync(out, '');
  const r = spawnSync(process.execPath, [join(HERE, 'cloud.mjs'), 'select', ...extraArgs], {
    env: { ...process.env, PATH: g.path, REPO: 'o/r', DEVLOOP_MARKER_KEY: KEY, GITHUB_OUTPUT: out, GITHUB_REPOSITORY_OWNER: 'owner' },
    encoding: 'utf8',
  });
  return { code: r.status, err: r.stderr, out: readFileSync(out, 'utf8'), log: g.log() };
}

test('select：不调用 gh api user；跳过改工作流的 PR；认得云端机器人发的签名标记', () => {
  const r = select([
    { number: 3, view: view(H, { files: ['.github/workflows/x.yml'] }) },
    { number: 4, view: view('c'.repeat(40), { comments: [botReview(4, 'changes', 'c'.repeat(40))] }) },
    { number: 5, view: view('d'.repeat(40)) },
  ]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pr=5\nhead=d{40}\nbase=b{40}\n/);
  assert.doesNotMatch(r.log, /^api user/m);
});

test('select：没有可审的 PR 时输出空 pr；--pr 只看指定的那个', () => {
  assert.match(select([{ number: 3, view: view(H, { files: ['.github/workflows/x.yml'] }) }]).out, /^pr=\n/);
  const r = select([{ number: 3, view: view(H) }, { number: 9, view: view('e'.repeat(40)) }], ['--pr', '9']);
  assert.match(r.out, /^pr=9\n/);
  assert.doesNotMatch(r.log, /pr list/);
});

test('gpt-review.yml：review 只读且以 :read-only 运行 codex、不持有签名密钥；decide 不运行模型；全局串行；开关', () => {
  const yml = readFileSync(join(HERE, '../../.github/workflows/gpt-review.yml'), 'utf8');
  const job = (name) => yml.match(new RegExp(`^  ${name}:\\n((?:(?: {4,}.*)?\\n)*)`, 'm'))?.[1] ?? '';
  const [select, review, decide] = ['select', 'review', 'decide'].map(job);
  assert.ok(select && review && decide);
  for (const j of [select, review]) assert.doesNotMatch(j, /: write$/m);
  assert.match(review, /uses: openai\/codex-action@bdf19a4a223ec2549a3e2274a0cf61556bc07675 /);
  assert.match(review, /permission-profile: ':read-only'/);
  assert.match(review, /persist-credentials: false/);
  // 签名密钥只在 prompt 这一步（不在运行 codex 的那一步）出现
  const codexStep = review.slice(review.indexOf('- name: GPT 审核'), review.indexOf('- uses: actions/upload-artifact'));
  assert.doesNotMatch(codexStep, /DEVLOOP_MARKER_KEY/);
  assert.doesNotMatch(decide, /uses: openai\/codex-action/);
  assert.match(decide, /^ {6}contents: write$/m);
  assert.match(decide, /^ {6}actions: write$/m);
  assert.match(yml, /^concurrency:\n {2}group: gpt-review\n {2}cancel-in-progress: false\n {2}queue: max$/m);
  assert.match(select, /^ {4}if: vars\.CLOUD_REVIEW == 'on' \|\| github\.event_name == 'workflow_dispatch'$/m);
});

const ownerReview = (pr, state, head) => ({ author: { login: 'owner' }, body: `执行者：GPT（经 devloop 审核）\n${marker(KEY, { pr, state, head, base: B })}` });

test('select：认本机审核方（仓库所有者）发的签名标记——本机审过的 head 云端不再重审', () => {
  const head = 'f'.repeat(40);
  const r = select([{ number: 6, view: view(head, { comments: [ownerReview(6, 'changes', head)] }) }]);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^pr=\n/);
  // 伪造：别的账号发的同样内容不算
  const forged = { author: { login: 'mallory' }, body: ownerReview(6, 'changes', head).body };
  assert.match(select([{ number: 6, view: view(head, { comments: [forged] }) }]).out, /^pr=6\n/);
});

test('trustedReviewer：取 LOCAL_REVIEWER 或 GITHUB_REPOSITORY_OWNER；都没有就报错', () => {
  assert.equal(trustedReviewer({ GITHUB_REPOSITORY_OWNER: 'o' }), 'o');
  assert.equal(trustedReviewer({ LOCAL_REVIEWER: 'l', GITHUB_REPOSITORY_OWNER: 'o' }), 'l');
  assert.throws(() => trustedReviewer({}));
});

test('轮次连续：本机与云端的 changes 标记混合计数', () => {
  const ms = [{ state: 'changes', head: '1' }, { state: 'changes', head: '2' }, { state: 'retry', reason: 'infra', head: '3' }];
  assert.equal(roundsUsed(ms), 2);
});

/** 假 ghR：按命令前缀决定失败次数，记录调用顺序 */
function fakeGhR(failures = {}) {
  const calls = [];
  const left = { ...failures };
  const ghR = (args) => {
    const k = args.slice(0, 3).join(' ');
    calls.push(k);
    for (const [prefix, n] of Object.entries(left)) {
      if (k.startsWith(prefix) && n > 0) {
        left[prefix] = n - 1;
        throw new Error(`boom ${prefix}`);
      }
    }
    return '';
  };
  return { ghR, calls };
}
const fin = (o) => finalize({ pr: 7, body: 'B', writeBody: (t) => `/tmp/${t.length}`, sleep: async () => {}, delayMs: 0, ...o });

test('finalize 合并：先触发部署再发评论；全部成功不加标签', async () => {
  const f = fakeGhR();
  await fin({ ghR: f.ghR, state: 'merged' });
  assert.deepEqual(f.calls, ['workflow run ci.yml', 'pr comment 7']);
});

test('finalize 合并：评论一直失败也照样部署；最终加 needs-user、发说明、抛错', async () => {
  const f = fakeGhR({ 'pr comment': 99 });
  await assert.rejects(fin({ ghR: f.ghR, state: 'merged' }), /发审核评论/);
  assert.equal(f.calls[0], 'workflow run ci.yml');
  assert.ok(f.calls.includes('pr edit 7'));
});

test('finalize 需修改：发评论后触发修复；触发偶发失败会重试成功', async () => {
  const f = fakeGhR({ 'workflow run claude.yml': 2 });
  await fin({ ghR: f.ghR, state: 'changes' });
  assert.deepEqual(f.calls, ['pr comment 7', 'workflow run claude.yml', 'workflow run claude.yml', 'workflow run claude.yml']);
});

test('finalize 需修改：触发一直失败 → 重试 3 次后 needs-user + 说明 + 抛错；评论失败则不触发修复', async () => {
  const a = fakeGhR({ 'workflow run claude.yml': 99 });
  await assert.rejects(fin({ ghR: a.ghR, state: 'changes' }), /触发云端 Claude 修复/);
  assert.equal(a.calls.filter((c) => c === 'workflow run claude.yml').length, 3);
  assert.ok(a.calls.includes('pr edit 7'));
  const b = fakeGhR({ 'pr comment': 99 });
  await assert.rejects(fin({ ghR: b.ghR, state: 'changes' }));
  assert.ok(!b.calls.includes('workflow run claude.yml'));
});

test('finalize retry / stopped：只发评论，无后续动作', async () => {
  for (const state of ['retry', 'stopped']) {
    const f = fakeGhR();
    await fin({ ghR: f.ghR, state });
    assert.deepEqual(f.calls, ['pr comment 7']);
  }
});
