/**
 * 移动端同步
 *
 * 协议和桌面端完全一致（见 packages/shared/src/sync.ts）：
 *   推 Outbox → 拉游标 → 冲突用 isNewer 决胜
 * 只是把 Electron 主进程的那层换成了直接 fetch。
 */

import {
  API_PATHS,
  AUTH_HEADER,
  AUTH_SCHEME,
  PULL_PAGE_SIZE,
  PUSH_BATCH_SIZE,
  isNewer
} from '@timecard/shared'
import type {
  Card,
  CardSnapshot,
  OutboxEntry,
  PullResponse,
  PushResponse,
  RejectedCard,
  SyncPhase
} from '@timecard/shared'
import * as db from './store'

export interface SyncReport {
  ok: boolean
  pushed: number
  pulled: number
  conflicts: RejectedCard[]
  error: string | null
}

let phase: SyncPhase = 'idle'
let lastError: string | null = null
let lastReport: SyncReport | null = null
let running = false

const listeners = new Set<() => void>()

export function subscribeSync(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function emit(): void {
  listeners.forEach((fn) => fn())
}

export function syncState(): { phase: SyncPhase; error: string | null; report: SyncReport | null } {
  return { phase, error: lastError, report: lastReport }
}

function setPhase(next: SyncPhase, error: string | null = null): void {
  phase = next
  lastError = error
  emit()
}

/* ============================================================
 * 错误翻译（和桌面端同一套口径）
 * ========================================================== */

function errorText(error: unknown): string {
  if (!error) return ''
  const e = error as { message?: string; cause?: { code?: string; message?: string } }
  return [e.message, e.cause?.code, e.cause?.message].filter(Boolean).join(' ') || String(error)
}

export function describeError(raw: string): string {
  if (!raw) return '未知错误'
  if (/HTTP 401|unauthorized/i.test(raw)) return '令牌不正确（服务器返回 401）'
  if (/HTTP 403/i.test(raw)) return '服务器拒绝了这次请求（403）'
  if (/HTTP 404/i.test(raw)) return '服务器地址不对 —— 找不到 /api/sync 接口'
  if (/HTTP 5\d\d/i.test(raw)) return '服务器内部出错了，稍后自动重试'
  if (/ECONNREFUSED/i.test(raw)) return '连不上服务器 —— 端口没开或地址不对'
  if (/ENOTFOUND|EAI_AGAIN/i.test(raw)) return '找不到这个域名'
  if (/ETIMEDOUT|abort/i.test(raw)) return '连接超时 —— 服务器没响应'
  if (/CERT|certificate/i.test(raw)) return 'HTTPS 证书有问题'
  if (/fetch failed|Failed to fetch|NetworkError/i.test(raw)) return '网络不通，稍后自动重试'
  return raw
}

/* ============================================================
 * HTTP
 * ========================================================== */

function base(): string {
  return db.raw().sync.serverUrl.trim().replace(/\/+$/, '')
}

function headers(): Record<string, string> {
  const token = db.raw().sync.token
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    // 拉取请求体里没有 deviceId，靠这个头让服务端面板能认出是哪台设备在拉
    'X-Device-Id': db.raw().deviceId
  }
  if (token) h[AUTH_HEADER] = `${AUTH_SCHEME} ${token}`
  return h
}

