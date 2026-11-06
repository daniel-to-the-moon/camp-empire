/**
 * devloop 决策逻辑（纯函数，无 I/O），由 policy.test.mjs 覆盖。
 *
 * 每条审核评论末尾带一个机器可读标记：<!-- devloop state=<状态> head=<提交> base=<提交> -->
 *   changes  需要执行者改（GPT 要求修改 / 测试失败 / 冲突）→ 触发云端 Claude 修复；同一 head 不再审
 *   merged   已合并
 *   stopped  达到轮次上限，加 needs-user，停止自动循环
 *   retry    暂时不能合并（合并失败、基准分支在测试后变了、CI 基础设施出错、hold、--no-merge）→ 下一轮扫描重试同一 head
 */

export const MAX_ROUNDS = 5;
export const SKIP_LABELS = ['needs-user', 'hold'];
const TERMINAL = new Set(['changes', 'merged', 'stopped']);

export function marker(state, head, base) {
  return `<!-- devloop state=${state} head=${head} base=${base ?? ''} -->`;
}

export function parseMarkers(bodies) {
  const out = [];
  for (const b of bodies) {
    for (const m of b.matchAll(/<!-- devloop state=(\w+) head=([0-9a-f]+) base=([0-9a-f]*) -->/g)) {
      out.push({ state: m[1], head: m[2], base: m[3] || null });
    }
  }
  return out;
}

export function hasSkipLabel(labels) {
  return labels.some((l) => SKIP_LABELS.includes(l));
}

/** watch 是否要审这个 PR 的当前 head */
export function shouldReview({ head, labels, bodies }) {
  if (hasSkipLabel(labels)) return false;
  return !parseMarkers(bodies).some((m) => m.head === head && TERMINAL.has(m.state));
}

/** 已经消耗的轮次 = 之前 state=changes 的审核次数（不同 head 各算一轮） */
export function roundsUsed(bodies) {
  return new Set(parseMarkers(bodies).filter((m) => m.state === 'changes').map((m) => m.head)).size;
}

export function isBlocking(findings) {
  return findings.some((f) => f.severity === 'blocker' || f.severity === 'major');
}

/**
 * 合并前的最终决定。
 * ci: { status: 'ok' | 'failed' | 'error', base }，base 为 CI 实际测试的基准提交
 * now: { labels, base, mergeable }：合并前一刻重新读取的 PR 状态与基准分支
 */
export function decide({ ci, review, now, roundsBefore, allowMerge }) {
  const approved = review.verdict === 'approve' && !isBlocking(review.findings);
  const needsChange = ci.status === 'failed' || !approved || now.mergeable === 'CONFLICTING';
  if (needsChange) {
    const round = roundsBefore + 1;
    if (round >= MAX_ROUNDS) {
      return { state: 'stopped', merge: false, addLabel: 'needs-user', text: `已连续 ${round} 轮未通过，达到上限 ${MAX_ROUNDS}，停止自动循环，请用户裁决（已加 needs-user 标签）。` };
    }
    const why = [
      ci.status === 'failed' ? '测试或构建失败' : null,
      !approved ? 'GPT 要求修改' : null,
      now.mergeable === 'CONFLICTING' ? '与基准分支冲突（先 git merge origin/main）' : null,
    ].filter(Boolean);
    return { state: 'changes', merge: false, text: `第 ${round} 轮未通过：${why.join('；')}。执行者修复后自动重新审核。` };
  }
  if (ci.status === 'error') return { state: 'retry', merge: false, text: 'CI 未能完成（基础设施问题），下一轮扫描重试。' };
  if (hasSkipLabel(now.labels)) return { state: 'retry', merge: false, text: `PR 带有 ${now.labels.filter((l) => SKIP_LABELS.includes(l)).join('、')} 标签，审核通过但不合并。` };
  if (!allowMerge) return { state: 'retry', merge: false, text: '审核通过（本次指定 --no-merge，未合并）。' };
  if (ci.base !== now.base) return { state: 'retry', merge: false, text: '测试之后 main 有了新提交，测试结果不再代表合并后的代码，下一轮扫描用新 main 重测。' };
  return { state: 'merged', merge: true, text: '审核通过 + 合并后代码测试通过 → 自动 squash 合并。' };
}
