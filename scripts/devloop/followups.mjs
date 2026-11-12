/**
 * auto 模式轮次用满合并后的遗留意见 issue：幂等创建（本机 devloop.mjs 与云端 cloud.mjs 共用）。
 *
 * - 每条意见有稳定标识 key = pr + 审核 head + 序号，写进 issue 正文的标记 <!-- devloop-followup key=… -->；
 * - 创建前先列出已有 devloop issue（REST 列表，强一致，不用有索引延迟的搜索）查标记，已存在就复用；
 * - issue create 不是幂等的：失败（可能服务端已创建、只是响应丢了）后先重新核对远端，再决定是否重试；
 * - 本机把待办清单落盘，合并后的评论或某条 issue 失败都不丢：下一轮 watch 继续补齐（已合并的 PR 不会再被扫描）。
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { followUpIssues } from './review-format.mjs';

export const FOLLOWUP_MARK = '<!-- devloop-followup key=';

export function followUpItems({ pr, head, findings }) {
  return followUpIssues({ pr, head, findings }).map((it, i) => {
    const key = `pr${pr}-${String(head).slice(0, 12)}-${i + 1}`;
    return { key, title: it.title, body: `${it.body}\n\n${FOLLOWUP_MARK}${key} -->` };
  });
}

/** 从 issue 列表（[{ number, body }]）里找带某个 key 标记的 issue 编号 */
export function findByKey(issues, key) {
  const want = `${FOLLOWUP_MARK}${key} -->`;
  return issues.find((x) => String(x.body ?? '').includes(want))?.number ?? null;
}

/**
 * io：{ list(): [{number, body}]（打开与关闭的 devloop issue）, create(item): 返回输出（含 /issues/<n>）, sleep(ms) }
 * 返回 { numbers: { key: n }, created: [n…], failed: [{ key, err }] }；绝不对同一 key 创建两个 issue（在 list 可信的前提下）。
 */
export async function ensureFollowUps(items, io, { attempts = 3, delayMs = 5000 } = {}) {
  const numbers = {};
  const created = [];
  const failed = [];
  for (const it of items) {
    let n = null;
    let err = '';
    for (let i = 0; i < attempts && n === null; i++) {
      try {
        n = findByKey(await io.list(), it.key);
        if (n !== null) break;
      } catch (e) {
        err = `查询已有 issue 失败：${String(e.message).split('\n')[0]}`;
        if (i < attempts - 1) await io.sleep(delayMs * (i + 1));
        continue; // 查不到远端状态就不创建，避免重复
      }
      try {
        const out = String(await io.create(it));
        const m = /\/issues\/(\d+)\s*$/.exec(out.trim());
        if (m) {
          n = Number(m[1]);
          created.push(n);
          break;
        }
        err = `无法识别新 issue 编号：${out.slice(0, 80)}`;
      } catch (e) {
        err = String(e.message).split('\n')[0];
      }
      if (i < attempts - 1) await io.sleep(delayMs * (i + 1)); // 下一次先重新核对远端，再决定是否创建
    }
    if (n === null) failed.push({ key: it.key, err });
    else numbers[it.key] = n;
  }
  return { numbers, created, failed };
}

/**
 * 本机待办清单：dir/pr-<N>.json = { pr, head, items, flagged? }（合并前落盘）。
 * 提供了 io.prStatus 时，先核对 PR：仍打开或查询失败则保留且不创建；未以该 head 合并则删除且不创建；
 * 确认合并后才逐个补开 issue。全部开齐才发清单评论并删除文件，否则保留到下一轮（首次失败给 PR 加 needs-user）。
 * io：ensureFollowUps 的 io + { comment(pr, text), flag(pr), log(msg), prStatus?(pr), writeJson?(file, data) }
 * acquire()：进程间互斥锁，返回 release 或 null（忙）；默认不加锁（调用方已持锁）
 */
export async function drainPending({ dir, io, opts, acquire = async () => () => {} }) {
  if (!existsSync(dir)) return;
  // 读取清单、查询远端、创建、清理全程持有进程间互斥锁：两个处理者交错时同一 key 只会创建一次。
  // 拿不到锁（另一个进程正在审核或补开）就跳过本轮，下一轮再补。调用方已持锁时传入空操作的 acquire。
  const release = await acquire();
  if (!release) return;
  try {
    await drainLocked({ dir, io, opts });
  } finally {
    await release();
  }
}

/** 原子写：写临时文件再 rename。写入失败时不替换原文件。 */
export function writeJsonAtomic(file, data, { write = writeFileSync, rename = renameSync } = {}) {
  const tmp = `${file}.tmp`;
  write(tmp, JSON.stringify(data));
  rename(tmp, file);
}

