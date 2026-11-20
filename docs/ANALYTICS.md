# T1 匿名统计

出处：`docs/BUSINESS_PLAN.md` T1；用户 2026-11-20 在项目会话中拍板“做”。

## 记什么、不记什么

| 记录 | 说明 |
|---|---|
| `aid` | 浏览器本地随机生成的 UUID v4（`localStorage` 键 `ce.analytics.aid`），与账号、设备无关；清掉网站数据或关闭统计即删除 |
| `ev` | 事件名，只有下表 6 种 |
| `day` | 服务器收到时的上海日序号（与游戏日界一致） |
| `ts` | 服务器收到的时间（毫秒） |
| `v` | 游戏版本（构建时的提交号前 12 位） |

**不记**：IP、User-Agent、Referer、屏幕、语言、存档内容、金币数、任何玩家输入。接收端（`functions/api/ev.js`）不读取任何请求头（除了用 `Origin` 拒绝跨站请求），测试里断言写入的行不含 IP 与 UA。Cloudflare 平台自身的访问日志不在本仓库控制范围内，以 Cloudflare 隐私政策为准（**待核实**）。

| 事件 | 触发 | 对应 KPI（BUSINESS_PLAN 4.4） |
|---|---|---|
| `session_start` | 每次打开页面 | DAU、MAU、D1/D7/D30 留存 |
| `collect` | 收取成功（存档提交成功且确有停车费入账） | 激活率 |
| `buy_awning` | 侧边帐购买成功 | 成长节奏（ECONOMY_M1 发现 1） |
| `card_export` | 卡片下载已触发，或复制到剪贴板成功（不支持 / 被拒不算） | 卡片导出率 |
| `dex_open` | 车型图鉴从关闭变为打开 | 中期目标参与度 |
| `drive_out` | 开车出门真正起步（按钮或 O 键） | 核心玩法参与度 |

所有事件都在操作确认成功后才发（`src/shared/analytics.ts` 的 `successEvent`）：只读标签页、存档提交失败、重复点击都不计数（GPT 审核 #66）。

## 什么时候不发

- 玩家在“隐私与统计”面板里关闭（同时删除本机匿名 ID；重新开启会生成新的，不与旧记录关联）。浏览器存储写不进去（如已满）时，本次打开期间仍立即停止发送，并提示只对本次有效。
- `?dev` 调试入口；本机地址（`localhost`、`127.0.0.1` 等，含开发服务器和 CI 冒烟测试）。
- 浏览器存储不可用（不使用临时 ID 充数）。
- 用 `navigator.sendBeacon` 发送，失败静默，不影响游戏。

## 保存与删除

- 存在 Cloudflare D1 数据库 `<项目名>-analytics` 的 `events` 表（`functions/schema.sql`）。
- 保留 180 天（**提案值**，仓库变量 `RETENTION_DAYS` 只能改短，1–180；超过隐私说明承诺的 180 天时清理与发布都会直接失败）：`.github/workflows/analytics-retention.yml` 每天上海时间 03:17 删除 `ts` 早于保留期的记录（`scripts/devloop/d1-retention.sh`），与发布解耦，站点停发或统计关闭后照样删除，查不了 D1（如令牌丢了权限）就让定时任务失败而不是假装成功；每次发布时 `pages.sh` 也会顺带清理一次。

## 开启方式

1. Cloudflare 令牌（secret `CLOUDFLARE_API_TOKEN`）在原有 Pages Edit 之外加 **Account → D1 → Edit** 权限。
2. 仓库变量 `ANALYTICS=on`。下一次 main 发布时 `pages.sh` 会按名字查找或创建数据库、建表、清理过期记录，并把 `functions/` 与 D1 绑定一起发布。任何一步失败都整体失败、不上传。
3. 关闭：把变量改成 `off`（**不要删除变量**：每日清理靠“变量设置过”判断统计曾经开启，查不了 D1 时要报错而不是跳过）。下一次发布不再带统计端点（客户端请求会得到 404，静默失败），已存记录照样按期删除。

## 口径（T2 看板据此实现）

- 首访日：某 `aid` 最早一条记录的 `day`。
- 激活：首访日或次日内有 `collect`（提案口径；BUSINESS_PLAN 写的是“首访后 30 分钟内”，按服务器时间 `ts` 也可算，T2 两种都给）。
- D_n 留存：首访日为 d 的 `aid` 中，在 d + n 日有任意记录的比例；D1、D7、D30 各自独立计算，**不能相乘**。
- 匿名 ID 数 ≠ 真人数（换浏览器、清数据都会变），报告里须注明。

示例（D1 控制台或 `wrangler d1 execute`）：

```sql
-- 每日活跃匿名 ID
SELECT day, COUNT(DISTINCT aid) AS dau FROM events GROUP BY day ORDER BY day;
-- D1 留存（按首访日分组）
WITH first AS (SELECT aid, MIN(day) AS d0 FROM events GROUP BY aid)
SELECT f.d0, COUNT(*) AS new_ids,
       SUM(EXISTS (SELECT 1 FROM events e WHERE e.aid = f.aid AND e.day = f.d0 + 1)) AS back_d1
FROM first f GROUP BY f.d0 ORDER BY f.d0;
```

## 测试

- `tests/analytics.test.ts`：匿名 ID、关闭统计、调试入口与本机地址不发、请求体只有三项、隐私说明覆盖全部事件。
- `tests/analytics-endpoint.test.ts`：白名单与客户端一致、请求体校验、不存请求头、跨站 403、未绑定数据库不存。
- `scripts/devloop/pages.test.mjs`：D1 查找 / 创建、建表、清理、绑定、各种失败不上传。
- 2026-11-20 本地用 wrangler 4.158.0 `pages dev` + 本地 D1 联调：页面打开与打开图鉴各写入 1 行，关闭统计后不再写入。
