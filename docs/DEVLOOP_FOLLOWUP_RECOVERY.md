# 遗留意见收尾第 2 部分（未启用，等待裁决）

状态：**未启用**。本文只记录后续方案，不授权实现、合并、发布或关闭 PR #47。

来源是 PR #47（head `0d0e1eb2354d9063ceeb30d7267f3e055f609e69`）里还没有落地的自动恢复、创建 issue 和 Claude workflow dispatch。第 1 部分已经把可单测的持久化、幂等和恢复状态放进 `scripts/devloop/followups.mjs`，并用内存假 io 覆盖了中断、查询失败、重复触发、活动任务与冷却、派发成功但实现未产出时不标完成。这些函数没有生产调用方。

本文件不包含凭据、费用数字或权限配置。是否增加 token、是否改 `.github/workflows/`、是否给予 `issues` / `actions` 写权限，都要另作裁决。在那之前，不要把第 2 部分接到 `cloud.mjs` 的 `decide` / `finalize`，不要增加 `cloud.mjs recover` 命令，不要增加定时或 `always()` 的 recover 任务。

## 裁决前保持关闭的内容

1. **自动 recover 调度。** #47 在 `gpt-review.yml` 增加了排在 `decide` 之后的 `recover` 任务。第 1 部分没有这任务。只删任务、却把 `recoverFollowUps` 接到 `decide` 或 CLI，仍然会在每次判定时开 issue 并派发，所以第 2 部分默认连调用点一起保持不存在。
2. **云端创建 issue 与派发的替换。** main 上 `finalize` 在 auto 模式合并后已经会调用 `ensureFollowUps`，再执行既有的 `gh workflow run claude.yml -f issue=<编号>`。第 1 部分没有改这条旧路径，也没有把 `completeFollowUps` 换上去。第 2 部分若要改，必须是替换这条旧路径，不能两条并存，否则同一次合并会派发两次。
3. **`cloudFollowIo`。** 这是 #47 里真正执行创建、写触发标记、`workflow run` 和摘标签的适配器。第 1 部分故意不收录它。查询失败不派发、活动运行不重复派发，要由这个适配器调用已有的 `branchExists` 和 `hasActiveRun`，并且让异常从 `issueInfo` 抛出。现在没有这个适配器，生产路径就不会走到新的派发。
4. **`ctx.sh` 的 `mode=skip` 与 `claude.yml` 的步骤条件。** 分支已存在或查询不是 404 时跳过实现，依赖工作流在 `mode=skip` 时跳过后续步骤和 `publish`。只改 `ctx.sh` 并正常退出，现有工作流仍会继续实现；改成非零退出，又会落到 #47 第 4 轮指出的 needs-user 副作用。因此第 1 部分两边都不改。第 2 部分必须在当前 main 的 `claude.yml` 上加条件，并保留 PR #49 的 `allowed_bots`（只在 `workflow_dispatch` 放行 `github-actions`）。不能整文件采用 #47 的 `claude.yml`，那份差异相对当前 main 会删掉这行。
5. **运行名 `claude issue#N`。** `hasActiveRun` 按这个名字识别未完成运行。工作流还没写这个 `run-name` 之前，即使将来接上适配器，活动任务识别也是空的。第 2 部分要同时改运行名和查询，不能只接一边。

## 启用时必须同时满足的行为

下面每条都已有内存测试，接上之前要用同一断言对注入的真实 io 再核对一遍。测试仍然不得调用真实的创建、派发、合并、部署或 Pages。

- 合并前的登记写不进去，就不合并。
- 登记评论用分页接口读全量；不能依赖 `gh pr list` 的 `comments` 字段（只有前 100 条）。
- 分支查询只有明确 404 当作不存在。5xx、403、超时保持待恢复，不写触发标记，不派发，不写完成标记。
- 有排队或运行中的实现任务时，超过 2 小时也不补派发。2 小时是 #47 沿用的间隔（`REDISPATCH_AFTER_MS`），启用前仍视为提案值，待核实。
- 派发被接受后继续算待恢复。看到实现分支、issue 关闭或 `needs-user` 才写完成标记。实现步骤因查询失败跳过时，不能提前完成。
- `decide` 与 recover 不能并发进入同一次收尾。#47 用工作流 `needs` 串行。若不用工作流，就要有别的互斥，并且用交错测试证明同一 key 不会创建两次。第 1 部分没有这个调度，也就没有这条新的并发路径。
- 本机待办与云端收尾是两条记录。第 1 部分只改了本机文件。启用云端时不要把本机 `prStatus` 闸门拿掉。

## 依赖

- 依赖第 1 部分的 `writeJsonAtomic`、`drainPending` 的 `prStatus`、`dispatchState`、`completeFollowUps`、`branchExists`、`hasActiveRun`、`listRecoverable`、`recoverFollowUps`。
- 依赖用户明确同意修改 `.github/workflows/gpt-review.yml` 与 `claude.yml`。第 1 部分证明过：不改工作流，第 1 部分本身可以成立。
- 与 PR #50 的关系：第 2 部分一旦修改 `cloud.mjs` 的 `runDecide` / `finalize`，会碰到 #50 的领取判定权。应先保留 #50 的“领取失败则跳过、终态保留领取”，再把遗留意见登记放在领取成功且决定合并之后。不要在领取失败时登记、打标签或派发。
- 不依赖、也不得覆盖 PR #48。那是驾驶表现，文件与本方案不相交。

## 仍然不做

不新增密钥或账号，不写费用，不在本文给出可粘贴的 `permissions:` 块。不关闭 #47，不把 #47 的分支当作已被取代。不重启已经停在 `needs-user` 的那次审核循环。
