# devloop：自主开发循环（用户 2026-11-06 授权）

## 一、循环

```
Muse 验收 / 讨论 ──► acceptance / proposal issue ──► 用户确认后打 devloop 标签
                                   │
  【GitHub 云端】Claude（claude-code-action，Anthropic API key）
     读 issue → 分支 claude/issue-N → 写代码 + 测试 → 本地跑通 test/build → 开 PR（Closes #N）
                                   │
  【用户 Mac】审核方（devloop.mjs watch 每 5 分钟扫一次；本机不执行 PR 代码）
     ├─ 触发 GitHub Actions：把 PR 合并到当前 main 后跑 test / build（一次性 runner）
     └─ GPT（Codex CLI，ChatGPT 订阅）只读审核代码
     → 结论评论到 PR，末尾带机器标记 <!-- devloop state=… -->
                                   │
         ┌── 需修改 / 测试失败 / 冲突 → 评论触发云端 Claude 在同一分支修复 → 新提交 → 再审（最多 5 轮）
         │
         └── 通过 → 在测试过的 main 上生成合并提交并推送（main 变了推送失败）→ CI 构建 main 并上传发布产物
                                   │
                         Muse 验收 → 新 issue（回到开头）
```

为什么分两处：仓库只有 Anthropic API key，没有 OpenAI API key；GPT 审核只能用用户 ChatGPT 订阅下的 Codex CLI，在用户 Mac 上跑（用户 2026-11-06 选定）。
代价：**Mac 关机或睡眠时不审核、不合并**；云端 Claude 照常开 PR，等 Mac 醒来后排队审核。

## 二、组件

| 组件 | 位置 | 作用 |
|---|---|---|
| `.github/workflows/claude.yml` | GitHub Actions | issue 打上 `devloop` 标签时实现；GPT 审核评论带 `state=changes` 时在同一 PR 修复。分两个任务：`work`（只读令牌，Claude 改代码跑测试，打包提交）→ `publish`（有写权限但不执行仓库代码，只把提交推到 `claude/*` 分支并开 PR 或评论） |
| `scripts/devloop/devloop.mjs` | 用户 Mac | `watch`：常驻审核；`review <PR>`：手动审核一次 |
| `scripts/devloop/policy.mjs`（+ `policy.test.mjs`） | — | 合并决策与评论标记（CI 里用 `node --test` 自测） |
| `scripts/devloop/prstate.mjs`（+ `prstate.test.mjs`） | — | 读取 PR 状态与审核方标记；审核方账号每次重新查询（假 gh 模拟账号改名做回归测试） |
| `scripts/devloop/gitops.mjs`（+ `gitops.test.mjs`） | — | 合并推送、删分支、CI 运行匹配、进程锁（本地临时仓库集成测试） |
| `scripts/devloop/ci.mjs`（+ `ci.test.mjs`） | — | 触发与等待 CI；任何查询异常都转为“基础设施问题”，不向外抛 |
| `scripts/devloop/review-prompt.md`、`review-schema.json` | — | GPT 审核必查项与结构化结论格式 |
| `.github/workflows/ci.yml` | GitHub Actions | devloop 触发：PR 合并到指定 main 后测试；人工 PR；main 构建并上传发布产物 |

```bash
node scripts/devloop/devloop.mjs watch 300              # 常驻审核（launchd 托管，见第六节）
node scripts/devloop/devloop.mjs review <PR号>           # 手动审核一次；通过则合并
node scripts/devloop/devloop.mjs review <PR号> --no-merge
```

## 三、角色

