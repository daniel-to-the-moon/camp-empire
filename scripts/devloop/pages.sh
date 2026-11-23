#!/usr/bin/env bash
# ci.yml pages 任务：发布到 Cloudflare Pages。由 pages.test.mjs 用假 curl / gh / wrangler 测试。
# 本脚本取自 main（可信），只上传 test 任务构建好的 dist，不执行仓库里的其他代码。
#
# 输入（环境变量）：
#   CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID  凭据
#   PROJECT    Pages 项目名
#   SHA        本次运行对应的 main 提交
#   DEPLOY     为 "true" 时才上传
#   DIST       构建产物目录
#   REPO、GH_TOKEN  用于核对 SHA 是否仍是 main 最新提交
#   WRANGLER   wrangler 调用前缀（默认 "npx -y wrangler@<固定版本>"）
#   CF_API     Cloudflare API 基地址（默认官方；测试时指向假服务）
#   SUMMARY    摘要输出文件（默认 $GITHUB_STEP_SUMMARY）
#   PUBLIC     为 "true" 时正式地址应可公开访问；预览地址始终要求 Access 保护
#   ANALYTICS  为 "on" 时启用 T1 匿名统计：确保 D1 数据库与表存在、清理超过保留期的记录，连同 functions/ 一起发布
#   FUNCTIONS_DIR  Pages Functions 目录（取自 main 的 functions/，内含 api/ev.js；schema.sql 在其中）
#   RETENTION_DAYS 统计记录保留天数（默认 180，提案值；不得超过隐私说明承诺的 180）
#   PREVIEW_BRANCH 设置时为“PR 预览”发布（accept.yml 发布把关角色）：只发到该分支的预览地址 https://<分支>.<子域>，
#                  不做 main 最新检查、不带 functions / 统计；无论 PUBLIC 如何都要求预览地址受 Access 保护。只允许 pr-<数字>。
set -euo pipefail
: "${CF_API:=https://api.cloudflare.com/client/v4}"
: "${WRANGLER:=npx -y wrangler@4.158.0}"
: "${SUMMARY:=${GITHUB_STEP_SUMMARY:-/dev/null}}"
: "${RETENTION_DAYS:=180}"
: "${DEPLOY:=}" "${PUBLIC:=}" "${ANALYTICS:=}"

fail() {
  printf '%s\n' "::error::$1" >&2
  printf '\n- 失败：%s\n' "$1" >> "$SUMMARY"
  exit 1
}

case "$DEPLOY" in '' | true | false) ;; *) fail 'PAGES_DEPLOY 只能是 true、false 或未设置。' ;; esac
case "$PUBLIC" in '' | true | false) ;; *) fail 'PAGES_PUBLIC 只能是 true、false 或未设置。' ;; esac
case "$ANALYTICS" in '' | on | off) ;; *) fail 'ANALYTICS 只能是 on、off 或未设置。' ;; esac
printf '### 发布配置\n- PAGES_DEPLOY: %s\n- PAGES_PUBLIC: %s\n- ANALYTICS: %s\n' \
  "${DEPLOY:-未设置（跳过上传）}" "${PUBLIC:-未设置（正式站需 Access）}" \
  "${ANALYTICS:-未设置（关闭）}" | tee -a "$SUMMARY"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || fail '缺少 secret CLOUDFLARE_API_TOKEN'
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || fail '缺少 secret CLOUDFLARE_ACCOUNT_ID'
case "$PROJECT" in '' | *[!a-z0-9-]*) fail '项目名只能是小写字母、数字、连字符。' ;; esac

cf() { # cf <METHOD> <路径> [JSON 正文] → 输出响应正文；HTTP 状态写到 $tmp/status
  local method=$1 path=$2 body=${3:-}
  curl -sS --max-time 30 -o "$tmp/resp" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID$path" > "$tmp/status" \
    || fail '连接 Cloudflare API 失败或超时。请检查 Actions runner 的网络后再试。'
  cat "$tmp/resp"
}

