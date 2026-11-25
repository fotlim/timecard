/**
 * 同步引擎（跑在主进程）
 *
 * 职责：
 *   1. 把 Outbox 里的变更分批推给服务器
 *   2. 按游标增量拉取，合并到本地
 *   3. 维护同步状态，失败时指数退避
 *
 * 所有网络请求都在这里，渲染层只订阅状态。
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
  CardSnapshot,
  OutboxEntry,
  PullResponse,
  PushResponse,
  RejectedCard,
  SyncPhase,
  SyncState
} from '@timecard/shared'
import { store } from './store'

/** 一次同步的结果，给 UI 提示用 */
export interface SyncReport {
  ok: boolean
  pushed: number
  pulled: number
  /** 被服务器版本覆盖掉的本地卡片数（这就是"冲突"） */
  conflicts: RejectedCard[]
  error: string | null
}

let phase: SyncPhase = 'idle'
let lastError: string | null = null
let lastReport: SyncReport | null = null
let running = false
let timer: NodeJS.Timeout | null = null
let retryTimer: NodeJS.Timeout | null = null
let failures = 0
/** 每次状态变化通知外面（index.ts 负责广播到渲染层） */
let onChange: (() => void) | null = null

export function onSyncStateChange(cb: () => void): void {
  onChange = cb
}

function notify(): void {
  onChange?.()
}

function setPhase(next: SyncPhase, error: string | null = null): void {
  const changed = phase !== next || lastError !== error
  phase = next
  lastError = error
  if (changed) notify()
}

export function state(): SyncState {
  return {
    phase,
    cursor: store.cursor(),
    lastSyncAt: store.lastSyncAt(),
    pending: store.pending(),
    error: lastError
  }
}

export function report(): SyncReport | null {
  return lastReport
}

/* ============================================================
 * HTTP
 * ========================================================== */

function baseUrl(): string {
  return store.sync().serverUrl.replace(/\/+$/, '')
}

function headers(): Record<string, string> {
  const token = store.sync().token
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    // 拉取请求体里没有 deviceId，靠这个头让服务端面板能认出是哪台设备在拉
    'X-Device-Id': store.deviceId()
  }
  if (token) h[AUTH_HEADER] = `${AUTH_SCHEME} ${token}`
  return h
}

/** 带超时的 fetch —— 没超时的话网络半死会一直挂着 */
async function request<T>(path: string, init?: RequestInit, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      ...init,
      headers: { ...headers(), ...(init?.headers ?? {}) },
      signal: controller.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
    }
    return (await res.json()) as T
  } finally {
    clearTimeout(t)
  }
}

/* ============================================================
 * 错误翻译
 * 原始报错（"fetch failed" / "HTTP 401"）对用户毫无意义，翻成人话。
 * ========================================================== */

/**
 * 把错误压成一行可判断的文本。
 *
 * 关键：undici / Electron 的 fetch 抛出来的 message 只有一句 "fetch failed"，
 * 真正的原因（ECONNREFUSED / ENOTFOUND / ETIMEDOUT）藏在 `cause` 里。
 * 不挖出来就没法给用户具体提示。
 */
function errorText(error: unknown): string {
  if (!error) return ''
  const e = error as { message?: string; cause?: { code?: string; message?: string } }
  const parts: string[] = []
  if (e.message) parts.push(e.message)
  if (e.cause?.code) parts.push(e.cause.code)
  if (e.cause?.message) parts.push(e.cause.message)
  return parts.join(' ') || String(error)
}

export function describeError(raw: string): string {
  if (!raw) return '未知错误'
  if (/HTTP 401|unauthorized/i.test(raw)) return '令牌不正确（服务器返回 401）'
  if (/HTTP 403/i.test(raw)) return '服务器拒绝了这次请求（403）'
  if (/HTTP 404/i.test(raw)) return '服务器地址不对 —— 找不到 /api/sync 接口'
  if (/HTTP 5\d\d/i.test(raw)) return '服务器内部出错了，稍后自动重试'
  if (/ECONNREFUSED/i.test(raw)) return '连不上服务器 —— 端口没开或地址不对'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(raw)) return '找不到这个域名'
  if (/ETIMEDOUT|abort/i.test(raw)) return '连接超时 —— 服务器没响应'
  if (/CERT|self-signed|certificate/i.test(raw)) return 'HTTPS 证书有问题（自签证书需要信任）'
  if (/fetch failed/i.test(raw)) return '连不上服务器 —— 检查地址、端口和网络'
  if (/payload_too_large/i.test(raw)) return '本地有超大卡片，服务器不接受'
  return raw
}