| 角色 | 做什么 | 不做什么 |
|---|---|---|
| Claude（云端，`claude-opus-5-5`） | 认领 `devloop` issue、写代码与测试、开 PR、按审核意见修复 | 不审核、不合并自己的 PR |
| GPT（Codex CLI，`gpt-6-astra`） | 每个新提交独立审核：只读检出、自己读代码、按必查项给 approve / request_changes | 不改代码 |
| 流水线 | CI 测试合并后的代码；GPT 通过且测试通过、main 未变、无暂停标签才合并；合入的就是测试过的那个组合 | 不在本机执行 PR 代码 |
| Muse | 验收，按第四节格式提 issue | 不打 `devloop` 标签 |
| 用户 | 给 issue 打 `devloop`（拍板实现）；收费 / 广告 / 商家投放开关、对公众上线、托管位置、裁决 `needs-user` | — |

## 四、给 Muse 的 issue 格式

- 标签：评审方只打类型标签 `bug` / `enhancement` / `acceptance` / `proposal`；**不打 `devloop`**（打上即触发云端 Claude），由用户确认后添加（见下一节“拍板”）
- 标题：一句话说清楚要什么
- 正文：
  - **现象 / 需求**：在哪个版本（main 提交号）、做了什么、看到什么、期望什么
  - **验收标准**：可勾选的条目，Claude 会照着写测试
  - **证据四维**：涉及数值或现实常识的主张，按 CHARTER 第二节写；缺的标“待核实”
- 一个 issue 一件事；大需求拆成多个。

## 讨论、提案与沉淀

| 阶段 | 放在哪里 | 标签 | 谁来做 |
|---|---|---|---|
| 验收材料 | issue（体验包：截图、操作路径、当时数值、现状缺口、评审请求） | `acceptance` | Claude 本地会话制作；截图放在仓库的 `acceptance/*` 分支，按提交号引用 |
| 可玩性 / 设计建议 | 一条建议一个 issue（主张、四维论证、验收标准、优先级、成本、风险），评论区即讨论记录 | `proposal` | Muse 等评审方提出，多 agent 在评论区讨论 |
| 拍板 | 在 `proposal`（或 `bug` / `enhancement`）issue 上加 `devloop` 标签即“同意实现”；不同意则关闭并写原因 | `devloop` | **只有用户** |
| 实现 | 云端 Claude 自动开 PR（`Closes #N`），审核、合并、发布 | — | devloop |
| 沉淀结论 | 拍板后的规则与数值写回仓库文档（GDD、`docs/ECONOMY_M1.md` 等），在文档里注明出处 issue 编号 | — | 实现该 issue 的 PR 一并修改 |

评审方不要自己打 `devloop`：这个标签一打上就会触发自动开发。

**GPT 云端参与讨论**（`.github/workflows/gpt-discuss.yml`，需仓库 secret `OPENAI_API_KEY`；仓库变量 `GPT_RESPONSES_ENDPOINT` 指定兼容 Responses API 的网关地址、`GPT_MODEL` 指定模型，均可留空走官方默认。当前 key 来自用户的 AI 网关。限速：个人并发 1、每分钟 6 次请求——来源为用户网关账号说明（本机文件，2026-11-07 读取），以网关当前设置为准，**待核实**；可能使评审排队变慢）：
- 讨论 issue 被打上 `discussion` / `proposal` 标签时（带标签新建也算，同一 issue 只首次评审一次），GPT 读讨论全文与仓库规则，按 CHARTER 第二节四维逐条核对并发评论（开头“执行者：GPT（云端评审…）”）。
- 之后在评论里写 `@gpt` 可再次点名；其他评论不触发，控制费用。也可手动触发：`gh workflow run gpt-discuss.yml -R daniel-to-the-moon/camp-empire -f issue=<编号>`。
- 触发判定在 `scripts/devloop/discuss-gate.mjs`、去重与提示词在 `discuss-build.mjs`（均有测试）；`@gpt` 点名时只回答触发的那条评论，这条评论完整保留、优先占用提示词预算，讨论全文用剩余预算截断（至少保留 40,000 字，提案值，待核实）；评审任务只读、`:read-only` 权限配置，发评论任务不运行模型。
- GPT 只评审与提问，不拍板。目前这只是约定：`claude.yml` 只检查标签本身，不检查是谁打的；有写权限的账号打上 `devloop` 都会触发。若要强制只认用户，需要在工作流里校验打标签者，**待用户决定**。