async function drainLocked({ dir, io, opts }) {
  for (const name of readdirSync(dir).filter((n) => /^pr-\d+\.json$/.test(n))) {
    const file = join(dir, name);
    let rec;
    try {
      rec = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      io.log(`${name} 无法解析，跳过（不影响其他待办）：${String(e.message).split('\n')[0]}`);
      continue;
    }
    const { pr, head, items, flagged } = rec;
    // 合并前就落了盘。未确认以该 head 合并之前，不调用 ensureFollowUps（不创建 issue）。
    if (io.prStatus) {
      let st;
      try { st = await io.prStatus(pr); } catch (e) {
        io.log(`#${pr} 查询合并状态失败，下一轮再补：${String(e.message).split('\n')[0]}`);
        continue;
      }
      if (st.state === 'OPEN') continue;
      if (st.state !== 'MERGED' || (head && st.headRefOid !== head)) {
        io.log(`#${pr} 未以 ${String(head).slice(0, 8)} 合并（${st.state}），撤回遗留意见待办`);
        rmSync(file, { force: true });
        continue;
      }
    }
    const r = await ensureFollowUps(items, io, opts);
    if (r.failed.length) {
      io.log(`#${pr} 遗留意见 issue 有 ${r.failed.length} 条未开成功，下一轮继续：${r.failed.map((f) => f.err).join('；')}`);
      if (!flagged) {
        try {
          io.flag(pr);
          (io.writeJson ?? writeJsonAtomic)(file, { pr, head, items, flagged: true });
        } catch { /* 尽力：失败时原文件不变，下一轮照常补 */ }
      }
      continue;
    }
    try {
      io.comment(pr, `执行者：devloop\n\n遗留意见已转为 devloop issue：${Object.values(r.numbers).map((n) => `#${n}`).join('、')}`);
    } catch { /* 清单评论尽力而为；issue 已开齐 */ }
    rmSync(file, { force: true });
  }
}

// ---------------- 恢复状态（库函数，生产入口未调用）----------------
// 这些函数描述“记录是否完整、是否该视为已完成、查询失败时是否继续”。
// cloud.mjs、devloop.mjs 与 .github/workflows 都不调用它们。
// 只有调用方注入的 io.create / io.dispatch 才会开 issue 或触发工作流；本仓库没有这样的生产 io。
// 自动 recover、开 issue、Claude dispatch 的接线见 docs/DEVLOOP_FOLLOWUP_RECOVERY.md，默认不启用。

export const RECORD_MARK = '<!-- devloop-followups ';
export const DONE_MARK = '<!-- devloop-followups-done ';
export const DISPATCH_MARK = '<!-- devloop-dispatch ';
/** 同一 issue 的实现触发间隔下限。继承 #47：claude.yml 任务超时 90 分钟，超过 2 小时仍无分支视为上次触发未生效。本常量未被生产入口使用。 */
export const REDISPATCH_AFTER_MS = 2 * 60 * 60 * 1000;
/** #47 用过的待恢复标签名。本模块不调用打标签或摘标签的接口。 */
export const FOLLOWUP_LABEL = 'devloop-followups';

export function recordComment({ pr, head, items }) {
  const b64 = Buffer.from(JSON.stringify(items), 'utf8').toString('base64');
  return `执行者：devloop（云端审核）\n\n轮次用满按 auto 模式合并前登记 ${items.length} 条遗留意见，合并后逐条开 devloop issue 并触发实现。\n\n${RECORD_MARK}pr=${pr} head=${head} b64=${b64} -->`;
}

export function doneComment({ pr, head, numbers }) {
  return `执行者：devloop（云端审核）\n\n遗留意见已转为 devloop issue 并已触发实现：${numbers.map((n) => `#${n}`).join('、')}\n\n${DONE_MARK}pr=${pr} head=${head} -->`;
}

/** 从评论（[{ body }]）中找某 head 的记录与完成标记。损坏的 base64 忽略，不抛错。 */
export function parseRecord(comments, { pr, head }) {
  let items = null;
  let done = false;
  for (const c of comments) {
    const r = new RegExp(`${RECORD_MARK}pr=${pr} head=${head} b64=([A-Za-z0-9+/=]+) -->`).exec(c.body ?? '');
    if (r) {
      try { items = JSON.parse(Buffer.from(r[1], 'base64').toString('utf8')); } catch { /* 损坏的记录忽略 */ }
    }
    if (String(c.body ?? '').includes(`${DONE_MARK}pr=${pr} head=${head} -->`)) done = true;
  }
  return { items, done };
}

/**
 * 某遗留 issue 的触发状态（纯函数，不访问网络）：
 * - settled：已关闭、带 needs-user，或已有实现分支；
 * - cooldown：有活动中的实现任务，或 2 小时内有触发标记但还没有分支；
 * - due：从未触发，或上次触发超过 2 小时、没有活动任务、仍无分支。
 */
export function dispatchState(info, now) {
  if (info.state !== 'OPEN' || info.labels.includes('needs-user') || info.branch) return 'settled';
  if (info.activeRun) return 'cooldown';
  const last = info.comments.filter((c) => String(c.body ?? '').includes(DISPATCH_MARK)).map((c) => Date.parse(c.createdAt)).filter(Number.isFinite);
  return !last.length || now - Math.max(...last) >= REDISPATCH_AFTER_MS ? 'due' : 'cooldown';
}

export function shouldDispatch(info, now) {
  return dispatchState(info, now) === 'due';
}

/**
 * 收尾状态机（幂等，可重复调用）。不自带 GitHub 客户端。
 * io.create / io.dispatch 由调用方注入；本函数在本仓库的生产入口中没有调用方。
 * 触发被接受后仍放入 pending，不调用 io.done：派发成功不等于实现已经产出。
 * io.issueInfo 抛错（例如分支查询不是 404）时记入 failed，不记触发标记、不触发、不调用 io.done。
 */
export async function completeFollowUps(items, io, opts) {
  const r = await ensureFollowUps(items, io, opts);
  const failed = r.failed.map((f) => ({ what: `开 issue（${f.key}）`, err: f.err }));
  const pending = [];
  const numbers = Object.values(r.numbers);
  for (const n of numbers) {
    try {
      const info = await io.issueInfo(n);
      const st = dispatchState(info, io.now());
      if (st === 'settled') continue;
      if (st === 'cooldown') { pending.push(n); continue; }
      await io.markDispatch(n);
      await io.dispatch(n);
      pending.push(n);
    } catch (e) {
      failed.push({ what: `触发 issue #${n} 的实现`, err: String(e.message).split('\n')[0] });
    }
  }
  if (!failed.length && !pending.length) {
    try { await io.done(numbers); } catch (e) { failed.push({ what: '发完成评论', err: String(e.message).split('\n')[0] }); }
  }
  return { numbers, failed, pending };
}

/** 分支是否存在。只有明确的 404 返回 false；超时、限流、5xx 向上抛。gh 由调用方注入，本函数不发子进程。 */
export function branchExists(gh, repo, branch) {
  try {
    gh(['api', `repos/${repo}/git/ref/heads/${branch}`]);
    return true;
  } catch (e) {
    const text = `${e.message ?? ''}\n${e.stderr ?? ''}`;
    if (/\bHTTP 404\b|Not Found/.test(text)) return false;
    throw new Error(`查询分支 ${branch} 失败：${String(e.message).split('\n')[0]}`);
  }
}

/** 未完成运行的状态名。hasActiveRun 用它们向注入的 ghR 做只读列表查询。 */
export const ACTIVE_RUN_STATUSES = ['queued', 'in_progress', 'waiting', 'requested', 'pending'];

/** 某 issue 是否有排队或运行中的实现任务。只读；不创建运行。生产入口不调用。 */
export function hasActiveRun(ghR, n) {
  return ACTIVE_RUN_STATUSES.some((st) =>
    JSON.parse(ghR(['run', 'list', '--workflow', 'claude.yml', '--status', st, '--limit', '1000', '--json', 'displayTitle']))
      .some((r) => r.displayTitle === `claude issue#${n}`));
}

/**
 * 只读列出带待恢复标签的已合并 PR，再用分页评论接口读完全部评论。
 * gh pr list 的 comments 字段只有前 100 条，所以这里不请求该字段。生产入口不调用。
 */
export function listRecoverable(ghR, gh, repo) {
  return JSON.parse(ghR(['pr', 'list', '--state', 'merged', '--base', 'main', '--label', FOLLOWUP_LABEL, '--limit', '1000', '--json', 'number,headRefOid']))
    .map((p) => ({ ...p, comments: allComments(gh, repo, p.number) }));
}

export function allComments(gh, repo, n) {
  return gh(['api', '--paginate', `repos/${repo}/issues/${n}/comments?per_page=100`, '--jq', '.[] | {author: .user.login, body}'])
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/**
 * 对“有记录、无完成标记”的 PR 调用 completeFollowUps。不扫描网络，不注册定时任务。
 * 只认 github-actions / github-actions[bot] 的评论。生产入口不调用。
 */
export async function recoverFollowUps(prs, io, opts) {
  const results = [];
  for (const p of prs) {
    const trusted = p.comments.filter((c) => ['github-actions', 'github-actions[bot]'].includes(c.author?.login ?? c.author));
    const { items, done } = parseRecord(trusted, { pr: p.number, head: p.headRefOid });
    if (!items || done) continue;
    results.push({ pr: p.number, ...(await completeFollowUps(items, io(p.number, p.headRefOid), opts)) });
  }
  return results;
}
