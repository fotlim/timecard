/**
 * 挂卡时间轴 · 管理 API（面板后台）
 *
 * 这一组接口是给「Web 控制台」用的，不属于同步协议。
 * 全部挂在 /api/admin 下，复用 app.ts 里那条 /api/* 的 Bearer 鉴权中间件，
 * 所以没令牌一样进不来。
 *
 * 设计原则：
 *  - 只读接口绝不改数据；
 *  - 写操作只有两种：软删除 / 恢复 —— 都走 store.apply 分配游标，
 *    这样面板上的改动也会像正常同步一样传播到各设备；
 *  - 想物理删卡不提供，因为那会让卡在别的设备上「复活」（见协议铁律）。
 */

import { Hono } from 'hono'
import type { Card, CardChange } from '@timecard/shared'
import type { CardFilterStatus, StoreStats, SyncStore } from './store.js'
import type { Telemetry } from './telemetry.js'
import { SERVER_VERSION } from './version.js'

/** 运行时信息，由入口（node.ts / worker.ts）注入 */
export interface RuntimeInfo {
  kind: 'node' | 'worker'
  nodeVersion?: string
  dbPath?: string
  /** 返回数据库文件字节数；拿不到返回 0 */
  dbSizeBytes?: () => number
  /** 返回进程常驻内存字节数 */
  memoryBytes?: () => number
  hostname?: string
}

export interface AdminDeps {
  store: SyncStore
  telemetry: Telemetry
  runtime?: RuntimeInfo
}

const MAX_PAGE = 200
const DEFAULT_PAGE = 20

const STATUSES: readonly CardFilterStatus[] = ['all', 'open', 'done', 'archived', 'deleted']

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw)
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

function clientIp(c: {
  req: { header: (name: string) => string | undefined }
}): string | null {
  // 别解构 c.req.header —— Hono 内部依赖 this，解构会丢绑定
  const direct = c.req.header('cf-connecting-ip') ?? c.req.header('x-real-ip')
  if (direct) return direct
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]!.trim() || null
  return null
}