cf_fail() { # 输出 HTTP 状态和数值错误码，省略原始响应和凭据
  local status codes
  status=$(<"$tmp/status")
  codes=$(jq -r '[.errors[]? | .code | numbers] | join(", ")' <<< "$2" 2>/dev/null) || codes=''
  fail "$1（HTTP $status${codes:+，Cloudflare 错误码 $codes}）。$3"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. 按名字精确查询项目；不存在才创建
pages_operation="查询 Pages 项目 $PROJECT"
info=$(cf GET "/pages/projects/$PROJECT")
if [ "$(<"$tmp/status")" = "404" ]; then
  pages_operation="创建 Pages 项目 $PROJECT"
  info=$(cf POST "/pages/projects" "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}")
fi
subdomain=$(jq -r --arg project "$PROJECT" 'select(.success == true and .result.name == $project) | .result.subdomain // empty' <<< "$info" 2>/dev/null) \
  || subdomain=''
if [[ ! "$subdomain" =~ ^[a-z0-9][a-z0-9-]*\.pages\.dev$ ]]; then
  cf_fail "$pages_operation 失败" "$info" '若为 401 或 403，请检查令牌有效期、目标账户和 Account → Cloudflare Pages → Edit 权限。'
fi
{
  echo "### Cloudflare Pages 项目：$PROJECT"
  echo "- 正式地址：https://$subdomain"
  echo "- 预览地址：https://*.$subdomain（Access 应用需同时覆盖）"
} >> "$SUMMARY"
echo "project=$PROJECT subdomain=$subdomain"

# 2. 开关
if [ "$DEPLOY" != "true" ]; then
  echo '发布开关未开启：已确认项目存在，跳过上传。' | tee -a "$SUMMARY"
  exit 0
fi

if [ -n "${PREVIEW_BRANCH:-}" ]; then
  [[ "$PREVIEW_BRANCH" =~ ^pr-[1-9][0-9]{0,6}$ ]] || fail '预览分支名只能是 pr-<编号>。'
  latest=$SHA
else
  # 过期检查：防止慢的旧运行或历史重跑把环境回退到旧版本
  latest=$(gh api "repos/$REPO/commits/main" -q .sha) || fail '无法查询 GitHub main 的最新提交，已停止上传。'
fi
if [ "$latest" != "$SHA" ]; then
  echo "跳过：本次运行的提交 ${SHA:0:8} 已不是 main 最新（${latest:0:8}），由更新的运行发布。" | tee -a "$SUMMARY"
  exit 0
fi

if [ -z "${PREVIEW_BRANCH:-}" ] && [ "$(jq -r '.result.production_branch // empty' <<< "$info")" != 'main' ]; then
  fail 'Cloudflare Pages 的正式发布分支应为 main，已停止上传。'
fi
[ -f "$DIST/index.html" ] || fail '构建产物缺少 index.html。请检查 CI 构建和产物下载。'
# Wrangler 会把产物里的 _worker.js 当成 Worker，即使发布目录不包含 functions。
if [ -e "$DIST/_worker.js" ] || [ -L "$DIST/_worker.js" ]; then
  fail '构建产物包含 _worker.js，请检查 CI 产物；此流程只通过受控的 Functions 目录启用统计。'
fi
DIST=$(cd "$DIST" && pwd -P)

# 4. Access 兜底：预览始终要求登录；正式站在非公开模式下也要求登录。
#    只认：3xx 且 Location 为 https://<团队>.cloudflareaccess.com/cdn-cgi/access/login…（协议、主机后缀、路径逐项严格匹配）。
#    普通 401/403 一律不算：Cloudflare 的 Browser Integrity Check 等反机器人机制也会对 CI 请求返回 403，而浏览器仍能直接访问。
: "${ACCESS_CHECK_SCHEME:=https}"
ACCESS_LOGIN_RE='^https://[a-z0-9]([a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com/cdn-cgi/access/login([/?]|$)'
probe() {
  # ACCESS_CHECK_CONNECT 仅供测试：把任意主机名的连接转到本地假服务
  curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' \
    ${ACCESS_CHECK_CONNECT:+--connect-to "::$ACCESS_CHECK_CONNECT"} "$ACCESS_CHECK_SCHEME://$1/"
}
protected() { # protected <主机名>
  local r code loc
  r=$(probe "$1") || return 1
  code=${r%% *}
  loc=${r#* }
  case "$code" in 301 | 302 | 303 | 307 | 308) [[ "$loc" =~ $ACCESS_LOGIN_RE ]] ;; *) return 1 ;; esac
}