/* ============================================================
 * 连接测试
 * ========================================================== */

export interface ConnectionTest {
  ok: boolean
  /** 成功时的服务器信息 */
  version?: string
  cardCount?: number
  /** 失败原因（已翻译成人话） */
  message?: string
  /** 往返耗时（毫秒） */
  ms?: number
}

/**
 * 只打一次健康检查，不动数据。
 * 让用户在「保存」之前就知道地址和令牌对不对，而不是等一次失败的同步。
 */
export async function testConnection(
  serverUrl: string,
  token: string
): Promise<ConnectionTest> {
  const base = serverUrl.trim().replace(/\/+$/, '')
  if (!base) return { ok: false, message: '还没填服务器地址' }
  if (!/^https?:\/\//i.test(base)) {
    return { ok: false, message: '地址要以 http:// 或 https:// 开头' }
  }

  const started = Date.now()
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), 10000)
  try {
    const res = await fetch(`${base}${API_PATHS.health}`, {
      headers: token ? { [AUTH_HEADER]: `${AUTH_SCHEME} ${token}` } : {},
      signal: controller.signal
    })
    const ms = Date.now() - started
    if (!res.ok) {
      return { ok: false, message: describeError(`HTTP ${res.status}`), ms }
    }
    const body = (await res.json()) as { ok?: boolean; version?: string; cardCount?: number }
    if (!body.ok) return { ok: false, message: '服务器回应异常', ms }
    return { ok: true, version: body.version, cardCount: body.cardCount, ms }
  } catch (error) {
    const ms = Date.now() - started
    return { ok: false, message: describeError(errorText(error)), ms }
  } finally {
    clearTimeout(t)
  }
}

/* ============================================================
 * 推送
 * ========================================================== */

async function pushOnce(): Promise<{ pushed: number; conflicts: RejectedCard[] }> {
  const deviceId = store.deviceId()
  let pushed = 0
  const conflicts: RejectedCard[] = []

  // 一批一批推，直到 Outbox 清空。
  // 加个 20 圈的止损，避免服务端一直不接受导致死循环。
  for (let round = 0; round < 20; round += 1) {
    const batch: OutboxEntry[] = store.takeOutbox(PUSH_BATCH_SIZE)
    if (batch.length === 0) break

    const body = {
      deviceId,
      changes: batch.map((e) => ({
        card: e.card,
        deviceId,
        op: e.op,
        clientAt: e.enqueuedAt
      }))
    }

    let res: PushResponse
    try {
      res = await request<PushResponse>(API_PATHS.push, {
        method: 'POST',
        body: JSON.stringify(body)
      })
    } catch (error) {
      // 整批失败：记账但留在队列里，下次再试
      store.markOutboxFailure(batch.map((e) => e.id), errorText(error))
      throw error
    }

    const batchIds = batch.map((e) => e.id)

    // 被拒绝的：服务端版本更新，直接覆盖本地，并从队列移走
    for (const rej of res.rejected) {
      store.applyServerCard(rej.serverCard)
      conflicts.push(rej)
    }

    // accepted 和 unchanged 都算处理完了
    const done: Number[] = []
    const idMap = new Map(batch.map((e) => [e.cardId, e.id]))
    for (const cardId of res.accepted) {
      const id = idMap.get(cardId)
      if (id !== undefined) done.push(id)
    }
    for (const rej of res.rejected) {
      const id = idMap.get(rej.id)
      if (id !== undefined) done.push(id)
    }

    // 剩下的（既没 in accepted 也没 in rejected）= unchanged，也移走
    const handled = new Set(done.map(Number))
    for (const id of batchIds) {
      if (!handled.has(id)) done.push(id)
    }

    store.ackOutbox(done.map(Number))
    pushed += res.accepted.length
  }

  return { pushed, conflicts }
}

/* ============================================================
 * 拉取
 * ========================================================== */

