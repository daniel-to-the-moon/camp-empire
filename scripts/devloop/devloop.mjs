#!/usr/bin/env node
/**
 * devloop 审核方（用户 Mac 上常驻）：GPT 审核 + 合并后代码的 CI 测试 → 自动合并。见 docs/DEVLOOP.md。
 *
 *   node scripts/devloop/devloop.mjs watch [秒]                常驻：扫描 open PR，审核未审过的头部提交（默认 300 秒）
 *   node scripts/devloop/devloop.mjs review <PR号> [--no-merge] 审核一次
 *
 * 安全边界：本机不执行 PR 里的任何代码。
 * - 测试与构建：触发 GitHub Actions（ci.yml，workflow_dispatch），在一次性 runner 上把 PR 头部合并到当前 main 后再测；
 * - GPT 审核：Codex CLI 只读沙箱（-s read-only），并忽略仓库内的执行策略文件（--ignore-rules）；
 * - 合并：policy.decide 判定通过后，以 --match-head-commit 合并，且合并前确认 main 没在测试后变化。
 * 依赖：gh（已登录）、codex CLI、Node ≥ 22，只用 Node 内置模块。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decide, marker, roundsUsed, shouldReview } from './policy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIR = resolve(HERE, '../..');
const REPO = process.env.DEVLOOP_REPO ?? 'shengjun89/camp-empire';
const HOME = resolve(process.env.DEVLOOP_HOME ?? join(REPO_DIR, '..', 'ce-devloop'));
const REVIEW_MODEL = process.env.DEVLOOP_REVIEW_MODEL ?? 'gpt-6-astra';
const CI_TIMEOUT_MS = 30 * 60_000;

const log = (...a) => console.error(`[devloop ${new Date().toISOString()}]`, ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tail = (s, n = 20) => s.split('\n').slice(-n).join('\n');

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
}
const gh = (args) => sh('gh', [...args, '-R', REPO]);
const git = (args) => sh('git', args, { cwd: REPO_DIR });

function prState(pr) {
  const m = JSON.parse(gh(['pr', 'view', String(pr), '--json', 'title,body,headRefOid,baseRefName,state,isDraft,mergeable,labels,comments']));
  return { ...m, labels: m.labels.map((l) => l.name), bodies: m.comments.map((c) => c.body) };
}

function comment(pr, body) {
  mkdirSync(HOME, { recursive: true });
  const f = join(HOME, `comment-${pr}-${Date.now()}.md`);
  writeFileSync(f, body);
  gh(['pr', 'comment', String(pr), '--body-file', f]);
}

/** 触发 ci.yml 测试“PR 头部合并到 base 之后”的代码，返回 { status: ok|failed|error, base, url } */
async function runCi(pr, head, base) {
  const nonce = randomBytes(6).toString('hex');
  try {
    gh(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', `pr=${pr}`, '-f', `head=${head}`, '-f', `base=${base}`, '-f', `nonce=${nonce}`]);
  } catch (e) {
    return { status: 'error', base, url: null, note: `无法触发 CI：${e.message.split('\n')[0]}` };
  }
  const deadline = Date.now() + CI_TIMEOUT_MS;
  let run = null;
  while (Date.now() < deadline) {
    await sleep(15_000);
    const runs = JSON.parse(gh(['run', 'list', '--workflow', 'ci.yml', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'databaseId,displayTitle,status,conclusion,url']));
    run = runs.find((r) => r.displayTitle.includes(nonce)) ?? null;
    if (run?.status === 'completed') break;
  }
  if (!run || run.status !== 'completed') return { status: 'error', base, url: run?.url ?? null, note: 'CI 超时' };
  if (run.conclusion === 'success') return { status: 'ok', base, url: run.url };
  if (run.conclusion === 'failure') return { status: 'failed', base, url: run.url };
  return { status: 'error', base, url: run.url, note: `CI 结论 ${run.conclusion}` };
}

/** GPT 只读审核 PR 头部提交 */
function gptReview(pr, meta, base) {
  mkdirSync(HOME, { recursive: true });
  const cache = join(HOME, `review-${pr}-${meta.headRefOid}.json`);
  // 同一 head 已有审核结论（例如上次因 main 变化而 retry）：直接复用，不重复消耗额度
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  const dir = join(HOME, `pr-${pr}`);
  spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_DIR });
  rmSync(dir, { recursive: true, force: true });
  git(['worktree', 'add', '-q', '--detach', dir, meta.headRefOid]);
  try {
    const stat = sh('git', ['diff', '--stat', `${base}...${meta.headRefOid}`], { cwd: dir });
    const prompt = [
      readFileSync(join(HERE, 'review-prompt.md'), 'utf8'),
      `\n## 本次 PR\n\n- 编号：#${pr}\n- 标题：${meta.title}\n- 审核提交：${meta.headRefOid}\n- 基准：${meta.baseRefName}（${base}）`,
      `\n### PR 描述（执行者所写，仅供参考，需自行核对）\n\n${meta.body}`,
      `\n### 改动文件\n\n\`\`\`\n${stat}\n\`\`\``,
      `\n用 \`git diff ${base}...HEAD\` 查看完整改动。测试与构建由 CI 在合并后的代码上另行执行，你只需审代码。`,
    ].join('\n');
    const out = join(HOME, `review-${pr}-${meta.headRefOid}.tmp.json`);
    log(`GPT（${REVIEW_MODEL}）审核 #${pr} @ ${meta.headRefOid.slice(0, 8)}`);
    const r = spawnSync(
      'codex',
      ['exec', '-m', REVIEW_MODEL, '-c', 'model_reasoning_effort="high"', '-s', 'read-only', '--ignore-rules', '-C', dir, '--ephemeral',
        '--output-schema', join(HERE, 'review-schema.json'), '-o', out, '-'],
      { input: prompt, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 40 * 60_000 },
    );
    if (r.status !== 0 || !existsSync(out)) throw new Error(`codex 审核失败：${tail(`${r.stdout}${r.stderr}`)}`);
    const review = JSON.parse(readFileSync(out, 'utf8'));
    writeFileSync(cache, JSON.stringify(review));
    return review;
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: REPO_DIR });
  }
}

