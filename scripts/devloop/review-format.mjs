/**
 * 审核提示词与审核评论的格式（本机审核方 devloop.mjs 与云端审核 cloud.mjs 共用）。
 */
import { marker } from './policy.mjs';

/** 云端审核以 GITHUB_TOKEN 发评论；gh pr view 显示为 github-actions，REST 显示为 github-actions[bot] */
export const CLOUD_REVIEWER_LOGINS = ['github-actions', 'github-actions[bot]'];

export function buildReviewPrompt({ header, pr, meta, base, stat }) {
  return [
    header,
    `\n## 本次 PR\n\n- 编号：#${pr}\n- 标题：${meta.title}\n- 审核提交：${meta.headRefOid}\n- 基准：${meta.baseRefName}（${base}）`,
    `\n### PR 描述（执行者所写，仅供参考，需自行核对）\n\n${meta.body}`,
    `\n### 改动文件\n\n\`\`\`\n${stat}\n\`\`\``,
    `\n用 \`git diff ${base}...HEAD\` 查看完整改动。测试与构建由 CI 在合并后的代码上另行执行，你只需审代码。`,
  ].join('\n');
}

export function formatReview({ key, model, where, pr, head, review, ci, d }) {
  const sev = { blocker: '🛑 blocker', major: '⚠️ major', minor: '💬 minor' };
  const findings = review.findings.length
    ? review.findings.map((f, i) => `${i + 1}. **${sev[f.severity]}** \`${f.file}:${f.line}\`\n   - 问题：${f.issue}\n   - 建议：${f.suggestion}`).join('\n')
    : '无。';
  const ciText = { ok: '✅ 通过', failed: '❌ 失败', error: '⚠️ 未完成' }[ci.status];
  return [
    `执行者：GPT（${model}，${where}；独立于代码执行者 Claude）`,
    '',
    `**结论：${review.verdict === 'approve' ? '✅ 通过' : review.verdict === 'error' ? '⚠️ 审核未完成' : '🔁 需修改'}**（审核提交 \`${head.slice(0, 8)}\`）`,
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
    marker(key, { pr, state: d.state, reason: d.reason, head, base: ci.base }),
  ].join('\n');
}

/** PR 是否改动工作流文件：GITHUB_TOKEN 无 workflows 权限，这类 PR 云端合并不了，交给本机审核方 */
export function touchesWorkflows(paths) {
  return paths.some((p) => p.startsWith('.github/workflows/'));
}
