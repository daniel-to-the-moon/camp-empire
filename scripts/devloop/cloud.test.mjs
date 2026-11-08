// 云端审核 cloud.mjs：选择逻辑、后续动作、select 子命令（假 gh）以及 gpt-review.yml 的权限结构
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { followUps, pickPr } from './cloud.mjs';
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
    env: { ...process.env, PATH: g.path, REPO: 'o/r', DEVLOOP_MARKER_KEY: KEY, GITHUB_OUTPUT: out },
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