## 云端审核（取代本机常驻，用户 2026-11-08 决定）

`.github/workflows/gpt-review.yml` + `scripts/devloop/cloud.mjs`，与本机 `devloop.mjs` 共用判定、合并、CI、签名标记模块。

- **开关**：仓库变量 `CLOUD_REVIEW=on` 才自动运行（每 10 分钟扫描；GitHub 定时任务可能延后）；手动 `gh workflow run gpt-review.yml -R daniel-to-the-moon/camp-empire -f pr=<编号>` 不受开关限制，用于验证。
- **分工**：云端只审**不改** `.github/workflows/` 的 PR；改工作流的 PR 由本机审核方处理（`GITHUB_TOKEN` 无 workflows 权限，合并不了）。开关打开后，本机常驻自动只兜底这类 PR。
- **结构**：`select`（只读，选 PR）→ `review`（只读，codex-action 以 `:read-only` 在 PR 检出上审核，输出结构化结论）→ `decide`（有写权限、不运行模型：触发 CI、判定、合并或退回、评论）。整个工作流全局串行。
- **后续动作**：`GITHUB_TOKEN` 发的评论不会触发 `claude.yml`，所以需修改时 `decide` 直接触发 `claude.yml -f pr=<编号>`；`GITHUB_TOKEN` 推送 main 不会触发 push 工作流，所以合并后直接触发 `ci.yml -f deploy_main=true` 完成发布。
- **凭据**：`OPENAI_API_KEY`、`GPT_RESPONSES_ENDPOINT`、`GPT_MODEL`（与讨论评审共用）；签名密钥 `DEVLOOP_MARKER_KEY` 与本机 `../ce-devloop/marker.key` 相同，两边的审核记录互认、轮次连续计数。
- **信任边界**：不设 `pull_request` 入口——那会用 PR 分支上的工作流定义运行，PR 能改 YAML 在过滤前读到签名密钥、或改写有写权限的 `decide`。定时任务只用 main 上的定义；手动触发时各任务校验 `github.ref == refs/heads/main`。
  残余风险：有仓库写权限、且能推送 `.github/workflows/` 改动的账号，可以推一个改过 YAML 的分支再对它手动触发，从而读到仓库级 secret。云端 Claude 用的 `GITHUB_TOKEN` 无 workflows 权限，推不了这类分支；真正隔离需把 `DEVLOOP_MARKER_KEY` 移进只允许 main 部署的 environment（私有仓库可能需要付费套餐），**待用户决定**。
- **去重**：判定前与推送前都检查当前提交是否已有终态标记（`hasTerminal`）；decide 重放、或本机与云端重叠审核同一提交时，后到的一方跳过，不重复评论、不触发修复、不合并。
- **结论校验**：GPT 结论按 `review-schema.json` 校验（`validateReview`，云端与本机共用）；不合法（如 `findings` 不是数组、`verdict` 非法）按 GPT 审核失败处理，计入同一提交 3 次的停止上限。
- **费用**：每次审核消耗 AI 网关的共享额度（金额待核实）；网关限速见上文“GPT 云端参与讨论”。

## 五、停止条件、标签与评论标记

审核评论末尾的标记：`changes`（触发 Claude 修复，该提交不再审）、`merged`、`stopped`（加 `needs-user`）、`retry`（main 变化、合并失败、CI 出错、暂停标签等，下一轮重试同一提交；同一提交因基础设施问题——CI 未完成或 GPT 审核本身失败——累计 3 次即转为 `stopped`）。CI 任务超时（`timed_out`）按测试失败处理，交执行者修。GPT 结论按“提交 + main 基准”缓存，main 变了就重新审核。

标记带 HMAC 签名，密钥只在审核方本机；审核方账号每次都重新查询（账号改名后历史评论作者也会显示新名，缓存旧名会导致认不出自己的标记、重复评论）（`../ce-devloop/marker.key`）；只认审核方账号发出、以“执行者：GPT”开头的评论，每条评论只认最后一个标记。其他人写的标记无效。