async function request<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      headers: { ...headers(), ...(init?.headers ?? {}) },
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 160)}` : ''}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

export interface ConnectionTest {
  ok: boolean
  version?: string
  cardCount?: number
  message?: string
  ms?: number
}

export async function testConnection(serverUrl: string, token: string): Promise<ConnectionTest> {
  const b = serverUrl.trim().replace(/\/+$/, '')
  if (!b) return { ok: false, message: '还没填服务器地址' }
  if (!/^https?:\/\//i.test(b)) return { ok: false, message: '地址要以 http:// 或 https:// 开头' }

  const started = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(`${b}${API_PATHS.health}`, {
      headers: token ? { [AUTH_HEADER]: `${AUTH_SCHEME} ${token}` } : {},
      signal: controller.signal
    })
    const ms = Date.now() - started
    if (!res.ok) return { ok: false, message: describeError(`HTTP ${res.status}`), ms }
    const body = (await res.json()) as { ok?: boolean; version?: string; cardCount?: number }
    if (!body.ok) return { ok: false, message: '服务器回应异常', ms }
    return { ok: true, version: body.version, cardCount: body.cardCount, ms }
  } catch (error) {
    return { ok: false, message: describeError(errorText(error)), ms: Date.now() - started }
  } finally {
    clearTimeout(t)
  }
}

/* ============================================================
 * 推送 / 拉取
 * ========================================================== */

async function pushOnce(): Promise<{ pushed: number; conflicts: RejectedCard[] }> {
  const deviceId = db.raw().deviceId
  let pushed = 0
  const conflicts: RejectedCard[] = []

  for (let round = 0; round < 20; round += 1) {
    const batch: OutboxEntry[] = db.takeOutbox(PUSH_BATCH_SIZE)
    if (batch.length === 0) break

    const body = {
      deviceId,
      changes: batch.map((e) => ({ card: e.card, deviceId, op: e.op, clientAt: e.enqueuedAt }))
    }

    let res: PushResponse
    try {
      res = await request<PushResponse>(API_PATHS.push, {
        method: 'POST',
        body: JSON.stringify(body)
      })
    } catch (error) {
      db.markOutboxFailure(
        batch.map((e) => e.id),
        errorText(error)
      )
      throw error
    }

    for (const rej of res.rejected) {
      db.applyServerCard(rej.serverCard)
      conflicts.push(rej)
    }

    const idMap = new Map(batch.map((e) => [e.cardId, e.id]))
    const done = new Set<number>()
    for (const cardId of res.accepted) {
      const id = idMap.get(cardId)
      if (id !== undefined) done.add(id)
    }
    for (const rej of res.rejected) {
      const id = idMap.get(rej.id)
      if (id !== undefined) done.add(id)
    }
    // 没在 accepted 也没在 rejected = unchanged，也划掉
    for (const e of batch) done.add(e.id)

    db.ackOutbox([...done])
    pushed += res.accepted.length
  }

  return { pushed, conflicts }
}

async function pullAll(): Promise<number> {
  let pulled = 0
  let cursor = db.raw().cursor

  for (let round = 0; round < 100; round += 1) {
    const res = await request<PullResponse>(
      `${API_PATHS.pull}?since=${cursor}&limit=${PULL_PAGE_SIZE}`
    )

    // 先按 LWW 过滤，再一次性落库：逐张 applyServerCard 会 emit N 次，
    // 首同步几百张卡时会把主线程压住（每张都重建快照 + 触发一轮重渲染）。
    const incoming: Card[] = []
    for (const snap of res.changes as CardSnapshot[]) {
      const local = db.cardById(snap.card.id)
      if (local) {
        const newer = isNewer(
          { updatedAt: local.updatedAt, deviceId: db.raw().deviceId },
          { updatedAt: snap.card.updatedAt, deviceId: snap.lastDeviceId }
        )
        if (newer) continue
      }
      incoming.push(snap.card)
    }
    pulled += db.applyServerCards(incoming)

    cursor = res.cursor
    db.setCursor(cursor)
    if (!res.hasMore) break
  }

  return pulled
}

function configured(): boolean {
  const s = db.raw().sync
  return s.enabled && !!s.serverUrl.trim()
}

export async function syncNow(): Promise<SyncReport> {
  if (running) return lastReport ?? { ok: false, pushed: 0, pulled: 0, conflicts: [], error: '正在同步中' }
  if (!configured()) {
    setPhase('idle')
    return { ok: false, pushed: 0, pulled: 0, conflicts: [], error: '同步未启用或没填服务器地址' }
  }

  running = true
  setPhase('syncing')
  let pushed = 0
  let pulled = 0
  const conflicts: RejectedCard[] = []

  try {
    const p = await pushOnce()
    pushed = p.pushed
    conflicts.push(...p.conflicts)
    pulled = await pullAll()
    db.markSynced()
    failures = 0
    clearRetry()
    const r: SyncReport = { ok: true, pushed, pulled, conflicts, error: null }
    lastReport = r
    setPhase('idle')
    return r
  } catch (error) {
    const friendly = describeError(errorText(error))
    const r: SyncReport = { ok: false, pushed, pulled, conflicts, error: friendly }
    lastReport = r
    setPhase(/连不上|网络不通|超时|域名|稍后自动重试/.test(friendly) ? 'offline' : 'error', friendly)
    // 失败后自己排一次退避重试：手机常驻前台时，光靠"回前台"和"改数据"永远等不到重试
    failures += 1
    scheduleRetry()
    return r
  } finally {
    running = false
    emit()
  }
}

/* ============================================================
 * 失败退避重试 + 前台定期拉
 * ========================================================== */

let failures = 0
let retryTimer: ReturnType<typeof setTimeout> | null = null
let pollTimer: ReturnType<typeof setTimeout> | null = null

function clearRetry(): void {
  if (retryTimer) {
    clearTimeout(retryTimer)
    retryTimer = null
  }
}

/** 3s → 6s → 12s → … 封顶 60s（和桌面端同一套口径） */
function scheduleRetry(): void {
  clearRetry()
  const delay = Math.min(3000 * 2 ** Math.min(Math.max(failures - 1, 0), 5), 60_000)
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (configured() && !running) void syncNow()
  }, delay)
}

/**
 * 前台常驻时定期拉一次。
 * 不这样的话，"另一台设备改了卡"要等用户切走再切回来（visibilitychange）才看得到。
 */
export function startSyncLoop(pollMs = 60_000): void {
  if (pollTimer) return
  const tick = (): void => {
    if (document.visibilityState === 'visible' && configured() && !running) {
      const last = db.raw().lastSyncAt ?? 0
      if (Date.now() - last > pollMs) void syncNow()
    }
    pollTimer = setTimeout(tick, pollMs)
  }
  pollTimer = setTimeout(tick, pollMs)
}

/* ============================================================
 * 自动同步
 * ========================================================== */

let debounce: ReturnType<typeof setTimeout> | null = null

export function scheduleSync(): void {
  if (!configured()) return
  if (debounce) clearTimeout(debounce)
  debounce = setTimeout(() => {
    debounce = null
    void syncNow()
  }, 1200)
}

/** App 回到前台 / 启动时调一次 */
export function syncIfStale(maxAgeMs = 60_000): void {
  if (!configured()) return
  const last = db.raw().lastSyncAt ?? 0
  if (Date.now() - last > maxAgeMs) void syncNow()
}
