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
 * - 合并：policy.decide 判定通过后，在测试基准上本地生成与 CI 相同的合并提交，普通推送到 main。
 *   main 若在测试后变化，推送是非快进而被拒绝 → 不会合入未经测试的组合（原子的“比较并交换”）。
 *   GitHub 发现 PR 头部已在 main 中，会把 PR 自动标为已合并。
 * 依赖：gh（已登录）、codex CLI、Node ≥ 22，只用 Node 内置模块。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { acquireLock, matchPrRun, mergeAndPush, reviewCacheKey, uniqueDir, withWorktree } from './gitops.mjs';
import { decide, eligible, marker, parseMarkers, roundsUsed, shouldReview } from './policy.mjs';

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
const git = (args, cwd = REPO_DIR) => sh('git', args, { cwd });

/** 标记签名密钥：只在本机，首次运行生成，权限 600 */
function markerKey() {
  mkdirSync(HOME, { recursive: true });
  const f = join(HOME, 'marker.key');
  if (!existsSync(f)) {
    writeFileSync(f, randomBytes(32).toString('hex'), { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  return readFileSync(f, 'utf8').trim();
}
const KEY = markerKey();
const REVIEWER = sh('gh', ['api', 'user', '-q', '.login']);

function prState(pr) {
  const m = JSON.parse(
    gh(['pr', 'view', String(pr), '--json', 'title,body,headRefOid,headRefName,isCrossRepository,baseRefName,state,isDraft,mergeable,labels,comments']),
  );
  const comments = m.comments.map((c) => ({ author: c.author?.login ?? '', body: c.body }));
  return { ...m, labels: m.labels.map((l) => l.name), markers: parseMarkers(comments, { key: KEY, reviewer: REVIEWER, pr }) };
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
    // main 上的 ci.yml 还不支持 workflow_dispatch（只发生在 devloop 自身合入之前）：
    // 退而使用该 PR 的 pull_request 运行，前提是它测的正是这个 head、且合并基准正是这个 base
    if (/workflow_dispatch/.test(e.message)) return pullRequestCi(pr, head, base);
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

/** 回退：找 pull_request 事件、head 与 base 都吻合的已完成 CI 运行（GitHub 在运行记录里给出当时的 base.sha） */
function pullRequestCi(pr, head, base) {
  const runs = JSON.parse(sh('gh', ['api', `repos/${REPO}/actions/runs?event=pull_request&head_sha=${head}&per_page=20`])).workflow_runs ?? [];
  const run = matchPrRun(runs, { pr, head, base });
  if (!run) return { status: 'error', base, url: null, note: '无法触发 dispatch CI，也没有 head 与 base 都吻合的 pull_request CI' };
  const note = '回退：使用该 PR 的 pull_request CI（head 与 base 均已核对）';
  if (run.conclusion === 'success') return { status: 'ok', base, url: run.html_url, note };
  if (run.conclusion === 'failure') return { status: 'failed', base, url: run.html_url, note };
  return { status: 'error', base, url: run.html_url, note: `${note}；结论 ${run.conclusion}` };
}

/** GPT 只读审核 PR 头部提交 */
function gptReview(pr, meta, base) {
  mkdirSync(HOME, { recursive: true });
  // 缓存键 = head + base：只有代码和基准都没变时才复用结论（main 变了就重新审核）
  const cache = join(HOME, reviewCacheKey(pr, meta.headRefOid, base));
  if (existsSync(cache)) return JSON.parse(readFileSync(cache, 'utf8'));
  return withWorktree(REPO_DIR, uniqueDir(HOME, `pr-${pr}`), meta.headRefOid, (dir) => {
    const stat = sh('git', ['diff', '--stat', `${base}...${meta.headRefOid}`], { cwd: dir });
    const prompt = [
      readFileSync(join(HERE, 'review-prompt.md'), 'utf8'),
      `\n## 本次 PR\n\n- 编号：#${pr}\n- 标题：${meta.title}\n- 审核提交：${meta.headRefOid}\n- 基准：${meta.baseRefName}（${base}）`,
      `\n### PR 描述（执行者所写，仅供参考，需自行核对）\n\n${meta.body}`,
      `\n### 改动文件\n\n\`\`\`\n${stat}\n\`\`\``,
      `\n用 \`git diff ${base}...HEAD\` 查看完整改动。测试与构建由 CI 在合并后的代码上另行执行，你只需审代码。`,
    ].join('\n');
    const out = `${cache}.${process.pid}.tmp`;
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
    rmSync(out, { force: true });
    return review;
  });
}

function format({ pr, head, review, ci, d }) {
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
    marker(KEY, { pr, state: d.state, head, base: ci.base }),
  ].join('\n');
}

export async function review(pr, { merge }) {
  const release = acquireLock(HOME);
  if (!release) throw new Error('另一个 devloop 进程正在审核或合并，稍后再试');
  try {
    return await reviewLocked(pr, { merge });
  } finally {
    release();
  }
}

async function reviewLocked(pr, { merge }) {
  git(['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]);
  const meta = prState(pr);
  if (!eligible(meta)) throw new Error(`PR #${pr} 不是“打开、非草稿、目标 main”（state=${meta.state} draft=${meta.isDraft} base=${meta.baseRefName}）`);
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
    now: { labels: now.labels, base: git(['rev-parse', 'origin/main']), mergeable: now.mergeable, state: now.state, isDraft: now.isDraft, baseRefName: now.baseRefName },
    roundsBefore: roundsUsed(now.markers),
    allowMerge: merge,
  });
  if (d.addLabel) gh(['pr', 'edit', String(pr), '--add-label', d.addLabel]);
  if (d.merge) {
    try {
      const { sha, branchDeleted } = mergeAndPush({
        repoDir: REPO_DIR,
        home: HOME,
        base: ci.base,
        head,
        message: `合并 PR #${pr}：${now.title}\n\ndevloop：GPT 审核通过，CI 在 ${ci.base.slice(0, 8)} + ${head.slice(0, 8)} 上测试通过。`,
        branch: now.isCrossRepository ? null : now.headRefName,
        // 推送前一刻再读一次 PR：已关闭 / 改草稿 / 改目标 / 有新提交 / 加了暂停标签 → 中止
        beforePush: () => {
          const last = prState(pr);
          if (!eligible(last) || last.headRefOid !== head || last.labels.some((l) => l === 'hold' || l === 'needs-user')) {
            throw new Error('推送前 PR 状态已变化');
          }
        },
      });
      d.text += `\n\n合并提交 \`${sha.slice(0, 8)}\`（父提交：main \`${ci.base.slice(0, 8)}\` + PR \`${head.slice(0, 8)}\`，与 CI 测试的组合一致）${branchDeleted ? '' : '；分支上有新提交或已删除，未删除分支'}。`;
    } catch (e) {
      d.state = 'retry';
      d.merge = false;
      d.text = `审核与测试都通过，但合并未完成（${e.message.split('\n')[0]}），下一轮扫描重试。`;
    }
  }
  comment(pr, format({ pr, head, review: rv, ci, d }));
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
        if (!shouldReview({ head: m.headRefOid, labels: m.labels, markers: m.markers, pr: m })) continue;
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