只处理“打开、非草稿、目标 main”的 PR；草稿 PR 要先转为 ready 才会进入审核。

合并方式：在 CI 测试过的 main 提交上生成合并提交（与 CI 相同的 `git merge --no-ff`），普通推送到 main；main 已变化时推送被拒，不会合入未测试的组合。合并后只有分支仍停在合入的提交上才删除分支（`--force-with-lease`），之后若有新提交则保留。

推送前一刻会再读一次 PR（打开、非草稿、目标 main、头部未变、无暂停标签），任一不符即中止。这一刻到推送之间仍有一个很短的窗口（中间只有本地 git 操作和一次 git 推送，**时长未测量，待核实**）；要由 GitHub 强制“状态检查通过才能进 main”，需要分支保护（私有仓库需 GitHub Pro），**待用户决定**。

同一时刻只允许一个 devloop 进程审核或合并（监听本机 127.0.0.1:47831 作为锁，进程退出由系统释放）；工作区目录每次唯一。git 操作在 `gitops.test.mjs` 里用本地临时仓库做了集成测试。

| 标签 | 含义 |
|---|---|
| `needs-user` | 自动循环停下等用户：同一 PR 连续 5 轮未通过（`ROUND_LIMIT_MODE=needs-user`，默认）；auto 模式下出现 blocker 或意见数回升；或 Claude 判断命中下列条件 |
| `hold` | 用户手动暂停某个 PR 的自动审核与合并 |

Claude 遇到以下情况不写代码，在 issue 里说明并加 `needs-user`：
1. 涉及收费、广告、商家投放开关，或对公众开放（含实名、防沉迷等，CHARTER 第五节）；
2. 需要外部付费服务、新账号或新的第三方数据源；
3. issue 之间互相矛盾，或与 CHARTER 硬边界冲突；
4. 信息不足以动手。

### 轮次用满后的处理（用户自选，仓库变量 `ROUND_LIMIT_MODE`）

| 值 | 第 5 轮仍未通过时 |
|---|---|
| `needs-user`（默认，未设置也是它） | 停下、加 `needs-user`，等用户裁决（再给一轮 / 先合并 / 先放着）。 |
| `auto`（免人工合码） | ① 有 blocker 或意见数比上一轮多 → 仍停下加 `needs-user`；② 意见数比上一轮少 → 自动追加一轮，最多追加 3 轮（到第 8 轮）；CI 失败或冲突也在追加轮次内交 Claude 修；③ 意见数持平或追加轮次用完，且剩余只有 major / minor、CI 通过、无冲突 → 合并，剩余意见逐条开 `devloop` issue 交给循环。 |

- 切换：`gh variable set ROUND_LIMIT_MODE --body auto`（改回：`--body needs-user`）。本机审核方每次判定时读取，云端审核由 `gpt-review.yml` 读取。
- 判断“意见数”用每条 `changes` 标记里记下的 `f<n>`（签名的一部分）；旧标记没有记录时按持平处理。
- 云端开的遗留意见 issue 由 `GITHUB_TOKEN` 打标签，不会触发 `claude.yml`，所以云端直接 `gh workflow run claude.yml -f issue=<编号>`；本机以用户账号开 issue，标签会正常触发。
- 遗留意见收尾可恢复：本机在合并前把待办原子落盘（`../ce-devloop/followups/pr-N.json`），每轮 watch 核对 PR 确已以该提交合并后补开；云端在合并前于 PR 上发“遗留意见记录”评论（发不出就不合并），收尾完成发“已完成”评论，`gpt-review.yml` 的 `recover` 任务（排在 decide 之后）按 PR 标签 `devloop-followups`（登记时打上、完成后移除）找到未完成的收尾补齐，不受“最近 N 个 PR”窗口限制。分支是否存在只把明确的 404 当作不存在，查询出错就保持待恢复、不触发。开 issue 按稳定标识去重；触发实现前先在 issue 上记触发标记，2 小时内不重复触发、已有 `claude/issue-N` 分支不触发。
- 风险（如实）：auto 模式会合并 GPT 仍认为有 major 问题的代码，靠后续 issue 修；涉及收费 / 广告 / 对公众上线等用户保留决定的改动，Claude 本就不写，不受此开关影响。

