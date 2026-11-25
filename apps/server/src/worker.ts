/**
 * Cloudflare Workers 入口
 *
 * 绑定（wrangler.toml）：
 *   DB              D1 数据库
 *   TIMECARD_TOKEN  访问令牌（用 wrangler secret put TIMECARD_TOKEN 设置）
 *
 * 观测层放模块级单例：同一个 isolate 复用，跨请求能看到近期流量；
 * 不同 isolate 之间互不相通（这是 Worker 的天然限制，不是 bug）。
 */

import { createApp } from './app.js'
import type { RuntimeInfo } from './app.js'
import { D1Store } from './store-d1.js'
import type { Env } from './store-d1.js'
import { Telemetry } from './telemetry.js'

let initialized = false
const telemetry = new Telemetry()
const runtime: RuntimeInfo = { kind: 'worker', hostname: 'worker' }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const store = new D1Store(env.DB)

    // 建表是幂等的，但没必要每个请求都跑一遍 —— 每个 isolate 只做一次
    if (!initialized) {
      await store.init()
      initialized = true
    }

    const app = createApp({ store, token: env.TIMECARD_TOKEN, telemetry, runtime })
    return app.fetch(request, env)
  }
}
