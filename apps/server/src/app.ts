/**
 * 挂卡时间轴 · 同步服务器（Hono，Node 与 Cloudflare Workers 共用）
 *
 * 同步接口只有三个，全部对齐 packages/shared 里的协议：
 *   GET  /api/health        健康检查
 *   POST /api/sync/push     推送本地变更
 *   GET  /api/sync/pull     按游标增量拉取
 *
 * 另外有两组"非协议"内容：
 *   GET  /               Web 控制台（纯静态页，无需鉴权，页面自己让用户填令牌）
 *   /api/admin/*         控制台后台接口（复用下面的 Bearer 鉴权）
 */

import { Hono } from 'hono'
import type { Context } from 'hono'
import { cors } from 'hono/cors'
import { HTTPException } from 'hono/http-exception'
import {
  API_PATHS,
  AUTH_HEADER,
  AUTH_SCHEME,
  PULL_PAGE_SIZE,
  PUSH_BATCH_SIZE
} from '@timecard/shared'
import type {
  Card,
  CardChange,
  HealthResponse,
  PullResponse,
  PushResponse,
  RejectedCard
} from '@timecard/shared'
import type { SyncStore } from './store.js'
import { Telemetry } from './telemetry.js'
import type { EventKind } from './telemetry.js'
import { createAdminApp } from './admin.js'
import type { RuntimeInfo } from './admin.js'
import { ADMIN_HTML } from './admin-ui.generated.js'
import { SERVER_VERSION } from './version.js'

export { SERVER_VERSION } from './version.js'
export type { RuntimeInfo } from './admin.js'

/** 单次请求体上限：50 张卡 × 每张几 KB，给到 1 MB 绰绰有余 */
const MAX_BODY_BYTES = 1024 * 1024

export interface AppOptions {
  store: SyncStore
  /** 访问令牌；不设则开放（仅用于本地开发） */
  token?: string
  /** 允许的来源，默认 * */
  corsOrigin?: string
  /** 观测层；不传则内部自建一个（Worker 请务必外部传入单例） */
  telemetry?: Telemetry
  /** 运行时信息，用于面板展示 */
  runtime?: RuntimeInfo
}

/* ============================================================
 * 认证
 * ========================================================== */

/**
 * 定长时间比较，避免用响应时间把 token 一位一位试出来。
 *
 * 不用 `crypto.subtle.timingSafeEqual` —— 那是 Cloudflare 的扩展，
 * 标准 Web Crypto 里没有，自己写反而两个运行时都能跑。
 */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder()
  const ab = enc.encode(a)
  const bb = enc.encode(b)
  // 长度不同也走完整轮比较，别提前 return 泄露长度信息
  let diff = ab.length ^ bb.length
  const len = Math.max(ab.length, bb.length)
  for (let i = 0; i < len; i += 1) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0)
  }
  return diff === 0
}

function extractToken(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, ...rest] = header.trim().split(/\s+/)
  if (!scheme || scheme.toLowerCase() !== AUTH_SCHEME.toLowerCase()) return null
  const value = rest.join(' ')
  return value || null
}

/** 取客户端 IP：优先反代给的真实 IP */
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  // 注意：不要 `const h = c.req.header` 再调用 —— Hono 的 header 依赖 this.raw，
  // 解构后会丢 this 绑定直接抛错。
  const direct = c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip')
  if (direct) return direct
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim() || null
  return null
}

/** 没走到解析阶段时，只能靠客户端自报的 X-Device-Id 认设备 */
function deviceIdHeader(c: { req: { header: (name: string) => string | undefined } }): string {
  return c.req.header('x-device-id')?.trim() || '(匿名)'
}

/** 按路径猜这次请求属于哪类事件；认不出来就不记账 */
function kindForPath(path: string): EventKind | null {
  if (path === API_PATHS.push) return 'push'
  if (path === API_PATHS.pull) return 'pull'
  if (path.startsWith('/api/admin')) return 'admin'
  return null
}

/* ============================================================
 * 校验
 * ========================================================== */

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isNonEmptyString = (v: unknown): v is string => typeof v === 'string' && v.length > 0