## 模型网关与手动重跑

- 云端 Claude 通过仓库变量 `ANTHROPIC_BASE_URL` 指定的网关调用模型（用户的 key 来自第三方网关 `api.toolpai.com`，不是 Anthropic 官方 API；2026-11-07 用户本机实测该网关可用）。变量为空时走官方地址。代码会经过该网关，与用户桌面端 Claude 的现有路径相同。
- 云端修复失败、PR 被加上 `needs-user` 后的恢复步骤：
  1. 先看 PR 下的失败说明和 Actions 日志，确认停下的原因（key、网关、额度等）已经排除；
  2. 手动重跑该 PR 的修复：

```bash
gh workflow run claude.yml -R daniel-to-the-moon/camp-empire -f pr=<PR号>
```

  3. 重跑成功推送修复后，发布步骤会自动移除 `needs-user`，本机审核方随即审核新提交；`hold` 是用户的暂停意图，不会被移除。重跑仍失败则保持 `needs-user`。
- 工作流里的判断与发布逻辑在 `scripts/devloop/ctx.sh`、`publish.sh`（`claude.test.mjs` 用假 gh 与本地 git 远端测试，并读取 `claude.yml` 里 publish 的真实 `if:` 条件验证 work 被取消 / 跳过时不发布），运行时取 main 上的版本。

## 六、残余风险（如实列出）

- **工作流文件与 GITHUB_TOKEN**：GitHub 不允许 `GITHUB_TOKEN` 推送会改动 `.github/workflows/` 的提交。
  - 新分支（implement）：`publish.sh` 先把新提交挪到当前 main 上再推，避免“从旧起点开分支”被视为改动工作流（#11、#12 曾因此失败）。
  - 修复（fix）：若 PR 与 main 冲突、Claude 需要把 main 合进 PR 分支，而 main 期间改过工作流文件，推送仍会被拒，流程加 `needs-user` 停下。彻底解决需要给 `publish` 一个有 `workflows` 权限的令牌（例如仅限本仓库的 fine-grained PAT），**待用户决定**。

- 云端 Claude 开启了完整输出（`show_full_output`），失败时可在 Actions 日志看到实际报错。日志含全部工具执行结果；以 secrets 登记的密钥会被自动打码，仓库私有。**仓库若改为公开，须先关闭此项。**

- 云端 Claude 步骤失败、超时，或整个任务失败：`publish` 仍会运行，在 issue / PR 下发失败说明并加 `needs-user`，循环停下等用户，不会无声卡住。

- `work` 任务里有 Anthropic API key（Claude 运行必需），并会执行仓库代码与依赖安装脚本。依赖被投毒时这个 key 可能泄露，但拿不到能写仓库的令牌。缓解：在 Anthropic 控制台给这个 key 设用量上限。
- 推送 main 前的最后核对与推送之间有一个很短的窗口（**时长未测量，待核实**）；彻底由 GitHub 强制需要分支保护（GitHub Pro），待用户决定。

## 七、本机审核方的安装

launchd 常驻（`~/Library/LaunchAgents/com.camp-empire.devloop.plist`），日志在 `../ce-devloop/watch.log`。
审核方从独立克隆 `../ce-devloop/repo` 运行，不影响日常工作的检出。

```bash
launchctl print gui/$(id -u)/com.camp-empire.devloop | head    # 看状态
launchctl bootout gui/$(id -u)/com.camp-empire.devloop          # 停掉
tail -f ../ce-devloop/watch.log                                 # 看日志
```

