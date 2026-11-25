# 挂卡时间轴 · 同步服务器

**Hono 一套代码、两个运行时**：

- **Node + SQLite**（`node:sqlite`，无原生依赖）—— 自己的 VPS / 本地开发
- **Cloudflare Workers + D1** —— 白嫖托管

可打包成 **零依赖单文件** `server.mjs`，一条 `node` 命令即可运行。接口完全对齐 `packages/shared/src/sync.ts`。

## 运行（Node）

```bash
pnpm --filter @timecard/server build
TIMECARD_TOKEN=你的密钥 node apps/server/dist/node.js
# 或打成单文件：
node apps/server/scripts/bundle.mjs && node dist/server.mjs
```

环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 要对外请设 `0.0.0.0`（务必配好鉴权与反代） |
| `TIMECARD_TOKEN` | 无 | 访问令牌；不设 = 完全开放，只建议本地开发 |
| `TIMECARD_DB` | `./data/timecard.sqlite` | SQLite 文件路径 |

启动后浏览器打开根路径 `http://<host>:<port>/` 即为 **Web 控制台**。

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查（免鉴权） |
| POST | `/api/sync/push` | 推送本地变更（`deviceId` + `changes[]`） |
| GET | `/api/sync/pull?since=&limit=` | 按游标增量拉取 |
| GET | `/api/admin/overview` | 控制台：统计 / 设备 / 运行时 |
| GET | `/api/admin/cards?status=&q=&limit=&offset=` | 卡片浏览 |
| GET | `/api/admin/cards/:id` | 单卡详情 |
| POST | `/api/admin/cards/:id/delete` | 软删除 |
| POST | `/api/admin/cards/:id/restore` | 恢复 |
| GET | `/api/admin/events?since=&limit=` | 增量事件流 |
| POST | `/api/admin/optimize` | 整理数据库 |
| GET | `/api/admin/export` | 导出全部 JSON |

`/api/admin/*` 与同步接口共用同一套 Bearer 令牌。

## 同步模型

离线优先 + 操作日志 + 最后写入者胜（LWW）：`updatedAt` 先比、相同则 `deviceId` 字典序；
拉取按自增游标 `seq` 增量；卡片永远软删除。三端调用同一个 `isNewer()`，避免同步震荡。

## 布置到 Cloudflare Workers

```bash
npx wrangler d1 create timecard      # 把返回的 database_id 填进 wrangler.toml
npx wrangler secret put TIMECARD_TOKEN
npx wrangler deploy
```

## 测试

三套「起真进程、打真 HTTP」的测试（支持 `TC_TEST_PORT` 指定端口）：

```bash
node test/e2e.js          # 协议 / 鉴权 / LWW / 软删 / 分页 / 校验 / 重启
node test/concurrency.js  # 并发写同一张卡 / 游标不重号 / 大卡片 / 体积上限
node test/admin.js        # 控制台静态页 / 概览 / 卡片浏览 / 软删恢复 / 事件流 / 导出 / 整理
```

## 安全提示

- 令牌泄露 = 数据可被任意读写；要上公网建议在反向代理层加访问控制
- 没有多用户 / 配额 / 限速，适合个人自用
- 控制台页面本身公开（只是一张要填令牌的壳），数据接口受令牌保护
