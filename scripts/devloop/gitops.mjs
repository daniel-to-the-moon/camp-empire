/**
 * devloop 的 git 操作与 CI 运行匹配（不调用 gh / GitHub API，可在本地临时仓库上做集成测试，见 gitops.test.mjs）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
 * 进程锁：同一时刻只允许一个 devloop 进程审核或合并。持锁进程已退出时视为过期锁并接管。
 * 返回释放函数；拿不到锁返回 null。
 */
export function acquireLock(home) {
  mkdirSync(home, { recursive: true });
  const f = join(home, 'devloop.lock');
  for (let i = 0; i < 2; i++) {
    try {
      const fd = openSync(f, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        if (existsSync(f) && readFileSync(f, 'utf8').trim() === String(process.pid)) rmSync(f, { force: true });
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(f, 'utf8').trim());
      if (pid && pidAlive(pid)) return null;
      rmSync(f, { force: true }); // 过期锁
    }
  }
  return null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