/** 卡片的最小合法性检查。宁可 400 也不要让脏数据进库。 */
export function validateCard(value: unknown): string[] {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null) return ['card 不是对象']
  const c = value as Record<string, unknown>

  if (!isNonEmptyString(c['id'])) errors.push('id 缺失')
  if (typeof c['title'] !== 'string') errors.push('title 不是字符串')
  if (!isFiniteNumber(c['anchorAt'])) errors.push('anchorAt 不是数字')
  if (!isFiniteNumber(c['updatedAt'])) errors.push('updatedAt 不是数字')
  if (!isFiniteNumber(c['createdAt'])) errors.push('createdAt 不是数字')
  if (!isFiniteNumber(c['rev'])) errors.push('rev 不是数字')
  if (!Array.isArray(c['items'])) errors.push('items 不是数组')
  if (!('deletedAt' in c)) errors.push('deletedAt 字段缺失')
  else if (c['deletedAt'] !== null && !isFiniteNumber(c['deletedAt'])) {
    errors.push('deletedAt 必须是 null 或数字')
  }
  if (c['status'] !== 'open' && c['status'] !== 'done' && c['status'] !== 'archived') {
    errors.push('status 取值非法')
  }
  return errors
}

export function validateChange(value: unknown): string[] {
  const errors: string[] = []
  if (typeof value !== 'object' || value === null) return ['change 不是对象']
  const ch = value as Record<string, unknown>
  if (!isNonEmptyString(ch['deviceId'])) errors.push('deviceId 缺失')
  const ops = ['create', 'update', 'delete', 'restore']
  if (!ops.includes(ch['op'] as string)) errors.push('op 取值非法')
  errors.push(...validateCard(ch['card']).map((e) => `card.${e}`))
  return errors
}

/* ============================================================
 * 应用
 * ========================================================== */

