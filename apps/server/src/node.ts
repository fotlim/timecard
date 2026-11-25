/**
 * Node 入口：自己的 VPS / 本地开发
 *
 * 环境变量：
 *   PORT            监听端口，默认 8787
 *   HOST            监听地址，默认 127.0.0.1（要公网请设 0.0.0.0）
 *   TIMECARD_TOKEN  访问令牌；不设则开放，**只建议本地开发时省略**
 *   TIMECARD_DB     SQLite 文件路径，默认 ./data/timecard.sqlite
 */

import { serve } from '@hono/node-server'
import { mkdirSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, resolve } from 'node:path'
import { createApp } from './app.js'
import type { RuntimeInfo } from './app.js'
import { SqliteStore } from './store-sqlite.js'
import { Telemetry } from './telemetry.js'
import { SERVER_VERSION } from './version.js'

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 8787)
  const host = process.env['HOST'] ?? '127.0.0.1'
  const token = process.env['TIMECARD_TOKEN']
  const dbPath = resolve(process.env['TIMECARD_DB'] ?? './data/timecard.sqlite')

  mkdirSync(dirname(dbPath), { recursive: true })

  const store = new SqliteStore(dbPath)
  await store.init()

  if (!token) {
    console.warn('[server] ⚠️  没有设置 TIMECARD_TOKEN，接口完全开放 —— 只在本地开发时这样用')
  }

  const telemetry = new Telemetry()
  const runtime: RuntimeInfo = {
    kind: 'node',
    nodeVersion: process.version,
    dbPath,
    dbSizeBytes: () => {
      try {
        return statSync(dbPath).size
      } catch {
        return 0
      }
    },
    memoryBytes: () => process.memoryUsage().rss,
    hostname: hostname()
  }

  const app = createApp({ store, token, telemetry, runtime })

  const server = serve({ fetch: app.fetch, port, hostname: host }, (info) => {
    console.log(`[server] 挂卡时间轴同步服务已启动 · v${SERVER_VERSION}`)
    console.log(`[server]   同步接口 http://${host}:${info.port}/api/health`)
    console.log(`[server]   控制台   http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${info.port}/`)
    console.log(`[server]   数据库   ${dbPath}`)
    console.log(`[server]   鉴权     ${token ? '已开启' : '关闭（开发模式）'}`)
  })

  let closing = false
  const shutdown = (signal: string): void => {
    if (closing) return
    closing = true
    console.log(`\n[server] 收到 ${signal}，正在关闭…`)
    server.close(() => {
      try {
        // 关库前整理一次：更新统计信息 + 回收空间（失败也无所谓）
        store.optimize?.()
      } catch (error) {
        console.warn('[server] 关闭前整理数据库失败（忽略）', error)
      }
      store.close()
      process.exit(0)
    })
    // 兜底：5 秒还没关完就强退
    setTimeout(() => process.exit(0), 5000).unref()
  }

  process.on('SIGINT', () => shutdown('SIGINT'))
  process.on('SIGTERM', () => shutdown('SIGTERM'))
}

main().catch((error) => {
  console.error('[server] 启动失败', error)
  process.exit(1)
})
