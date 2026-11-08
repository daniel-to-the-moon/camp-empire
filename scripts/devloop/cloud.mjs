#!/usr/bin/env node
/**
 * 云端 PR 审核（.github/workflows/gpt-review.yml 调用）。与本机 devloop.mjs 共用 policy / gitops / ci / prstate / review-format，
 * 同一把签名密钥（secret DEVLOOP_MARKER_KEY），所以两边的审核记录互认。
 *
 *   node cloud.mjs select [--pr N]                      选出一个要审的 PR → $GITHUB_OUTPUT：pr、head、base
 *   node cloud.mjs prompt --pr N --base B --dir D --out F   在 PR 检出目录 D 里生成审核提示词
 *   node cloud.mjs decide --pr N --head H --base B [--review review.json]   跑 CI、判定、合并或退回、评论、触发后续
 *
 * 分工：云端只审“不改 .github/workflows/”的 PR（GITHUB_TOKEN 无 workflows 权限，合并不了这类 PR），这类交给本机审核方。
 * 环境：GH_TOKEN（gh 使用）、REPO、DEVLOOP_MARKER_KEY、GPT_MODEL（仅用于评论里标注模型名）。
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCi } from './ci.mjs';
import { mergeAndPush } from './gitops.mjs';
import { decide, eligible, roundsUsed, shouldReview } from './policy.mjs';
import { createPrState } from './prstate.mjs';
import { buildReviewPrompt, formatReview, touchesWorkflows } from './review-format.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts }).trim();
const log = (...a) => console.error('[cloud-review]', ...a);
const out = (kv) => {
  const text = Object.entries(kv).map(([k, v]) => `${k}=${v ?? ''}`).join('\n') + '\n';
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, text);
  process.stdout.write(text);
};

/** 选择逻辑（纯函数，便于测试）：按编号从小到大，取第一个需要审、且不改工作流的 PR */
export function pickPr(states) {
  for (const m of [...states].sort((a, b) => a.number - b.number)) {
    if (!shouldReview({ head: m.headRefOid, labels: m.labels, markers: m.markers, pr: m })) continue;
    if (touchesWorkflows(m.files)) continue;
    return m;
  }
  return null;
}

