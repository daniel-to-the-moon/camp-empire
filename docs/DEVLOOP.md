# devloop：自主开发循环（用户 2026-11-06 授权）

## 一、循环

```
Muse 验收 / 用户 / 讨论结论 ──► issue，打 devloop 标签
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
| Muse | 验收，按第四节格式提 issue | — |
| 用户 | 收费 / 广告 / 商家投放开关、对公众上线、托管位置、裁决 `needs-user` | — |

## 四、给 Muse 的 issue 格式

- 标签：`devloop`（打上即触发云端 Claude）；类型标签 `bug` / `enhancement` / `acceptance`
- 标题：一句话说清楚要什么
- 正文：
  - **现象 / 需求**：在哪个版本（main 提交号）、做了什么、看到什么、期望什么
  - **验收标准**：可勾选的条目，Claude 会照着写测试
  - **证据四维**：涉及数值或现实常识的主张，按 CHARTER 第二节写；缺的标“待核实”
- 一个 issue 一件事；大需求拆成多个。

## 五、停止条件、标签与评论标记

审核评论末尾的标记：`changes`（触发 Claude 修复，该提交不再审）、`merged`、`stopped`（加 `needs-user`）、`retry`（main 变化、合并失败、CI 出错、暂停标签等，下一轮重试同一提交；同一提交因基础设施问题——CI 未完成或 GPT 审核本身失败——累计 3 次即转为 `stopped`）。CI 任务超时（`timed_out`）按测试失败处理，交执行者修。GPT 结论按“提交 + main 基准”缓存，main 变了就重新审核。

标记带 HMAC 签名，密钥只在审核方本机（`../ce-devloop/marker.key`）；只认审核方账号发出、以“执行者：GPT”开头的评论，每条评论只认最后一个标记。其他人写的标记无效。

只处理“打开、非草稿、目标 main”的 PR；草稿 PR 要先转为 ready 才会进入审核。

合并方式：在 CI 测试过的 main 提交上生成合并提交（与 CI 相同的 `git merge --no-ff`），普通推送到 main；main 已变化时推送被拒，不会合入未测试的组合。合并后只有分支仍停在合入的提交上才删除分支（`--force-with-lease`），之后若有新提交则保留。

推送前一刻会再读一次 PR（打开、非草稿、目标 main、头部未变、无暂停标签），任一不符即中止。这一刻到推送之间仍有一个很短的窗口（中间只有本地 git 操作和一次 git 推送，**时长未测量，待核实**）；要由 GitHub 强制“状态检查通过才能进 main”，需要分支保护（私有仓库需 GitHub Pro），**待用户决定**。

同一时刻只允许一个 devloop 进程审核或合并（监听本机 127.0.0.1:47831 作为锁，进程退出由系统释放）；工作区目录每次唯一。git 操作在 `gitops.test.mjs` 里用本地临时仓库做了集成测试。

| 标签 | 含义 |
|---|---|
| `needs-user` | 自动循环停下等用户：同一 PR 连续 5 轮未通过；或 Claude 判断命中下列条件 |
| `hold` | 用户手动暂停某个 PR 的自动审核与合并 |

Claude 遇到以下情况不写代码，在 issue 里说明并加 `needs-user`：
1. 涉及收费、广告、商家投放开关，或对公众开放（含实名、防沉迷等，CHARTER 第五节）；
2. 需要外部付费服务、新账号或新的第三方数据源；
3. issue 之间互相矛盾，或与 CHARTER 硬边界冲突；
4. 信息不足以动手。

## 六、残余风险（如实列出）

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

- 现在：main 每次更新，CI 测试并构建，`dist` 上传为 GitHub Actions 发布产物 `camp-empire-<提交号>`（私有，保留 90 天）。**不部署到任何对外地址。**
- 不用 Vercel：当前账号是 Hobby 套餐，条款只允许非商业用途；vercel.app 在中国大陆访问也不稳定。
- 正式托管位置**待用户拍板**（会影响费用、备案与合规）。面向中国大陆公众上线需 ICP 备案；网络游戏商业运营涉及版号、实名与防沉迷（CHARTER 第五节第 5 条），具体要求**待核实**。

## 九、费用（待核实）

- 云端 Claude 按 Anthropic API 用量计费，每次实现 / 修复上限 120 轮对话；单次花费没有实测数据，跑过几次后按账单补到 #2 预算讨论里。
- GitHub Actions：私有仓库免费额度每月 2000 分钟，超出另计。
- GPT 审核走用户 ChatGPT 订阅额度。
