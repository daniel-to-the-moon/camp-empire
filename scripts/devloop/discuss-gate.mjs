#!/usr/bin/env node
/**
 * gpt-discuss.yml 的触发判定：这次事件要不要让 GPT 在讨论 issue 下发言。由 discuss-gate.test.mjs 覆盖。
 *
 * 规则（控制费用：只在明确时机发言，不是每条评论都跑）：
 * - issue 新建时就带 discussion / proposal 标签 → 发言
 * - issue 被打上 discussion / proposal 标签 → 发言
 * - 在带这两个标签的 issue（不是 PR）下评论里写 @gpt → 发言；机器人评论、GPT 自己的评论不触发
 * - 手动触发（workflow_dispatch，输入 issue 编号）→ 发言
 *
 * 用法：node discuss-gate.mjs <事件名> <事件 JSON 路径>；结果写到 $GITHUB_OUTPUT（run=true|false、issue=<编号>、reason=…）
 */
import { appendFileSync, readFileSync } from 'node:fs';

export const DISCUSS_LABELS = ['discussion', 'proposal'];
const hasDiscussLabel = (issue) => (issue?.labels ?? []).some((l) => DISCUSS_LABELS.includes(typeof l === 'string' ? l : l.name));

export function gate(eventName, event) {
  const no = (reason) => ({ run: false, issue: null, reason });
  const yes = (issue, reason) => ({ run: true, issue, reason });
  if (eventName === 'workflow_dispatch') {
    const n = String(event?.inputs?.issue ?? '');
    return /^[1-9]\d*$/.test(n) ? yes(Number(n), '手动触发') : no(`编号无效：${n}`);
  }
  const issue = event?.issue;
  if (!issue || issue.pull_request) return no('不是 issue');
  if (eventName === 'issues') {
    if (event.action === 'opened') return hasDiscussLabel(issue) ? yes(issue.number, '新建讨论 issue') : no('新建 issue 不带讨论标签');
    if (event.action === 'labeled') {
      return DISCUSS_LABELS.includes(event.label?.name) ? yes(issue.number, `打上 ${event.label.name} 标签`) : no('打的不是讨论标签');
    }
    return no(`不处理 issues.${event.action}`);
  }
  if (eventName === 'issue_comment') {
    if (event.action !== 'created') return no('不是新评论');
    if (!hasDiscussLabel(issue)) return no('issue 不带讨论标签');
    const c = event.comment ?? {};
    if (c.user?.type === 'Bot' || /\[bot\]$/.test(c.user?.login ?? '')) return no('机器人评论');
    const body = String(c.body ?? '');
    if (body.startsWith('执行者：GPT')) return no('GPT 自己的评论');
    return /(^|[^\w@])@gpt\b/i.test(body) ? yes(issue.number, '评论里点名 @gpt') : no('评论未点名 @gpt');
  }
  return no(`不处理事件 ${eventName}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [eventName, path] = process.argv.slice(2);
  const r = gate(eventName, JSON.parse(readFileSync(path, 'utf8')));
  const out = `run=${r.run}\nissue=${r.issue ?? ''}\nreason=${r.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  process.stdout.write(out);
}