/** 合并后的后续：需修改 → 直接触发云端 Claude 修复（GITHUB_TOKEN 发的评论不会触发 issue_comment 工作流）；合并 → 触发部署 */
export function followUps(state, pr) {
  if (state === 'changes') return [['workflow', 'run', 'claude.yml', '-f', `pr=${pr}`]];
  if (state === 'merged') return [['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', 'deploy_main=true']];
  return [];
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const REPO = process.env.REPO;
  const KEY = process.env.DEVLOOP_MARKER_KEY;
  if (!REPO || !KEY) throw new Error('缺少 REPO 或 DEVLOOP_MARKER_KEY');
  const gh = (args) => sh('gh', args);
  const ghR = (args) => sh('gh', [...args, '-R', REPO]);
  const prState = createPrState({ gh, repo: REPO, key: KEY, whoami: () => 'github-actions' });
  const mainSha = () => gh(['api', `repos/${REPO}/commits/main`, '-q', '.sha']);
  const cmd = process.argv[2];

  if (cmd === 'select') {
    const only = arg('pr');
    const numbers = only ? [Number(only)] : JSON.parse(ghR(['pr', 'list', '--state', 'open', '--base', 'main', '--json', 'number', '--limit', '50'])).map((p) => p.number);
    const states = numbers.map((n) => ({ number: n, ...prState(n) }));
    const m = pickPr(states);
    if (!m) return out({ pr: '', head: '', base: '', reason: '没有需要云端审核的 PR' });
    return out({ pr: m.number, head: m.headRefOid, base: mainSha(), reason: `审核 #${m.number}` });
  }

  if (cmd === 'prompt') {
    const pr = Number(arg('pr'));
    const base = arg('base');
    const meta = prState(pr);
    const stat = sh('git', ['diff', '--stat', `${base}...${meta.headRefOid}`], { cwd: arg('dir') });
    writeFileSync(arg('out'), buildReviewPrompt({ header: readFileSync(join(HERE, 'review-prompt.md'), 'utf8'), pr, meta, base, stat }));
    return out({ prompt: arg('out') });
  }

  if (cmd === 'decide') {
    const pr = Number(arg('pr'));
    const head = arg('head');
    const base = arg('base');
    const reviewPath = arg('review');
    let review = null;
    let reviewError = 'GPT 审核任务没有产出结论';
    if (reviewPath && existsSync(reviewPath)) {
      try {
        review = JSON.parse(readFileSync(reviewPath, 'utf8'));
      } catch (e) {
        reviewError = `GPT 结论无法解析：${e.message}`;
      }
    }
    const ciIo = {
      dispatch: async ({ pr: p, head: h, base: b, nonce }) => ghR(['workflow', 'run', 'ci.yml', '--ref', 'main', '-f', `pr=${p}`, '-f', `head=${h}`, '-f', `base=${b}`, '-f', `nonce=${nonce}`]),
      listDispatchRuns: async () => JSON.parse(ghR(['run', 'list', '--workflow', 'ci.yml', '--event', 'workflow_dispatch', '--limit', '30', '--json', 'displayTitle,status,conclusion,url'])),
      listPrRuns: async (h) => JSON.parse(gh(['api', `repos/${REPO}/actions/runs?event=pull_request&head_sha=${h}&per_page=20`])).workflow_runs ?? [],
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
    };
    const ci = await runCi({ pr, head, base, io: ciIo, timeoutMs: 30 * 60_000 });
    const now = prState(pr);
    if (now.headRefOid !== head) return out({ state: 'skipped', reason: `审核期间有新提交（${head.slice(0, 8)} → ${now.headRefOid.slice(0, 8)}）` });
    if (touchesWorkflows(now.files)) return out({ state: 'skipped', reason: '改动工作流文件，交给本机审核方' });
    const d = decide({
      ci,
      review,
      now: { labels: now.labels, base: mainSha(), mergeable: now.mergeable, state: now.state, isDraft: now.isDraft, baseRefName: now.baseRefName },
      roundsBefore: roundsUsed(now.markers),
      retriesForHead: now.markers.filter((m) => m.head === head && m.state === 'retry' && m.reason === 'infra').length,
      allowMerge: true,
    });
    if (d.addLabel) ghR(['pr', 'edit', String(pr), '--add-label', d.addLabel]);
    if (d.merge) {
      try {
        sh('git', ['fetch', '-q', 'origin', 'main', `pull/${pr}/head`]);
        const { sha, branchDeleted } = mergeAndPush({
          repoDir: process.cwd(),
          home: mkdtempSync(join(tmpdir(), 'cloud-merge-')),
          base: ci.base,
          head,
          message: `合并 PR #${pr}：${now.title}\n\ndevloop（云端审核）：GPT 审核通过，CI 在 ${ci.base.slice(0, 8)} + ${head.slice(0, 8)} 上测试通过。`,
          branch: now.isCrossRepository ? null : now.headRefName,
          beforePush: () => {
            const last = prState(pr);
            if (!eligible(last) || last.headRefOid !== head || last.labels.some((l) => l === 'hold' || l === 'needs-user')) throw new Error('推送前 PR 状态已变化');
          },
        });
        d.text += `\n\n合并提交 \`${sha.slice(0, 8)}\`（父提交：main \`${ci.base.slice(0, 8)}\` + PR \`${head.slice(0, 8)}\`，与 CI 测试的组合一致）${branchDeleted ? '' : '；分支上有新提交或已删除，未删除分支'}。`;
      } catch (e) {
        d.state = 'retry';
        d.reason = 'merge';
        d.merge = false;
        d.text = `审核与测试都通过，但合并未完成（${String(e.message).split('\n')[0]}），下一轮重试。`;
      }
    }
    const body = formatReview({
      key: KEY,
      model: process.env.GPT_MODEL || 'GPT',
      where: '云端审核，openai/codex-action',
      pr,
      head,
      review: review ?? { verdict: 'error', summary: `GPT 审核未能完成：${reviewError}`, findings: [] },
      ci,
      d,
    });
    const f = join(mkdtempSync(join(tmpdir(), 'cloud-comment-')), 'c.md');
    writeFileSync(f, body);
    ghR(['pr', 'comment', String(pr), '--body-file', f]);
    for (const a of followUps(d.state, pr)) {
      try {
        ghR(a);
      } catch (e) {
        log(`后续动作失败（${a.join(' ')}）：${String(e.message).split('\n')[0]}`);
      }
    }
    return out({ state: d.state, ci: ci.status, verdict: review?.verdict ?? 'error' });
  }
  throw new Error('用法：cloud.mjs select|prompt|decide …');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((e) => {
    console.error(`[cloud-review] 失败：${e.message}`);
    process.exit(1);
  });
}
