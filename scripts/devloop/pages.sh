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
set -euo pipefail
: "${CF_API:=https://api.cloudflare.com/client/v4}"
: "${WRANGLER:=npx -y wrangler@4.158.0}"
: "${SUMMARY:=${GITHUB_STEP_SUMMARY:-/dev/null}}"

[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_API_TOKEN" >&2; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_ACCOUNT_ID" >&2; exit 1; }
case "$PROJECT" in '' | *[!a-z0-9-]*) echo "::error::项目名只能是小写字母、数字、连字符：$PROJECT" >&2; exit 1 ;; esac

cf() { # cf <METHOD> <路径> [JSON 正文] → 输出响应正文；HTTP 状态写到 $CF_STATUS_FILE
  local method=$1 path=$2 body=${3:-}
  curl -sS -o "$tmp/resp" -w '%{http_code}' -X "$method" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    ${body:+--data "$body"} "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID$path" > "$tmp/status"
  cat "$tmp/resp"
}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# 1. 按名字精确查询项目；不存在才创建；拿不到项目就失败并保留 Cloudflare 的错误信息
info=$(cf GET "/pages/projects/$PROJECT")
if [ "$(cat "$tmp/status")" = "404" ]; then
  info=$(cf POST "/pages/projects" "{\"name\":\"$PROJECT\",\"production_branch\":\"main\"}")
fi
if [ "$(jq -r '.success' <<< "$info")" != "true" ] || [ "$(jq -r '.result.name' <<< "$info")" != "$PROJECT" ]; then
  echo "::error::无法取得 Pages 项目 $PROJECT：$(jq -c '.errors // .' <<< "$info" 2>/dev/null || echo "$info")" >&2
  exit 1
fi
subdomain=$(jq -r '.result.subdomain' <<< "$info")
{
  echo "### Cloudflare Pages 项目：$PROJECT"
  echo "- 正式地址：https://$subdomain"
  echo "- 预览地址：https://*.$subdomain（Access 应用需同时覆盖）"
} >> "$SUMMARY"
echo "project=$PROJECT subdomain=$subdomain"

# 2. 开关
if [ "${DEPLOY:-}" != "true" ]; then
  echo "PAGES_DEPLOY 未设为 true：只确保项目存在，没有上传。先在 Cloudflare Access 为上面的地址配好访问限制。" | tee -a "$SUMMARY"
  exit 0
fi

# 3. 过期检查：只发布 main 当前最新提交（防止慢的旧运行或历史重跑把环境回退到旧版本）
latest=$(gh api "repos/$REPO/commits/main" -q .sha)
if [ "$latest" != "$SHA" ]; then
  echo "跳过：本次运行的提交 ${SHA:0:8} 已不是 main 最新（${latest:0:8}），由更新的运行发布。" | tee -a "$SUMMARY"
  exit 0
fi

[ -f "$DIST/index.html" ] || { echo "::error::构建产物 $DIST 不完整（缺 index.html）" >&2; exit 1; }

# 4. Access 兜底：未登录访问正式地址与任一预览地址都必须被 Cloudflare Access 拦下，否则拒绝上传（防止配置失误导致公开）
: "${ACCESS_CHECK_SCHEME:=https}"
protected() { # protected <主机名>：未登录请求得到 401/403，或重定向到 cloudflareaccess.com 登录页
  local r code loc
  # ACCESS_CHECK_CONNECT 仅供测试：把任意主机名的连接转到本地假服务
  r=$(curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' \
    ${ACCESS_CHECK_CONNECT:+--connect-to "::$ACCESS_CHECK_CONNECT"} "$ACCESS_CHECK_SCHEME://$1/") || return 1
  code=${r%% *}
  loc=${r#* }
  case "$code" in 401 | 403) return 0 ;; 301 | 302 | 303 | 307 | 308) [[ "$loc" == *cloudflareaccess.com* ]] ;; *) return 1 ;; esac
}
for host in "$subdomain" "devloop-access-check.$subdomain"; do
  protected "$host" || {
    echo "::error::$host 未被 Cloudflare Access 保护（未登录请求没有被拦截），拒绝上传。按 docs/DEVLOOP.md 第八节配置后重试。" >&2
    exit 1
  }
done
$WRANGLER pages deploy "$DIST" --project-name "$PROJECT" --branch main --commit-hash "$SHA" --commit-dirty=true
echo "已发布 ${SHA:0:8} → https://$subdomain" | tee -a "$SUMMARY"
echo "deployed=$SHA"
