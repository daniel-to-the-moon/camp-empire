/**
 * 读取 PR 状态（含审核方签名标记）。从 devloop.mjs 拆出，便于用假 gh 测试整条查询链路。
 *
 * 审核方账号每次读取都重新查询（`gh api user`），不在启动时缓存：
 * GitHub 账号改名后，历史评论的作者也显示为新用户名；若缓存旧名，审核方会认不出自己的签名标记，
 * 对同一提交反复评论并重复触发云端修复（2026-11-07 在 #4 实际发生）。
 */
import { parseMarkers } from './policy.mjs';

const FIELDS = 'title,body,headRefOid,headRefName,isCrossRepository,baseRefName,state,isDraft,mergeable,labels,comments';

/**
 * gh(args) → stdout 字符串：原样执行 gh（不自动追加 -R）。
 * 返回 prState(pr)：每次调用都重新查询审核方登录名与 PR。
 */
export function createPrState({ gh, repo, key }) {
  return function prState(pr) {
    const m = JSON.parse(gh(['pr', 'view', String(pr), '--json', FIELDS, '-R', repo]));
    const reviewer = gh(['api', 'user', '-q', '.login']).trim();
    const comments = m.comments.map((c) => ({ author: c.author?.login ?? '', body: c.body }));
    return { ...m, labels: m.labels.map((l) => l.name), markers: parseMarkers(comments, { key, reviewer, pr }) };
  };
}