async function pullAll(): Promise<number> {
  let pulled = 0
  let cursor = store.cursor()

  for (let round = 0; round < 100; round += 1) {
    const res = await request<PullResponse>(
      `${API_PATHS.pull}?since=${cursor}&limit=${PULL_PAGE_SIZE}`
    )

    for (const snap of res.changes as CardSnapshot[]) {
      const local = store.cardById(snap.card.id)
      // 本地比服务端新就先留着 —— 那条本地变更还在 Outbox，推上去会赢回来
      if (local) {
        const newer = isNewer(
          { updatedAt: local.updatedAt, deviceId: store.deviceId() },
          { updatedAt: snap.card.updatedAt, deviceId: snap.lastDeviceId }
        )
        if (newer) continue
      }
      if (store.applyServerCard(snap.card)) pulled += 1
    }

    cursor = res.cursor
    store.setCursor(cursor)
    if (!res.hasMore) break
  }

  return pulled
}

/* ============================================================
 * 一次完整同步
 * ========================================================== */

function configured(): boolean {
  const s = store.sync()
  return s.enabled && !!s.serverUrl.trim()
}

export async function syncNow(): Promise<SyncReport> {
  if (running) {
    return (
      lastReport ?? { ok: false, pushed: 0, pulled: 0, conflicts: [], error: '正在同步中' }
    )
  }
  if (!configured()) {
    const r: SyncReport = {
      ok: false, pushed: 0, pulled: 0, conflicts: [],
      error: '同步未启用或没填服务器地址'
    }
    setPhase('idle')
    return r
  }

  running = true
  setPhase('syncing')
  const conflicts: RejectedCard[] = []
  let pushed = 0
  let pulled = 0

  try {
    const p = await pushOnce()
    pushed = p.pushed
    conflicts.push(...p.conflicts)

    pulled = await pullAll()

    store.markSynced()
    failures = 0
    const r: SyncReport = { ok: true, pushed, pulled, conflicts, error: null }
    lastReport = r
    setPhase('idle')
    return r
  } catch (error) {
    const message = errorText(error)
    failures += 1
    const r: SyncReport = { ok: false, pushed, pulled, conflicts, error: describeError(message) }
    lastReport = r
    // 连不上就标 offline，别吓用户；其它错误算 error
    const friendly = describeError(message)
    // 连不上 / 超时算 offline（不是我们的错）；其余算 error
    setPhase(/连不上|网络不通|连接超时|找不到这个域名|稍后自动重试/i.test(friendly) ? 'offline' : 'error', friendly)

    // 失败后自己安排重试。光靠 60 秒轮询的话，服务器恢复后要等一分钟才有反应，
    // 表现为「网都回来了它还挂着离线」。
    scheduleRetry()
    return r
  } finally {
    running = false
    notify()
  }
}

/* ============================================================
 * 自动同步：变更后延迟触发 + 指数退避重试
 * ========================================================== */

const MIN_INTERVAL_MS = 60_000
const DEBOUNCE_MS = 1200

/** 本地一有改动就叫一下，防抖后自动推 */
export function scheduleAutoSync(): void {
  if (!configured()) return
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    void syncNow()
  }, DEBOUNCE_MS)
}

/** 起一个兜底轮询：没改动也要定期拉一下，好让另一台设备的改动过来 */
export function startPolling(): void {
  const tick = async (): Promise<void> => {
    if (configured() && !running) {
      const since = store.lastSyncAt() ?? 0
      if (Date.now() - since > MIN_INTERVAL_MS) await syncNow()
    }
    const delay = Math.min(MIN_INTERVAL_MS * Math.max(1, failures + 1), 10 * MIN_INTERVAL_MS)
    setTimeout(() => void tick(), delay)
  }

  // 启动就先来一次：等 60 秒才第一次同步的话，
  // 用户刚打开应用会觉得"另一台设备的改动怎么没过来"。
  setTimeout(() => {
    if (configured()) void syncNow()
  }, 2000)

  setTimeout(() => void tick(), MIN_INTERVAL_MS)
}

/** 失败重试：3s → 6s → 12s → … 封顶 60s */
function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer)
  const delay = Math.min(3000 * 2 ** Math.min(failures - 1, 5), 60_000)
  retryTimer = setTimeout(() => {
    retryTimer = null
    if (configured() && !running) void syncNow()
  }, delay)
}

export function stopSync(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (retryTimer) clearTimeout(retryTimer)
  retryTimer = null
}
