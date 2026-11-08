#!/usr/bin/env bash
# claude.yml work 任务第一步：确定模式（implement / fix）、目标分支与编号。由 claude.test.mjs 用假 gh 测试。
# 输入（环境变量）：EVENT（issues / issue_comment / workflow_dispatch）、N（issue 或 PR 编号）、REPO、KIND（手动触发时：issue = 实现 issue，其余 = 修复 PR）
# 输出：向 $GITHUB_OUTPUT 写 mode=、branch=、number=；不合规时以非零退出
set -euo pipefail
case "${N:-}" in '' | *[!0-9]*) echo "::error::编号必须是数字：${N:-}" >&2; exit 1 ;; esac
if [ "$EVENT" = "issues" ]; then
  mode=implement
  branch="claude/issue-$N"
elif [ "$EVENT" = "workflow_dispatch" ] && [ "${KIND:-}" = "issue" ]; then
  # 按 issue 手动触发实现（云端审核用 GITHUB_TOKEN 开的遗留意见 issue 打标签不会触发 labeled 事件）：
  # 只接受打开、带 devloop 标签、不带 needs-user 的 issue（不是 PR）
  ok=$(gh issue view "$N" -R "$REPO" --json state,labels,url -q 'select(.state == "OPEN" and (.url | test("/issues/[0-9]+$")) and ([.labels[].name] | index("devloop")) and (([.labels[].name] | index("needs-user")) | not)) | "ok"')
  [ "$ok" = "ok" ] || { echo "::error::issue #$N 不是打开、带 devloop、不带 needs-user 的 issue" >&2; exit 1; }
  # 去重：同一 issue 的任务按 concurrency 串行，排到这里时若实现分支已存在，说明前一次触发已产出，本次是重复触发
  if gh api "repos/$REPO/git/ref/heads/claude/issue-$N" >/dev/null 2>&1; then
    echo "::error::issue #$N 已有实现分支 claude/issue-$N（重复触发），不再重复实现" >&2
    exit 1
  fi
  mode=implement
  branch="claude/issue-$N"
else
  # issue_comment 与 workflow_dispatch 都是修复已有 PR：只接受本仓库、claude/* 分支上的 PR
  b=$(gh pr view "$N" -R "$REPO" --json headRefName,isCrossRepository -q 'select(.isCrossRepository|not) | .headRefName')
  case "$b" in claude/*) ;; *) echo "::error::只修复本仓库 claude/* 分支上的 PR（实际：${b:-跨仓库或不存在}）" >&2; exit 1 ;; esac
  mode=fix
  branch="$b"
fi
{
  echo "mode=$mode"
  echo "branch=$branch"
  echo "number=$N"
} >> "$GITHUB_OUTPUT"
