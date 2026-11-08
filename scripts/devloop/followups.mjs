/**
 * auto 模式轮次用满合并后的遗留意见 issue：幂等创建（本机 devloop.mjs 与云端 cloud.mjs 共用）。
 *
 * - 每条意见有稳定标识 key = pr + 审核 head + 序号，写进 issue 正文的标记 <!-- devloop-followup key=… -->；
 * - 创建前先列出已有 devloop issue（REST 列表，强一致，不用有索引延迟的搜索）查标记，已存在就复用；
 * - issue create 不是幂等的：失败（可能服务端已创建、只是响应丢了）后先重新核对远端，再决定是否重试；
 * - 本机把待办清单落盘，合并后的评论或某条 issue 失败都不丢：下一轮 watch 继续补齐（已合并的 PR 不会再被扫描）。
 */
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * 本机待办清单：dir/pr-<N>.json = { pr, head, items, flagged? }（合并前落盘）。逐个补开 issue；全部开齐才发清单评论并删除文件，
 * 否则保留到下一轮（首次失败给 PR 加 needs-user，让用户看得见）。
 * io：ensureFollowUps 的 io + { comment(pr, text), flag(pr), log(msg) }
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

async function drainLocked({ dir, io, opts }) {
  for (const name of readdirSync(dir).filter((n) => /^pr-\d+\.json$/.test(n))) {
    const file = join(dir, name);
    const { pr, head, items, flagged } = JSON.parse(readFileSync(file, 'utf8'));
    // 待办在合并前落盘：先核对 PR 是否真的以该 head 合并。还开着 → 留到下次；关闭未合并或以别的提交合并 → 撤回
    if (io.prStatus) {
      let st;
      try { st = await io.prStatus(pr); } catch (e) { io.log(`#${pr} 查询合并状态失败，下一轮再补：${String(e.message).split('\n')[0]}`); continue; }
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
          writeFileSync(file, JSON.stringify({ pr, head, items, flagged: true }));
        } catch { /* 尽力 */ }
      }
      continue;
    }
    try {
      io.comment(pr, `执行者：devloop\n\n遗留意见已转为 devloop issue：${Object.values(r.numbers).map((n) => `#${n}`).join('、')}`);
    } catch { /* 清单评论尽力而为；issue 已开齐 */ }
    rmSync(file, { force: true });
  }
}

// ---------------- 云端：可恢复的遗留意见收尾 ----------------
// 云端 runner 随时可能被取消或超时，内存里的进度会丢。持久化记录放在 GitHub 上：
//   合并推送之前，先在 PR 上发“遗留意见记录”评论（发不出就不合并）；收尾全部完成后再发“已完成”评论。
//   定时的恢复任务扫描最近合并的 PR：有记录、无完成标记 → 重新收尾（幂等）。

export const RECORD_MARK = '<!-- devloop-followups ';
export const DONE_MARK = '<!-- devloop-followups-done ';
export const DISPATCH_MARK = '<!-- devloop-dispatch ';
/** 同一 issue 的实现触发间隔下限：claude.yml 任务超时 90 分钟，超过 2 小时仍无分支即视为上次触发未生效 */
export const REDISPATCH_AFTER_MS = 2 * 60 * 60 * 1000;

export function recordComment({ pr, head, items }) {
  const b64 = Buffer.from(JSON.stringify(items), 'utf8').toString('base64');
  return `执行者：devloop（云端审核）\n\n轮次用满按 auto 模式合并前登记 ${items.length} 条遗留意见，合并后逐条开 devloop issue 并触发实现。\n\n${RECORD_MARK}pr=${pr} head=${head} b64=${b64} -->`;
}

export function doneComment({ pr, head, numbers }) {
  return `执行者：devloop（云端审核）\n\n遗留意见已转为 devloop issue 并已触发实现：${numbers.map((n) => `#${n}`).join('、')}\n\n${DONE_MARK}pr=${pr} head=${head} -->`;
}

/** 从 PR 评论（[{ author, body }]，只传可信作者的）中找到某 head 的记录与完成标记 */
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
 * 某遗留 issue 的触发状态：
 * - settled：已关闭、带 needs-user（执行者已停下等用户）、或已有 claude/issue-N 分支（实现已产出）→ 无需触发；
 * - cooldown：2 小时内有触发标记但还没有分支 → 可能正在实现，也可能上次触发没生效；暂不重复触发，但也不算完成；
 * - due：从未触发，或上次触发超过 2 小时仍无分支 → 应触发。
 */
export function dispatchState(info, now) {
  if (info.state !== 'OPEN' || info.labels.includes('needs-user') || info.branch) return 'settled';
  const last = info.comments.filter((c) => String(c.body ?? '').includes(DISPATCH_MARK)).map((c) => Date.parse(c.createdAt)).filter(Number.isFinite);
  return !last.length || now - Math.max(...last) >= REDISPATCH_AFTER_MS ? 'due' : 'cooldown';
}

export function shouldDispatch(info, now) {
  return dispatchState(info, now) === 'due';
}

/**
 * 收尾（幂等，可重复执行）：确保每条遗留意见有 issue → 对需要的 issue 先记触发标记、再触发实现 → 全部完成后发完成评论。
 * io：ensureFollowUps 的 io + { issueInfo(n) → { state, labels, branch, comments:[{body, createdAt}] }, markDispatch(n), dispatch(n), done(numbers), now() }
 * 先记标记再触发：中断在两者之间时，2 小时后的恢复会补触发；不会在 2 小时内重复启动。
 */
export async function completeFollowUps(items, io, opts) {
  const r = await ensureFollowUps(items, io, opts);
  const failed = r.failed.map((f) => ({ what: `开 issue（${f.key}）`, err: f.err }));
  const pending = []; // 冷却期内、尚未确认已触发（无分支）的 issue：不算完成，留给下一轮恢复
  const numbers = Object.values(r.numbers);
  for (const n of numbers) {
    try {
      const info = await io.issueInfo(n);
      const st = dispatchState(info, io.now());
      if (st === 'settled') continue; // 已有分支 / 已关闭 / needs-user：无需（再）触发
      if (st === 'cooldown') { pending.push(n); continue; }
      await io.markDispatch(n);
      await io.dispatch(n); // 本轮确认触发成功
    } catch (e) {
      failed.push({ what: `触发 issue #${n} 的实现`, err: String(e.message).split('\n')[0] });
    }
  }
  // 只有每条都“已确认触发 / 无需触发”才发完成标记；有失败或冷却中未确认的，保持待恢复
  if (!failed.length && !pending.length) {
    try { await io.done(numbers); } catch (e) { failed.push({ what: '发完成评论', err: String(e.message).split('\n')[0] }); }
  }
  return { numbers, failed, pending };
}
