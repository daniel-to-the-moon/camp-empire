#!/usr/bin/env node
/**
 * claude-design-review.yml 的触发判定：Claude 只读设计首评。由 design-review-gate.test.mjs 覆盖。
 *
 * 规则（用户 2026-11-28 批准的设计）：
 * - issues.labeled，新加的标签是 proposal / discussion → mode=first（首评）。
 *   要求：不是 PR、issue 打开着、打标签者是仓库所有者且不是机器人（仓库公开，控制费用与滥用）、
 *   当前标签不含 devloop / gpt-design。事件里的标签可能过时，design-review-build.mjs 会按重新读到的标签再判一次。
 * - issues.edited 且改了正文（changes.body 存在）→ mode=status：只更新首评评论里的「待复评」状态行，不调模型。
 * - workflow_dispatch：issue=<正整数> → mode=first；dry_run 默认 true；给了 fixture 时强制 dry_run。
 * 带标签新建 issue 不处理 opened：GitHub 会为每个标签另发 labeled 事件，由并发队列 + 去重标记保证只评一次。
 *
 * 用法：OWNER=<仓库所有者> node design-review-gate.mjs <事件名> <事件 JSON 路径>
 * 结果写 $GITHUB_OUTPUT：run、issue、mode（first|status）、dry、reason
 */
import { appendFileSync, readFileSync } from 'node:fs';

export const REVIEW_LABELS = ['proposal', 'discussion'];
export const EXCLUDE_LABELS = ['devloop', 'gpt-design'];

const names = (issue) => (issue?.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter(Boolean);
export const excluded = (labels) => labels.filter((l) => EXCLUDE_LABELS.includes(l));
const isBot = (u) => u?.type === 'Bot' || /\[bot\]$/.test(u?.login ?? '');
const truthy = (v) => v === true || v === 'true';

export function gate(eventName, event, owner) {
  const no = (reason) => ({ run: false, issue: null, mode: null, dry: false, reason });
  const yes = (issue, mode, reason, dry = false) => ({ run: true, issue, mode, dry, reason });

  if (eventName === 'workflow_dispatch') {
    const n = String(event?.inputs?.issue ?? '');
    const fixture = String(event?.inputs?.fixture ?? '');
    if (fixture) {
      if (!/^[a-z0-9-]+$/.test(fixture)) return no(`fixture 名非法：${fixture}`);
      return yes(0, 'first', `手动试跑 fixture ${fixture}`, true);
    }
    if (!/^[1-9]\d*$/.test(n)) return no(`编号无效：${n}`);
    // dry_run 是 boolean 输入，未给时按 true（默认试跑，不发评论）
    const dry = event?.inputs?.dry_run === undefined ? true : truthy(event.inputs.dry_run);
    return yes(Number(n), 'first', dry ? '手动触发（试跑）' : '手动触发', dry);
  }

  if (eventName !== 'issues') return no(`不处理事件 ${eventName}`);
  const issue = event?.issue;
  if (!issue || issue.pull_request) return no('不是 issue');

  if (event.action === 'labeled') {
    const label = event.label?.name;
    if (!REVIEW_LABELS.includes(label)) return no('打的不是 proposal / discussion');
    if (issue.state && issue.state !== 'open') return no('issue 已关闭');
    if (isBot(event.sender)) return no('机器人打的标签');
    if (!owner || event.sender?.login !== owner) return no('打标签者不是仓库所有者');
    const ex = excluded(names(issue));
    if (ex.length) return no(`已带 ${ex.join(' / ')}，不做设计首评`);
    return yes(issue.number, 'first', `打上 ${label} 标签`);
  }

  if (event.action === 'edited') {
    if (!event.changes || !('body' in event.changes)) return no('没有改正文');
    if (!names(issue).some((l) => REVIEW_LABELS.includes(l))) return no('issue 不带 proposal / discussion');
    return yes(issue.number, 'status', '正文已编辑');
  }

  return no(`不处理 issues.${event.action}`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [eventName, path] = process.argv.slice(2);
  const r = gate(eventName, JSON.parse(readFileSync(path, 'utf8')), process.env.OWNER);
  const out = `run=${r.run}\nissue=${r.issue ?? ''}\nmode=${r.mode ?? ''}\ndry=${r.dry}\nreason=${r.reason}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, out);
  process.stdout.write(out);
}