public_home() {
  local r
  r=$(probe "$1") || return 1
  [ "${r%% *}" = '200' ]
}

confirm() { # 发布后等域名响应更新，最多探测三次
  local attempt
  for attempt in 1 2 3; do
    "$@" && return 0
    [ "$attempt" = 3 ] || sleep 2
  done
  return 1
}

preview_probe="devloop-access-check.$subdomain"
if [ -n "${PREVIEW_BRANCH:-}" ]; then
  protected "$PREVIEW_BRANCH.$subdomain" || fail "预览地址 $PREVIEW_BRANCH.$subdomain 未确认受 Cloudflare Access 保护，拒绝上传。"
elif [ "$PUBLIC" != 'true' ]; then
  protected "$subdomain" || fail "正式地址 $subdomain 未确认受 Cloudflare Access 保护，拒绝上传。请核对正式站 Access 规则和 PAGES_PUBLIC。"
fi
protected "$preview_probe" || fail "预览地址 $preview_probe 未确认受 Cloudflare Access 保护，拒绝上传。"

# 5. T1 匿名统计（ANALYTICS=on）：D1 数据库按名字精确查找或创建 → 建表 → 清理过期记录 → 连同 functions/ 与 D1 绑定一起发布。
#    任何一步失败都整体失败、不上传（不会发布一个统计端点指向不存在的数据库的版本）。
site="$DIST"
workdir="$tmp/site"
mkdir -p "$workdir"
upload() {
  (cd "$workdir" && $WRANGLER pages deploy "$1" --project-name "$PROJECT" --branch "$2" --commit-hash "$SHA" --commit-dirty=true) \
    || fail 'Wrangler 上传失败。请查看发布步骤日志，核对目标项目和 Cloudflare Pages → Edit 权限。'
}
if [ -n "${PREVIEW_BRANCH:-}" ]; then
  # 在空目录里发布：wrangler 会自动带上当前目录的 functions/，预览不能带统计端点
  upload "$DIST" "$PREVIEW_BRANCH"
  echo "已上传预览 ${SHA:0:8} → https://$PREVIEW_BRANCH.$subdomain" | tee -a "$SUMMARY"
  confirm protected "$PREVIEW_BRANCH.$subdomain" || fail "发布后验收失败：预览站 $PREVIEW_BRANCH.$subdomain 未确认受 Cloudflare Access 保护。"
  echo "已发布预览 ${SHA:0:8} → https://$PREVIEW_BRANCH.$subdomain（需 Access 登录）" | tee -a "$SUMMARY"
  echo "preview=https://$PREVIEW_BRANCH.$subdomain"
  exit 0