export function createAdminApp(deps: AdminDeps): Hono {
  const { store, telemetry, runtime } = deps
  const admin = new Hono()

  /** 面板自己发起写操作时用的 deviceId —— 让设备列表能认出「这是面板干的」 */
  const panelDevice = `panel@${runtime?.hostname ?? runtime?.kind ?? 'web'}`

  /**
   * 统计结果缓存。
   *
   * `stats()` 要在 SQL 里对每行的 card_json 做 json_extract，全表扫一遍。
   * 面板开着就每几秒调一次，多开几个标签页就是纯浪费 —— 所以加个短 TTL，
   * 并且**任何写操作之后立刻失效**，保证用户看到的数字不会滞后。
   */
  const STATS_TTL_MS = 2000
  let statsCache: { at: number; value: StoreStats } | null = null

  async function statsCached(): Promise<StoreStats> {
    const now = Date.now()
    if (statsCache && now - statsCache.at < STATS_TTL_MS) return statsCache.value
    const value = await store.stats()
    statsCache = { at: now, value }
    return value
  }
  function invalidateStats(): void {
    statsCache = null
  }

  /* ---------- 概览 ---------- */
  admin.get('/overview', async (c) => {
    const stats = await statsCached()
    const now = Date.now()
    return c.json({
      ok: true,
      version: SERVER_VERSION,
      serverTime: now,
      startedAt: telemetry.startedAt,
      uptimeMs: now - telemetry.startedAt,
      runtime: {
        kind: runtime?.kind ?? 'unknown',
        nodeVersion: runtime?.nodeVersion ?? null,
        memoryBytes: runtime?.memoryBytes ? runtime.memoryBytes() : null,
        dbPath: runtime?.dbPath ?? null,
        dbSizeBytes: runtime?.dbSizeBytes ? runtime.dbSizeBytes() : null
      },
      stats,
      devices: telemetry.devices(),
      activity: {
        buffered: telemetry.size(),
        latestId: telemetry.latestId(),
        /** 最近一分钟的粗略流量，面板用它判断"是不是真的活着" */
        lastMinute: telemetry.activity(60_000)
      }
    })
  })

  /* ---------- 卡片浏览 ---------- */
  admin.get('/cards', async (c) => {
    const statusRaw = c.req.query('status') ?? 'all'
    const status = (STATUSES as readonly string[]).includes(statusRaw)
      ? (statusRaw as CardFilterStatus)
      : 'all'
    const q = (c.req.query('q') ?? '').slice(0, 100)
    const limit = clampInt(c.req.query('limit'), DEFAULT_PAGE, 1, MAX_PAGE)
    const offset = clampInt(c.req.query('offset'), 0, 0, 10_000_000)

    const { rows, total } = await store.listCards({ status, q, limit, offset })
    return c.json({
      total,
      limit,
      offset,
      status,
      q,
      rows: rows.map((r) => ({ seq: r.seq, lastDeviceId: r.lastDeviceId, card: r.card }))
    })
  })

  /* ---------- 单张详情 ---------- */
  admin.get('/cards/:id', async (c) => {
    const id = c.req.param('id')
    const row = await store.getCard(id)
    if (!row) return c.json({ error: 'not_found', id }, 404)
    return c.json({ seq: row.seq, lastDeviceId: row.lastDeviceId, card: row.card })
  })

  /* ---------- 软删除 ---------- */
  admin.post('/cards/:id/delete', async (c) => {
    const started = Date.now()
    const id = c.req.param('id')
    const row = await store.getCard(id)
    if (!row) return c.json({ error: 'not_found', id }, 404)
    if (row.card.deletedAt !== null) {
      return c.json({ ok: true, alreadyDeleted: true, seq: row.seq })
    }

    const now = Date.now()
    const card: Card = { ...row.card, deletedAt: now, updatedAt: now, rev: row.card.rev + 1 }
    const change: CardChange = { card, deviceId: panelDevice, op: 'delete', clientAt: now }
    const result = await store.apply(change)
    invalidateStats()

    telemetry.record({
      kind: 'admin',
      deviceId: panelDevice,
      ok: result.outcome !== 'rejected',
      ...(result.outcome === 'rejected' ? { error: 'stale_write' } : {}),
      cursor: result.seq,
      ms: Date.now() - started,
      action: 'delete',
      cardId: id,
      ip: clientIp(c),
      ua: c.req.header('user-agent') ?? null
    })

    if (result.outcome === 'rejected') {
      return c.json(
        { ok: false, outcome: result.outcome, serverCard: result.serverCard ?? null },
        409
      )
    }
    return c.json({ ok: true, outcome: result.outcome, seq: result.seq })
  })

  /* ---------- 恢复（取消软删除） ---------- */
  admin.post('/cards/:id/restore', async (c) => {
    const started = Date.now()
    const id = c.req.param('id')
    const row = await store.getCard(id)
    if (!row) return c.json({ error: 'not_found', id }, 404)
    if (row.card.deletedAt === null) {
      return c.json({ ok: true, alreadyActive: true, seq: row.seq })
    }

    const now = Date.now()
    const card: Card = { ...row.card, deletedAt: null, updatedAt: now, rev: row.card.rev + 1 }
    const change: CardChange = { card, deviceId: panelDevice, op: 'restore', clientAt: now }
    const result = await store.apply(change)
    invalidateStats()

    telemetry.record({
      kind: 'admin',
      deviceId: panelDevice,
      ok: result.outcome !== 'rejected',
      ...(result.outcome === 'rejected' ? { error: 'stale_write' } : {}),
      cursor: result.seq,
      ms: Date.now() - started,
      action: 'restore',
      cardId: id,
      ip: clientIp(c),
      ua: c.req.header('user-agent') ?? null
    })

    if (result.outcome === 'rejected') {
      return c.json(
        { ok: false, outcome: result.outcome, serverCard: result.serverCard ?? null },
        409
      )
    }
    return c.json({ ok: true, outcome: result.outcome, seq: result.seq })
  })

  /* ---------- 实时事件（增量拉） ---------- */
  admin.get('/events', (c) => {
    const since = clampInt(c.req.query('since'), 0, 0, 2_000_000_000)
    const limit = clampInt(c.req.query('limit'), 100, 1, MAX_PAGE)
    const events = since > 0 ? telemetry.since(since, limit) : telemetry.recent(60)
    return c.json({ events, latestId: telemetry.latestId() })
  })

  /* ---------- 整理数据库 ---------- */
  admin.post('/optimize', async (c) => {
    if (!store.optimize) {
      return c.json({ ok: false, error: 'unsupported', message: '当前运行时（D1）不需要手动整理' }, 501)
    }
    const started = Date.now()
    try {
      await store.optimize()
    } catch (error) {
      return c.json({ ok: false, error: 'optimize_failed', message: String((error as Error).message) }, 500)
    }
    const ms = Date.now() - started
    invalidateStats()
    telemetry.record({
      kind: 'admin',
      deviceId: panelDevice,
      cursor: await store.maxSeq(),
      ms,
      action: 'optimize',
      ip: clientIp(c),
      ua: c.req.header('user-agent') ?? null
    })
    return c.json({ ok: true, ms, dbSizeBytes: runtime?.dbSizeBytes ? runtime.dbSizeBytes() : null })
  })

  /* ---------- 导出全部（备份用） ---------- */
  admin.get('/export', async (c) => {
    const all: Array<{ seq: number; lastDeviceId: string; card: Card }> = []
    const pageSize = MAX_PAGE
    let offset = 0
    // 分页把整表取完，避免一次性把极大库读进内存
    for (let guard = 0; guard < 10_000; guard += 1) {
      const { rows } = await store.listCards({ status: 'all', q: '', limit: pageSize, offset })
      for (const r of rows) all.push({ seq: r.seq, lastDeviceId: r.lastDeviceId, card: r.card })
      if (rows.length < pageSize) break
      offset += pageSize
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    c.header('Content-Disposition', `attachment; filename="timecard-export-${stamp}.json"`)
    c.header('Content-Type', 'application/json; charset=utf-8')
    return c.body(
      JSON.stringify(
        {
          exportedAt: Date.now(),
          version: SERVER_VERSION,
          count: all.length,
          cards: all
        },
        null,
        2
      )
    )
  })

  return admin
}
