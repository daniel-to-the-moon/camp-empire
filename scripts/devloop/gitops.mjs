/**
 * devloop 的 git 操作与 CI 运行匹配（不调用 gh / GitHub API，可在本地临时仓库上做集成测试，见 gitops.test.mjs）。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
 * 进程锁：同一时刻只允许一个 devloop 进程审核或合并。返回释放函数；拿不到锁返回 null。
 * 原子性：先把 pid 写进私有临时文件，再 link 成锁文件——link 要么整个成功、要么 EEXIST，
 * 别的进程永远读不到“已创建但还没写 pid”的锁（GPT 审核 #6 第五轮 major）。
 * 过期锁（持有进程已退出）接管：先把锁文件 rename 到私有名字（同一时刻只有一个进程能 rename 成功），
 * 再确认挪走的确实是刚才看到的那把过期锁；不是的话原样放回、放弃本次。
 */
export function acquireLock(home) {
  mkdirSync(home, { recursive: true });
  const f = join(home, 'devloop.lock');
  const mine = `${f}.${process.pid}.${randomBytes(4).toString('hex')}`;
  writeFileSync(mine, String(process.pid));
  try {
    for (let i = 0; i < 3; i++) {
      try {
        linkSync(mine, f);
        return () => {
          try {
            if (readFileSync(f, 'utf8').trim() === String(process.pid)) unlinkSync(f);
          } catch {
            /* 已不存在 */
          }
        };
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      let seen;
      try {
        seen = readFileSync(f, 'utf8').trim();
      } catch {
        continue; // 刚被释放，重试
      }
      if (pidAlive(Number(seen))) return null;
      const moved = `${mine}.stale`;
      try {
        renameSync(f, moved);
      } catch {
        continue; // 别的进程先挪走了，重试
      }
      if (readFileSync(moved, 'utf8').trim() !== seen) {
        // 挪走的不是那把过期锁（别人刚接管了）：放回去，放弃
        try {
          linkSync(moved, f);
        } catch {
          /* 位置又被占了：对方持锁，照样放弃 */
        }
        unlinkSync(moved);
        return null;
      }
      unlinkSync(moved);
    }
    return null;
  } finally {
    rmSync(mine, { force: true });
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}
