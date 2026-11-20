#!/usr/bin/env bash
# analytics-retention.yml：每天删除 T1 匿名统计里超过保留期的记录（docs/ANALYTICS.md）。
# 与发布解耦：站点停止发布、或统计已关闭，已存的记录仍按期删除（Codex 审核 #66）。由 pages.test.mjs 用假 Cloudflare API 测试。
#
# 输入：CLOUDFLARE_API_TOKEN、CLOUDFLARE_ACCOUNT_ID、PROJECT、RETENTION_DAYS（默认 180）、ANALYTICS、CF_API、SUMMARY
# - 数据库不存在：没有可删的，成功退出。
# - 查询失败（如令牌缺 D1 权限）：ANALYTICS=on 时失败（统计开着却删不了，须处理）；否则只提示并成功退出（统计从未开启过）。
set -euo pipefail
: "${CF_API:=https://api.cloudflare.com/client/v4}"
: "${SUMMARY:=${GITHUB_STEP_SUMMARY:-/dev/null}}"
: "${RETENTION_DAYS:=180}"
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_API_TOKEN" >&2; exit 1; }
[ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "::error::缺少 secret CLOUDFLARE_ACCOUNT_ID" >&2; exit 1; }
case "$PROJECT" in '' | *[!a-z0-9-]*) echo "::error::项目名只能是小写字母、数字、连字符：$PROJECT" >&2; exit 1 ;; esac
case "$RETENTION_DAYS" in '' | *[!0-9]*) echo "::error::RETENTION_DAYS 必须是正整数：$RETENTION_DAYS" >&2; exit 1 ;; esac
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
cf() {
  curl -sS -o "$tmp/resp" -w '%{http_code}' -X "$1" \
    -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H 'Content-Type: application/json' \
    ${3:+--data "$3"} "$CF_API/accounts/$CLOUDFLARE_ACCOUNT_ID$2" > "$tmp/status" || true
  cat "$tmp/resp" 2>/dev/null || true
}
dbname="$PROJECT-analytics"
list=$(cf GET "/d1/database?name=$dbname&per_page=100")
if [ "$(jq -r '.success' <<< "$list" 2>/dev/null)" != "true" ]; then
  msg="查询 D1 数据库失败：$(jq -c '.errors // .' <<< "$list" 2>/dev/null || echo "$list")"
  if [ "${ANALYTICS:-}" = "on" ]; then echo "::error::$msg（令牌需要 Account → D1 → Edit 权限）" >&2; exit 1; fi
  echo "统计未开启且无法查询 D1，跳过：$msg" | tee -a "$SUMMARY"
  exit 0
fi
dbid=$(jq -r --arg n "$dbname" '[.result[]? | select(.name == $n)][0].uuid // empty' <<< "$list")
if [ -z "$dbid" ]; then
  echo "没有数据库 $dbname，无需清理" | tee -a "$SUMMARY"
  exit 0
fi
case "$dbid" in *[!0-9a-f-]*) echo "::error::D1 数据库 ID 格式异常：$dbid" >&2; exit 1 ;; esac
cutoff=$(( ($(date +%s) - RETENTION_DAYS * 86400) * 1000 ))
r=$(cf POST "/d1/database/$dbid/query" "$(jq -nc --argjson c "$cutoff" '{sql: "DELETE FROM events WHERE ts < ?1", params: [$c]}')")
[ "$(jq -r '.success' <<< "$r" 2>/dev/null)" = "true" ] || { echo "::error::清理失败：$(jq -c '.errors // .' <<< "$r" 2>/dev/null || echo "$r")" >&2; exit 1; }
echo "已删除 $dbname 中 $RETENTION_DAYS 天前的记录" | tee -a "$SUMMARY"