## 八、发布与托管

- **内部验收环境：Cloudflare Pages + Cloudflare Access**（用户 2026-11-07 选定）。main 每次更新：`ci.yml` 的 `test` 任务构建 `dist` 并上传为 Actions 产物；`pages` 任务下载产物，用固定版本的 wrangler 上传（逻辑在 `scripts/devloop/pages.sh`，`pages.test.mjs` 覆盖）。`pages` 任务只稀疏检出 main 的 `scripts/devloop`，不执行应用代码，Cloudflare 凭据只在该任务中。项目按名字经 Cloudflare API 精确查询或创建；发布串行且保留全部排队（`queue: max`），上传前核对提交仍是 main 最新、过期运行跳过，并确认正式与预览地址都重定向到 Access 登录页。
  - 凭据：secret `CLOUDFLARE_API_TOKEN`（只含 Account → Cloudflare Pages → Edit 权限）、`CLOUDFLARE_ACCOUNT_ID`。
  - 开关：仓库变量 `PAGES_DEPLOY=true` 才上传；未开启时只确保项目存在并在运行摘要里打印 `pages.dev` 地址。
  - **顺序**（按 [Cloudflare 官方步骤](https://developers.cloudflare.com/pages/platform/known-issues/#enable-access-on-your-pagesdev-domain)）：
    1. main 的 CI 先建好项目，在运行摘要里看到实际地址 `<项目>.pages.dev`。
    2. Cloudflare 后台 → Workers & Pages → 选该项目 → Settings → **Enable access policy**（先生成预览地址的策略）。
    3. 在该策略上点 **Manage** → 进入 Access → Applications 中的这个应用 → **Configure** → Public hostname 里**删掉通配符 `*`** 并保存（必要时改应用名以免重名报错）。这一步让它改为保护正式地址 `<项目>.pages.dev`。
    4. 回到项目 Settings → General，**再次 Enable access policy**，重新生成预览地址 `*.<项目>.pages.dev` 的策略。确认共有两条：正式地址一条、预览地址一条。
    5. 两条策略的规则都只允许指定邮箱（Include → Emails）。
    6. **验证**：无痕窗口分别打开正式地址和任一预览地址（如 `x.<项目>.pages.dev`），都应跳到 Cloudflare Access 登录页；用允许的邮箱能登录。
    7. 再设 `PAGES_DEPLOY=true`。另有兜底：`pages.sh` 每次上传前用未登录请求检查正式与预览地址，都必须重定向到 `https://<团队>.cloudflareaccess.com/cdn-cgi/access/login…`（协议、主机后缀、路径严格匹配），否则拒绝上传。普通 401/403 不算：Cloudflare 的 Browser Integrity Check 等反机器人机制也会对 CI 返回 403。
  - 绑定自定义域名时，需在 Zero Trust → Access → Applications 另建 Self-hosted 应用覆盖该域名；且已有 Access 策略的域名不能再添加为 Pages 自定义域名（官方已知问题）。
  - 不用 Vercel：Hobby 套餐条款限非商业用途。Cloudflare 免费套餐条款未见商用限制（禁止在免费服务上收集信用卡信息），官方条款原文**待核实**。
- **对国内公众上线（待用户决定）**：Cloudflare 在中国大陆访问偏慢，`*.pages.dev` 常不可达。届时改用国内平台（如腾讯 EdgeOne Pages、阿里云 ESA Pages）+ ICP 备案域名；网络游戏商业运营还涉及版号、实名与防沉迷，具体要求**待核实**。构建产物是纯静态文件，更换平台只需改发布任务。

## 九、费用（待核实）

- 云端 Claude 按 Anthropic API 用量计费，每次实现 / 修复上限 120 轮对话；单次花费没有实测数据，跑过几次后按账单补到 #2 预算讨论里。
- GitHub Actions：私有仓库免费额度每月 2000 分钟，超出另计。
- GPT 审核走用户 ChatGPT 订阅额度。
