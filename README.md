# EdgeKintai

EdgeKintai 是面向日本工作场景的多用户勤怠管理工具，运行在 Cloudflare Workers 上。它用 D1 保存用户、会话、勤怠记录和日本节假日缓存，并在浏览器内生成月度 Excel。

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/workHMZ/EdgeKintai)

> 架构中不使用 R2。Excel 不会上传或保存到 Cloudflare，而是由当前浏览器直接生成和下载。

## 功能

- 管理员和普通用户：管理员可创建和删除用户，并查看全员月度概况。
- 登录名、姓名和密码分离：登录名只用于认证，姓名用于界面和公司报表。
- 出勤、在宅、有给休假、休日和缺勤分类，记录出勤、退勤、休憩时长和备注。
- 自动识别周六、周日和日本法定节假日。节假日数据来自[日本内阁府官方 CSV](https://www8.cao.go.jp/chosei/shukujitsu/gaiyou.html)，每周刷新并保留最后一份有效缓存。
- 交通费按「片道」金额记录，明确选择「片道」或「往復」；往復合计由系统计算，避免重复翻倍。
- 每个用户可设置默认片道交通费和默认行程类型，并在个人设置里随时补录或修正历史记录。
- 月度日历、实働时间、交通费、未完整记录和公司月度阈值汇总。
- 月度 Excel（`.xlsx`）在浏览器内生成，可直接提交给公司。

## 架构

```text
浏览器
  ├─ 页面 / CSS / 浏览器端 Excel ──> Workers Static Assets
  └─ /api/* ──> Hono API Worker ──> D1
                                      ├─ users / sessions
                                      ├─ attendance
                                      ├─ holidays_cache
                                      └─ audit_logs
```

`wrangler.jsonc` 只让 `/api/*` 优先进入 Worker。其他请求由 Workers Static Assets 直接响应，不执行动态 Worker。导出 API 只返回小型月度 JSON，XLSX 的 ZIP/XML 工作在浏览器完成。

## Cloudflare Workers Free 适配性

以 2026-07-31 的 Cloudflare 公开限制为准：

| 项目 | Free 额度 | EdgeKintai 的使用方式 |
|---|---:|---|
| 动态 Worker 请求 | 100,000 次/日（00:00 UTC 重置） | 只有 `/api/*` 计入，适合个人和小团队勤怠 |
| HTTP / Cron CPU | 每次 10 ms | Excel 移到浏览器；API 避免大型服务器端生成 |
| 内存 | 128 MB | 请求仅处理当前用户或当月数据 |
| Workers | 每账户 100 个 | 使用 1 个 |
| Worker 压缩包 | 3 MB | 静态文件与 API bundle 分离 |
| Static Assets | 请求免费且不限量；20,000 个文件/版本，单文件 25 MiB | 页面、CSS 和浏览器端代码均在此层 |
| Cron Triggers | 每账户 5 个 | 使用 1 个，每周一 03:00 JST 更新节假日缓存 |
| D1 数据库 | 每账户 10 个 | 使用 1 个 APAC 数据库 |
| D1 读取 | 5,000,000 行/日 | 主要查询有索引，月度报表按用户和日期范围读取 |
| D1 写入 | 100,000 行/日 | 日常打卡、设置和会话写入量很小 |
| D1 存储 | 500 MB/数据库，账户合计 5 GB | 结构化文本数据，不存储 Excel 二进制文件 |

参考：[Workers 限制](https://developers.cloudflare.com/workers/platform/limits/)、[Workers 价格与静态资源计费](https://developers.cloudflare.com/workers/platform/pricing/)、[Static Assets 计费](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[D1 价格](https://developers.cloudflare.com/d1/platform/pricing/)、[D1 限制](https://developers.cloudflare.com/d1/platform/limits/)。

Free 计划的 10 ms 是 CPU 时间，等待 D1 或网络响应的时间不计入。但认证和节假日 CSV 解析仍会使用 CPU，所以「适合 Free」不等于任何负载下都保证不超限。上线后应在 Cloudflare 仪表板观察 CPU 和 Error 1102；大规模团队或高频自动化请求应重新评估 Paid 计划。

Free 计划会自动应用 10 ms CPU 上限，`wrangler.jsonc` 不应设置 `limits.cpu_ms`；Cloudflare 只允许付费 Standard Usage Model 自定义该字段。部署助手会在发布前检查并拒绝不兼容配置。

修改密码已拆为「验证当前密码」和「写入新密码」两个请求，每次最多执行一次 PBKDF2；短时重新验证凭据只能消费一次。对官方 CSV 中不存在的年份还会缓存 15 分钟失败状态，避免重复解析占用 Free CPU。

## 一键部署

### 方式 A：Deploy to Cloudflare

点击顶部按钮。Cloudflare 会从公开仓库 [`workHMZ/EdgeKintai`](https://github.com/workHMZ/EdgeKintai) 创建你的副本，自动配置 Workers Builds，并根据 Wrangler 配置创建和绑定 D1。

部署页面要求 `SETUP_TOKEN` 时，请在自己的终端生成一个独立随机值：

```bash
openssl rand -hex 32
```

只把输出填入 Cloudflare 的加密 Secret 字段，不要写入代码、`wrangler.jsonc`、Issue 或提交记录。

### 方式 B：本地幂等部署助手

需要 Node.js 24.11+ 和一个 Cloudflare 账户：

```bash
npm ci
npm run deploy:cf
```

如果 Wrangler 登录可访问多个 Cloudflare 账户，部署助手会拒绝猜测目标。请使用 `wrangler auth create` / `wrangler auth activate` 创建只授权目标账户的目录 profile，或在命令前显式设置非机密的 `CLOUDFLARE_ACCOUNT_ID`。助手会验证该 ID 确实属于当前登录。

`deploy:cf` 按以下顺序执行，任何一步失败都会立即停止：

1. 运行完整 `verify`。
2. 检查 Wrangler 登录；交互式终端中可引导完成登录。
3. 按名称复用 `edge-kintai-db`；不存在时使用 `apac` 位置提示创建。
4. 仅当 `database_id` 仍是公开仓库的全零 placeholder 时替换它；已配置为同一 D1 时保持不变，冲突时拒绝覆盖。
5. 在远程 D1 应用尚未执行的 migrations。
6. 保留现有 `SETUP_TOKEN`；仅在首次部署且 Secret 不存在时生成和上传。新值只在当前终端显示一次。
7. 部署 Static Assets、API Worker 和 D1 绑定。

助手不读取 `.dev.vars`，不会轮换已存在的 Secret，也不会自动删除任何 Cloudflare 资源。重复运行时只应用新 migration 并发布新版本。

本项目 1.0 采用全新的最终 schema，不兼容最初 Demo 的数据库。原 Demo 使用 `kintai-db`，部署助手使用新的 `edge-kintai-db`；请不要手动把旧 Demo D1 绑定到本项目。

如果首次管理员尚未创建、但你遗失了原来的 `SETUP_TOKEN`，请在 Cloudflare 仪表板手动更新该 Secret；已有用户后，setup 入口始终关闭，轮换它不会修改用户密码。

## Workers Builds 设置

手动把 GitHub 仓库连接到 Workers Builds 时，设置：

| 设置 | 值 |
|---|---|
| Production branch | `main` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Build variable | `NODE_VERSION=24.11.0` |

`npm run deploy` 会先执行 `wrangler d1 migrations apply DB --remote`，然后再执行 `wrangler deploy`，因此不会用新代码访问旧 schema。首次 Build 前还需要：

- 确认 D1 绑定名为 `DB`，并且 `database_id` 不再是全零 placeholder。
- 在 Worker 的 Variables and Secrets 中创建加密 Secret `SETUP_TOKEN`。
- 不要把生产 Secret 放入 Workers Builds 的普通明文变量。

参考：[Deploy to Cloudflare 按钮](https://developers.cloudflare.com/workers/platform/deploy-buttons/)、[Workers Builds 配置](https://developers.cloudflare.com/workers/ci-cd/builds/configuration/)、[Workers Builds 的 Node.js 版本](https://developers.cloudflare.com/workers/ci-cd/builds/build-image/)。

## 本地开发

```bash
npm ci
test -e .dev.vars || cp .dev.vars.example .dev.vars
# 用 `openssl rand -hex 32` 的输出替换 .dev.vars 中的 placeholder
npm run db:migrate:local
npm run dev
```

打开 `http://localhost:8787`。首次设置需要：

- `.dev.vars` 中的 `SETUP_TOKEN`；
- 独立的登录名；
- 12-128 个字符的登录密码；
- 显示和 Excel 使用的姓名；
- 默认片道交通费和「片道 / 往復」。

首个用户会以管理员身份原子创建。初期设置完成后，其他用户应由管理员创建。

常用校验命令：

```bash
npm run verify
npm run deploy:dry-run
```

## 配置

`wrangler.jsonc` 中的非敏感默认值：

| 变量 | 默认值 | 用途 |
|---|---:|---|
| `DEFAULT_BREAK_MINUTES` | `60` | 新勤怠记录的默认休憩分钟 |
| `DEFAULT_ONE_WAY_FARE` | `210` | 用户没有个人默认值时的片道交通费 |
| `DEFAULT_TRIP_TYPE` | `round_trip` | `one_way` 或 `round_trip` |
| `OVERTIME_THRESHOLD_HOURS` | `180` | 公司月度报表阈值，不是日本劳动法的法律判定 |
| `SESSION_TTL_SECONDS` | `604800` | 会话有效期，默认 7 天 |

个人交通费设置优先于全局默认，且每天的记录仍可单独修改。

## 安全与数据

- 会话 Cookie 使用 `HttpOnly; Secure; SameSite=Strict`；D1 只保存随机会话 token 的 SHA-256 摘要。
- 密码以加盐 PBKDF2-SHA-256 保存，不存储明文。
- 用户被删除或角色被修改后，后续请求会立即使用 D1 中的当前状态。
- `SETUP_TOKEN` 只是初始管理员引导凭据，必须以 Cloudflare Secret 保存。
- D1 Free 提供 7 天 Time Travel，但重要的公司提交记录仍应按组织规则定期备份。

## 许可证

[MIT](./LICENSE)