fi
if [ "$ANALYTICS" = "on" ]; then
  [ -f "${FUNCTIONS_DIR:-}/api/ev.js" ] && [ -f "$FUNCTIONS_DIR/schema.sql" ] || fail '缺少 functions 目录（api/ev.js、schema.sql）。'
  dbname="$PROJECT-analytics"
  list=$(cf GET "/d1/database?name=$dbname&per_page=100")
  [ "$(jq -r '.success' <<< "$list" 2>/dev/null)" = "true" ] \
    || cf_fail '查询 D1 数据库失败' "$list" '请检查令牌有效期、目标账户和 Account → D1 → Edit 权限。'
  dbid=$(jq -r --arg n "$dbname" '[.result[]? | select(.name == $n)][0].uuid // empty' <<< "$list")
  if [ -z "$dbid" ]; then
    made=$(cf POST "/d1/database" "$(jq -nc --arg n "$dbname" '{name: $n}')")
    dbid=$(jq -r --arg n "$dbname" 'select(.success == true and .result.name == $n) | .result.uuid // empty' <<< "$made" 2>/dev/null || true)
    [ -n "$dbid" ] || cf_fail "创建 D1 数据库 $dbname 失败" "$made" '请检查目标账户和 Account → D1 → Edit 权限。'
    echo "已创建 D1 数据库 $dbname" | tee -a "$SUMMARY"
  fi
  case "$dbid" in *[!0-9a-f-]*) fail 'D1 返回了格式异常的数据库 ID。' ;; esac
  d1() { # d1 <JSON 正文>：执行一条语句，失败即退出
    local r
    r=$(cf POST "/d1/database/$dbid/query" "$1")
    [ "$(jq -r '.success' <<< "$r" 2>/dev/null)" = "true" ] \
      || cf_fail 'D1 执行失败' "$r" '请检查 D1 权限、统计表结构及 Cloudflare 错误码。'
  }
  # schema.sql 按分号拆成单条语句逐条执行（均为 IF NOT EXISTS，可重复执行）
  while IFS= read -r stmt; do
    d1 "$(jq -nc --argjson s "$stmt" '{sql: $s}')"
  done < <(jq -Rrs 'split(";") | map(gsub("^\\s+|\\s+$"; "")) | map(select(length > 0)) | .[] | @json' "$FUNCTIONS_DIR/schema.sql")
  # 隐私说明向玩家承诺“满 180 天自动删除”（src/shared/analytics.ts PRIVACY_TEXT）：只能改短，不能改长（GPT 审核 #66）
  case "$RETENTION_DAYS" in '' | *[!0-9]* | 0*) echo "::error::RETENTION_DAYS 必须是 1–180 的整数：$RETENTION_DAYS" >&2; exit 1 ;; esac
  [ "$RETENTION_DAYS" -le 180 ] || { echo "::error::RETENTION_DAYS 不能超过隐私说明承诺的 180 天：$RETENTION_DAYS" >&2; exit 1; }
  cutoff=$(( ($(date +%s) - RETENTION_DAYS * 86400) * 1000 ))
  d1 "$(jq -nc --argjson c "$cutoff" '{sql: "DELETE FROM events WHERE ts < ?1", params: [$c]}')"
  echo "匿名统计：D1 $dbname 就绪，已清理 $RETENTION_DAYS 天前的记录" | tee -a "$SUMMARY"
  # 组装发布目录：dist + functions + 只含 D1 绑定的 wrangler.toml
  cp -R "$DIST" "$workdir/dist"
  cp -R "$FUNCTIONS_DIR" "$workdir/functions"
  rm -f "$workdir/functions/schema.sql"
  cat > "$workdir/wrangler.toml" <<TOML
name = "$PROJECT"
pages_build_output_dir = "dist"
compatibility_date = "2026-11-01"

[[d1_databases]]
binding = "DB"
database_name = "$dbname"
database_id = "$dbid"
TOML
  site="dist"
fi
upload "$site" main
echo "已上传 ${SHA:0:8} → https://$subdomain" | tee -a "$SUMMARY"
if [ "$PUBLIC" = 'true' ]; then
  confirm public_home "$subdomain" || fail "发布后验收失败：正式站 $subdomain 未返回 HTTP 200。请核对正式站 Access 规则和站点响应。"
  production_result='正式站匿名访问返回 HTTP 200'
else
  confirm protected "$subdomain" || fail "发布后验收失败：正式站 $subdomain 未确认受 Cloudflare Access 保护。"
  production_result='正式站要求 Access 登录'
fi
confirm protected "$preview_probe" || fail "发布后验收失败：预览地址 $preview_probe 未确认受 Cloudflare Access 保护。"
echo "发布后验收通过：$production_result，预览地址要求 Access 登录。" | tee -a "$SUMMARY"
echo "deployed=$SHA"
