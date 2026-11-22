# 本机 GPT 主设 runner（`codex-local.yml`）

GPT 主设（设计 / 造型类 PR）在 morita 的 Mac 上跑：GitHub Actions 自托管 runner + Codex CLI + 本机 LearnAI 网关（`gpt-6.2-astra`）。

为什么：LearnAI 网关只在 Mac 本机（`127.0.0.1:46215`），云端 runner 连不上（ECONNREFUSED）；官方组织 key 又被 Codex 拒绝（`codex_byok_restricted_by_api_credit_promo`，2026-11-22）。
云端的 `codex.yml`（PR #76 改为直接调 Responses API）、`gpt-review.yml`、视觉评分不受影响，照旧用官方 key。

## 怎么用

只能由仓库所有者手动触发（自托管 runner 不跑别人触发的任务，也没有 issue / 评论 / PR 事件触发）：

```bash
gh workflow run codex-local.yml -f pr=73      # 按最新审核 / 验收意见修复 codex/* 分支上的 PR
gh workflow run codex-local.yml -f issue=N    # 实现带 gpt-design 标签的 issue
```

三段：`work`（本机：Codex 改工作区、工作流检查 key 未泄漏后提交打包）→ `gate`（云端、无 key：`npm ci`、测试、构建）→ `publish`（云端：`publish.sh` 推 `codex/*` 分支、开 PR 或评论）。

## 本机布局（都在 `~/.camp-empire-runner/`，目录 0700）

| 路径 | 内容 |
|---|---|
| `secrets/learnai_key` | LearnAI key（`lai_` 开头），0600。只在 Codex 那一步读入，不进仓库、仓库变量或日志 |
| `codex/bin/codex` | Codex CLI 0.107.0（官方 release 原生二进制 `codex-x86_64-apple-darwin`） |
| `codex-home/config.toml` | 本 runner 专用 `CODEX_HOME`，内容同本目录 `codex-config.toml` |
| `learnai-shim.mjs` | 兼容垫片，`127.0.0.1:46290` → `127.0.0.1:46215`，同本目录同名文件；launchd `com.camp-empire.learnai-shim` 常驻 |
| `runner/` | Actions runner（名字 `morita-mac-codex`，标签 `self-hosted, macOS, codex-local`），`./svc.sh` 装成登录服务 |

前提：LearnAI 预览在 Mac 上开着（`127.0.0.1:46215`），Mac 已登录、未睡眠。

## 为什么要垫片、为什么固定 Codex 0.107.0

网关只接受 Responses API 的常规子集。2026-11-22 逐项实测，Codex 发的这些字段会被拒：
`prompt_cache_key`、`client_metadata`、`reasoning: null` 或 `reasoning.context`、`include: ["reasoning.encrypted_content"]`、
回放 assistant 消息上的 `phase`（INVALID_REQUEST）；`custom` / `web_search` 等非 function 工具（UNSUPPORTED_REQUEST）。垫片只删这些字段。

新版 Codex（0.171）把工具放进 `input` 的 `additional_tools` 项、主工具是 `custom` 类型的 `exec`（code mode），网关无法支持，所以固定 0.107.0（顶层 function 工具 `exec_command` 等）。

## 维护

```bash
launchctl kickstart -k gui/$(id -u)/com.camp-empire.learnai-shim   # 重启垫片
tail ~/.camp-empire-runner/shim.log                                 # 只记字段名与上游错误码，不记 key
cd ~/.camp-empire-runner/runner && ./svc.sh status                  # runner 状态
```

换 key：覆盖 `secrets/learnai_key`（`chmod 600`）。下线：`./svc.sh uninstall && ./config.sh remove --token <移除令牌>`，`launchctl unload ~/Library/LaunchAgents/com.camp-empire.learnai-shim.plist`。