export function createApp(options: AppOptions): Hono {
  const { store, token } = options
  const telemetry = options.telemetry ?? new Telemetry()
  const app = new Hono()

  /** 记一条失败事件。失败不记的话，面板永远只显示"成功"，看着像一切正常 */
  const recordFail = (
    c: Context,
    kind: EventKind,
    error: string,
    started: number,
    deviceId?: string
  ): void => {
    telemetry.record({
      kind,
      deviceId: deviceId ?? deviceIdHeader(c),
      ok: false,
      error,
      cursor: 0,
      ms: Date.now() - started,
      ip: clientIp(c),
      ua: c.req.header('user-agent') ?? null
    })
  }

  app.use('*', cors({ origin: options.corsOrigin ?? '*' }))

  // 统一鉴权：除了健康检查 / 面板静态页，其余 /api/* 都要 token
  app.use('/api/*', async (c, next) => {
    if (c.req.path === API_PATHS.health) return next()
    if (!token) return next() // 未配置 token = 开发模式，放行
    const got = extractToken(c.req.header(AUTH_HEADER))
    if (!got || !(await safeEqual(got, token))) {
      // 令牌错/过期也算一次失败 —— 这类问题在设备端表现得像"网络不通"，
      // 不在服务端记下来就永远查不到原因
      const kind = kindForPath(c.req.path)
      if (kind) recordFail(c, kind, 'unauthorized', Date.now())
      return c.json({ error: 'unauthorized' }, 401)
    }
    return next()
  })

  /* ---------- Web 控制台（静态页，公开） ---------- */
  const serveUi = (c: Context): Response => {
    c.header('Cache-Control', 'no-cache')
    return c.html(ADMIN_HTML)
  }
  app.get('/', serveUi)
  app.get('/admin', serveUi)
  app.get('/admin/', serveUi)
  app.get('/index.html', serveUi)
  // 别让浏览器找 favicon 刷出 404 日志
  app.get('/favicon.ico', (c) => c.body(null, 204))

  /* ---------- 健康检查 ---------- */
  app.get(API_PATHS.health, async (c) => {
    const body: HealthResponse = {
      ok: true,
      serverTime: Date.now(),
      cardCount: await store.count(),
      version: SERVER_VERSION
    }
    return c.json(body)
  })

  /* ---------- 推送 ---------- */
  app.post(API_PATHS.push, async (c) => {
    const started = Date.now()
    // 先看声明的长度，超了直接拒，别把大包整个读进内存再判断
    const declared = Number(c.req.header('content-length') ?? '')
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      recordFail(c, 'push', 'payload_too_large', started)
      return c.json({ error: 'payload_too_large', limit: MAX_BODY_BYTES }, 413)
    }

    const raw = await c.req.text()
    if (raw.length > MAX_BODY_BYTES) {
      recordFail(c, 'push', 'payload_too_large', started)
      return c.json({ error: 'payload_too_large', limit: MAX_BODY_BYTES }, 413)
    }

    let payload: unknown
    try {
      payload = JSON.parse(raw)
    } catch {
      recordFail(c, 'push', 'invalid_json', started)
      return c.json({ error: 'invalid_json' }, 400)
    }

    if (typeof payload !== 'object' || payload === null) {
      recordFail(c, 'push', 'invalid_body', started)
      return c.json({ error: 'invalid_body' }, 400)
    }
    const body = payload as { deviceId?: unknown; changes?: unknown }

    if (!isNonEmptyString(body.deviceId)) {
      recordFail(c, 'push', 'missing_device_id', started)
      return c.json({ error: 'missing_device_id' }, 400)
    }
    if (!Array.isArray(body.changes)) {
      recordFail(c, 'push', 'changes_must_be_array', started, body.deviceId)
      return c.json({ error: 'changes_must_be_array' }, 400)
    }
    if (body.changes.length > PUSH_BATCH_SIZE) {
      recordFail(c, 'push', 'batch_too_large', started, body.deviceId)
      return c.json(
        { error: 'batch_too_large', limit: PUSH_BATCH_SIZE, got: body.changes.length },
        400
      )
    }

    // 逐条校验，任何一条不合法就整批拒绝 —— 避免"半成功"这种最难排查的状态
    const invalid: Array<{ index: number; errors: string[] }> = []
    body.changes.forEach((ch, index) => {
      const errors = validateChange(ch)
      if (errors.length) invalid.push({ index, errors })
    })
    if (invalid.length) {
      recordFail(c, 'push', 'invalid_changes', started, body.deviceId)
      return c.json({ error: 'invalid_changes', details: invalid }, 400)
    }

    const changes = body.changes as CardChange[]
    const deviceId = body.deviceId
    const accepted: string[] = []
    const rejected: RejectedCard[] = []

    for (const change of changes) {
      // 以请求体里的 deviceId 为准，防止客户端漏填或填错
      const normalized: CardChange = {
        card: change.card as Card,
        deviceId,
        op: change.op,
        clientAt: isFiniteNumber(change.clientAt) ? change.clientAt : Date.now()
      }
      const result = await store.apply(normalized)
      if (result.outcome === 'accepted') {
        accepted.push(normalized.card.id)
      } else if (result.outcome === 'rejected') {
        rejected.push({ id: normalized.card.id, serverCard: result.serverCard ?? normalized.card })
      }
      // 'unchanged'：完全相同的重复推送，两边都不动，静默忽略
    }

    const cursor = await store.maxSeq()
    telemetry.record({
      kind: 'push',
      deviceId,
      ok: true,
      accepted: accepted.length,
      rejected: rejected.length,
      unchanged: changes.length - accepted.length - rejected.length,
      cursor,
      ms: Date.now() - started,
      ip: clientIp(c),
      ua: c.req.header('user-agent') ?? null
    })

    const response: PushResponse = {
      accepted,
      rejected,
      cursor,
      serverTime: Date.now()
    }
    return c.json(response)
  })

  /* ---------- 拉取 ---------- */
  app.get(API_PATHS.pull, async (c) => {
    const started = Date.now()
    const sinceRaw = c.req.query('since') ?? '0'
    const limitRaw = c.req.query('limit')

    const since = Number(sinceRaw)
    if (!Number.isInteger(since) || since < 0) {
      recordFail(c, 'pull', 'invalid_since', started)
      return c.json({ error: 'invalid_since' }, 400)
    }

    let limit = PULL_PAGE_SIZE
    if (limitRaw !== undefined) {
      const n = Number(limitRaw)
      if (!Number.isInteger(n) || n <= 0) {
        recordFail(c, 'pull', 'invalid_limit', started)
        return c.json({ error: 'invalid_limit' }, 400)
      }
      // 上限压死，防止有人一次拉整库把内存打爆
      limit = Math.min(n, 500)
    }

    const rows = await store.listSince(since, limit)
    const last = rows[rows.length - 1]
    const cursor = last ? last.seq : since

    // 拉取协议本身不带 deviceId，靠客户端加的 X-Device-Id 头来认设备；
    // 老客户端没有这个头就记成匿名，不影响功能。
    const pulledDevice = c.req.header('x-device-id')?.trim()
    telemetry.record({
      kind: 'pull',
      deviceId: pulledDevice || '(匿名)',
      ok: true,
      pulled: rows.length,
      cursor,
      ms: Date.now() - started,
      ip: clientIp(c),
      ua: c.req.header('user-agent') ?? null
    })

    const response: PullResponse = {
      changes: rows.map((r) => ({
        seq: r.seq,
        card: r.card,
        lastDeviceId: r.lastDeviceId
      })),
      cursor,
      hasMore: rows.length === limit,
      serverTime: Date.now()
    }
    return c.json(response)
  })

  /* ---------- 管理面板接口 ---------- */
  app.route('/api/admin', createAdminApp({ store, telemetry, runtime: options.runtime }))

  app.notFound((c) => c.json({ error: 'not_found', path: c.req.path }, 404))

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse()
    console.error('[server] 未处理错误', err)
    return c.json({ error: 'internal_error', message: String(err?.message ?? err) }, 500)
  })

  return app
}