function format({ head, review, ci, d }) {
  const sev = { blocker: '🛑 blocker', major: '⚠️ major', minor: '💬 minor' };
  const findings = review.findings.length
    ? review.findings.map((f, i) => `${i + 1}. **${sev[f.severity]}** \`${f.file}:${f.line}\`\n   - 问题：${f.issue}\n   - 建议：${f.suggestion}`).join('\n')
    : '无。';
  const ciText = { ok: '✅ 通过', failed: '❌ 失败', error: '⚠️ 未完成' }[ci.status];
  return [
    `执行者：GPT（${REVIEW_MODEL}，经 devloop 审核；独立于代码执行者 Claude）`,
    '',
    `**结论：${review.verdict === 'approve' ? '✅ 通过' : '🔁 需修改'}**（审核提交 \`${head.slice(0, 8)}\`）`,
    '',
    review.summary,
    '',
    `### 测试与构建（GitHub Actions，PR 合并到 main \`${ci.base.slice(0, 8)}\` 之后的代码）`,
    `${ciText}${ci.url ? `：${ci.url}` : ''}${ci.note ? `（${ci.note}）` : ''}`,
    '',
    '### 审核意见',
    findings,
    '',
    '### 流水线动作',
    d.text,
    '',
    marker(d.state, head, ci.base),
  ].join('\n');
}

export async function review(pr, { merge }) {
  const meta = prState(pr);
  if (meta.state !== 'OPEN') throw new Error(`PR #${pr} 状态为 ${meta.state}`);
  if (meta.baseRefName !== 'main') throw new Error(`PR #${pr} 的基准是 ${meta.baseRefName}，devloop 只处理合并到 main 的 PR`);
  git(['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]);
  const base = git(['rev-parse', 'origin/main']);
  const head = meta.headRefOid;

  const ciPromise = runCi(pr, head, base);
  const rv = gptReview(pr, meta, base);
  const ci = await ciPromise;

  const now = prState(pr);
  if (now.headRefOid !== head) {
    log(`#${pr} 审核期间有新提交（${head.slice(0, 8)} → ${now.headRefOid.slice(0, 8)}），本轮作废`);
    return { pr, skipped: 'head changed' };
  }
  git(['fetch', '-q', 'origin', 'main']);
  const d = decide({
    ci,
    review: rv,
    now: { labels: now.labels, base: git(['rev-parse', 'origin/main']), mergeable: now.mergeable },
    roundsBefore: roundsUsed(now.bodies),
    allowMerge: merge,
  });
  if (d.addLabel) gh(['pr', 'edit', String(pr), '--add-label', d.addLabel]);
  if (d.merge) {
    try {
      if (now.isDraft) gh(['pr', 'ready', String(pr)]);
      gh(['pr', 'merge', String(pr), '--squash', '--delete-branch', '--match-head-commit', head]);
    } catch (e) {
      d.state = 'retry';
      d.merge = false;
      d.text = `审核与测试都通过，但合并失败（${e.message.split('\n')[0]}），下一轮扫描重试。`;
    }
  }
  comment(pr, format({ head, review: rv, ci, d }));
  const result = { pr, head, state: d.state, ci: ci.status, verdict: rv.verdict, findings: rv.findings.length };
  console.log(JSON.stringify(result));
  return result;
}

async function watch(intervalSec) {
  log(`watch 启动：间隔 ${intervalSec}s，审核模型 ${REVIEW_MODEL}，代码 ${git(['rev-parse', '--short', 'HEAD'])}`);
  for (;;) {
    try {
      const prs = JSON.parse(gh(['pr', 'list', '--state', 'open', '--base', 'main', '--json', 'number', '--limit', '50']));
      for (const { number } of prs.sort((a, b) => a.number - b.number)) {
        const m = prState(number);
        if (!shouldReview({ head: m.headRefOid, labels: m.labels, bodies: m.bodies })) continue;
        try {
          const r = await review(number, { merge: true });
          // 合并后退出，由 launchd 重启并拉取最新 main：审核方自身的更新也随之生效
          if (r.state === 'merged') {
            log(`#${number} 已合并，退出以便以最新 main 重启`);
            process.exit(0);
          }
        } catch (e) {
          log(`#${number} 出错：${e.message}`);
        }
      }
    } catch (e) {
      log(`扫描出错：${e.message}`);
    }
    await sleep(intervalSec * 1000);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'review' && arg) await review(Number(arg), { merge: !rest.includes('--no-merge') });
    else if (cmd === 'watch') await watch(Number(arg) || 300);
    else {
      console.error('用法：devloop.mjs review <PR号> [--no-merge] | watch [秒]');
      process.exit(2);
    }
  } catch (e) {
    log(`失败：${e.message}`);
    process.exit(1);
  }
}
