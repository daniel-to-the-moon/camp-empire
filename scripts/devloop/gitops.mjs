/**
 * devloop 的 git 操作与 CI 运行匹配（不调用 gh / GitHub API，可在本地临时仓库上做集成测试，见 gitops.test.mjs）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

export const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** 每次调用都用不同的临时工作区目录，不同进程互不删除对方的目录 */
export function uniqueDir(home, prefix) {
  return join(home, `${prefix}-${process.pid}-${randomBytes(4).toString('hex')}`);
}

export function withWorktree(repoDir, dir, rev, fn) {
  git(['worktree', 'add', '-q', '--detach', dir, rev], repoDir);
  try {
    return fn(dir);
  } finally {
    spawnSync('git', ['worktree', 'remove', '--force', dir], { cwd: repoDir });
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * 在 base 上生成 `git merge --no-ff head`（与 CI 相同），普通推送到 remote 的 main。
 * main 已不是 base 时推送是非快进而被拒，抛出异常。beforePush 在推送前一刻调用，可抛异常中止（例如 PR 状态已变）。
 * 成功后，若 branch 给出，只在它仍指向 head 时删除（租约）。返回 { sha, branchDeleted }。
 */
export function mergeAndPush({ repoDir, home, remote = 'origin', base, head, message, branch, beforePush = () => {} }) {
  const dir = uniqueDir(home, 'merge');
  return withWorktree(repoDir, dir, base, (wt) => {
    git(['-c', 'user.name=devloop', '-c', 'user.email=devloop@localhost', 'merge', '--no-ff', '--no-edit', '-m', message, head], wt);
    const sha = git(['rev-parse', 'HEAD'], wt);
    beforePush();
    git(['push', '-q', remote, `${sha}:refs/heads/main`], wt);
    let branchDeleted = false;
    if (branch) {
      const r = spawnSync('git', ['push', '-q', `--force-with-lease=refs/heads/${branch}:${head}`, remote, `:refs/heads/${branch}`], { cwd: repoDir });
      branchDeleted = r.status === 0;
    }
    return { sha, branchDeleted };
  });
}

/** 从 pull_request 事件的 CI 运行里找 head 与 base 都吻合、已完成的那次 */
export function matchPrRun(runs, { pr, head, base, workflowPath = '.github/workflows/ci.yml' }) {
  return (
    runs.find(
      (r) =>
        r.path === workflowPath &&
        r.status === 'completed' &&
        r.pull_requests?.some((p) => p.number === pr && p.head.sha === head && p.base.sha === base),
    ) ?? null
  );
}

/** 审核结论缓存键：代码（head）与基准（base）都相同才复用 */
export function reviewCacheKey(pr, head, base) {
  return `review-${pr}-${head}-${base}.json`;
}

/**
 * 判定权领取（#42）：本机与云端审核方共享的原子领取，避免同一 PR/head 被两边同时判定、重复评论与重复触发修复。
 * 领取引用 refs/devloop/claim/pr-<N>-<head> 指向一个空树根提交（不含任何文件，不会被当作“改动工作流”拒推），
 * 提交说明记领取方，提交时间即领取时间。
 * - 创建用 `git push --force-with-lease=<ref>:`（要求远端引用不存在）——远端的引用更新是原子的，两方同时推只有一方成功；
 * - 判定、合并、评论、触发后续都在持有领取期间完成；
 * - 结论为终态（changes / merged / stopped）时**保留**领取：该 head 已处理完，晚到的一方即使读到尚未刷新的评论列表，
 *   也会因领取失败而跳过。非终态（retry、跳过）或中途异常时用 release 按自己的 sha 租约删除，下一轮可重新领取；
 * - 领取引用在 PR 不再打开（合并或关闭）后由 pruneClaims 清理；
 * - 持有方崩溃留下的引用超过 staleMs（默认 30 分钟，提案值，待核实：持有期只含合并推送 + 评论 + 后续触发及其有界重试，
 *   按 finalize 3 次重试、5s/10s 退避估计在几分钟内）后，可用旧 sha 作租约原子接管，仍只有一方成功；
 *   接管方随后读 PR 状态，若该 head 已有终态标记照常跳过。
 * 返回 { ok: true, ref, sha, takeover, release() } 或 { ok: false, ref, reason }（引用已被他方持有）；
 * 推送失败但远端并无该引用（网络、权限等）→ 抛错，让问题可见，而不是每轮静默跳过。
 */
export const claimRef = (pr, head) => `refs/devloop/claim/pr-${pr}-${head}`;

export function claimDecision({ repoDir, remote = 'origin', pr, head, holder, now = Date.now, staleMs = 30 * 60_000 }) {
  const ref = claimRef(pr, head);
  const t = Math.floor(now() / 1000);
  const tree = execFileSync('git', ['mktree'], { cwd: repoDir, input: '', encoding: 'utf8' }).trim();
  const sha = execFileSync('git', ['-c', 'user.name=devloop', '-c', 'user.email=devloop@localhost', 'commit-tree', tree,
    '-m', `devloop claim pr=${pr} head=${head} holder=${holder} nonce=${randomBytes(4).toString('hex')}`], {
    cwd: repoDir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_DATE: `@${t} +0000`, GIT_COMMITTER_DATE: `@${t} +0000` },
  }).trim();
  const push = (lease) => spawnSync('git', ['push', '-q', `--force-with-lease=${ref}:${lease}`, remote, `${sha}:${ref}`], { cwd: repoDir, encoding: 'utf8' });
  const release = () => spawnSync('git', ['push', '-q', `--force-with-lease=${ref}:${sha}`, remote, `:${ref}`], { cwd: repoDir }).status === 0;
  const first = push('');
  if (first.status === 0) return { ok: true, ref, sha, takeover: false, release };
  const old = git(['ls-remote', remote, ref], repoDir).split(/\s+/)[0];
  if (!old) throw new Error(`领取判定权失败（远端没有该领取引用，推送本身出错）：${(first.stderr || '').trim().split('\n')[0]}`);
  git(['fetch', '-q', remote, ref], repoDir);
  const [at, ...msg] = git(['log', '-1', '--format=%ct%n%s', old], repoDir).split('\n');
  const by = (msg.join(' ').match(/holder=(\S+)/) ?? [])[1] ?? '未知';
  if (t - Number(at) <= staleMs / 1000) return { ok: false, ref, reason: `判定权已被 ${by} 领取` };
  if (push(old).status === 0) return { ok: true, ref, sha, takeover: true, release };
  return { ok: false, ref, reason: `接管 ${by} 的过期领取时被他方抢先` };
}

/**
 * 清理已不再打开的 PR 的领取引用（isOpen(pr) 为 false 的）。按读到的 sha 租约删除，删除失败（他方刚改过）就留到下次。
 * 返回删除的引用名列表。
 */
export function pruneClaims({ repoDir, remote = 'origin', isOpen }) {
  const lines = git(['ls-remote', remote, 'refs/devloop/claim/*'], repoDir).split('\n').filter(Boolean);
  const removed = [];
  for (const line of lines) {
    const [sha, ref] = line.split(/\s+/);
    const m = ref.match(/^refs\/devloop\/claim\/pr-(\d+)-[0-9a-f]+$/);
    if (!m || isOpen(Number(m[1]))) continue;
    if (spawnSync('git', ['push', '-q', `--force-with-lease=${ref}:${sha}`, remote, `:${ref}`], { cwd: repoDir }).status === 0) removed.push(ref);
  }
  return removed;
}

/**
 * 进程锁：同一时刻只允许一个 devloop 进程审核或合并。拿到返回释放函数，拿不到返回 null。
 * 用操作系统的端口独占实现：监听 127.0.0.1 上的固定端口，同一端口只能被一个进程监听，
 * 进程退出（含崩溃）时由系统自动释放——不存在“过期锁”，也就没有接管竞态（GPT 审核 #6 第五、六轮 major）。
 */
export async function acquireLock(port = Number(process.env.DEVLOOP_LOCK_PORT ?? 47831)) {
  const server = createServer();
  server.unref();
  const ok = await new Promise((resolve, reject) => {
    server.once('error', (e) => (e.code === 'EADDRINUSE' ? resolve(false) : reject(e)));
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(true));
  });
  if (!ok) return null;
  return () => new Promise((r) => server.close(() => r()));
}
