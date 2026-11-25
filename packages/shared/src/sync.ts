/**
 * 挂卡时间轴 · 同步协议
 *
 * 设计取向：**离线优先 + 操作日志 + 最后写入者胜（LWW）**。
 *
 * 为什么不上 CRDT：个人应用，同一张卡几乎不会两端同时改。
 * 上 CRDT 会让实现复杂度涨十倍，还容易出玄学 bug；
 * 用「时间戳 + 设备 id 字典序」做决胜，已经能覆盖 99.9% 的场景。
 *
 * 三条铁律：
 *  1. 卡片永远软删除（`deletedAt` 非 null），物理删除会让卡在别的设备上复活；
 *  2. 本地先写，再进 `Outbox`，断网照常能挂卡；
 *  3. 拉取靠**游标**（服务端自增 `seq`）增量拉，不整表同步。
 */

import type { Card } from './model.js'

/* ============================================================
 * 变更
 * ========================================================== */

/** 变更类型，方便服务端审计与客户端回放 */
export type ChangeOp = 'create' | 'update' | 'delete' | 'restore'

/** 一次卡片变更 */
export interface CardChange {
  /** 变更后的完整卡片（删除时 `deletedAt` 非 null） */
  card: Card
  /** 发起修改的设备 id */
  deviceId: string
  /** 变更类型 */
  op: ChangeOp
  /** 客户端本地时刻，仅用于排障，不参与决胜 */
  clientAt: number
}

/* ============================================================
 * 推送
 * ========================================================== */

/** `POST /api/sync/push` 请求体 */
export interface PushRequest {
  deviceId: string
  changes: CardChange[]
}

/** 某张卡被服务端拒绝后，回给客户端的最新版本 */
export interface RejectedCard {
  id: string
  /** 服务端当前版本，客户端应直接覆盖本地 */
  serverCard: Card
}

/** `POST /api/sync/push` 响应体 */
export interface PushResponse {
  /** 被接受的卡片 id */
  accepted: string[]
  /** 被拒绝的卡片（服务端更新），客户端应覆盖本地 */
  rejected: RejectedCard[]
  /** 本次推送后服务端的最新游标 */
  cursor: number
  /** 服务端时刻 */
  serverTime: number
}

/* ============================================================
 * 拉取
 * ========================================================== */

/** `GET /api/sync/pull?since=&limit=` */
export interface PullRequest {
  /** 上次拉到的游标；0 = 从头拉 */
  sinceCursor: number
  /** 单次上限，默认 200 */
  limit?: number
}

/** 带游标的卡片快照 */
export interface CardSnapshot {
  /** 服务端自增游标 */
  seq: number
  card: Card
  /** 最后写入的设备 */
  lastDeviceId: string
}

/** `GET /api/sync/pull` 响应体 */
export interface PullResponse {
  changes: CardSnapshot[]
  /** 下次拉取用这个游标 */
  cursor: number
  /** 是否还有更多（客户端应继续拉） */
  hasMore: boolean
  /** 服务端时刻 */
  serverTime: number
}

/* ============================================================
 * 健康检查
 * ========================================================== */

export interface HealthResponse {
  ok: boolean
  serverTime: number
  /** 服务端卡片总数（含软删除） */
  cardCount: number
  /** 服务端版本号 */
  version: string
}

/* ============================================================
 * 本地 Outbox
 * ========================================================== */

/** 本地待推送队列项 */
export interface OutboxEntry {
  /** 本地自增主键 */
  id: number
  /** 卡片 id */
  cardId: string
  /** 变更类型 */
  op: ChangeOp
  /** 变更时的卡片快照 */
  card: Card
  /** 已尝试次数（指数退避用） */
  attempts: number
  /** 入队时刻 */
  enqueuedAt: number
  /** 上次失败原因 */
  lastError: string | null
}

/* ============================================================
 * 客户端同步状态
 * ========================================================== */

export type SyncPhase =
  /** 空闲，一切正常 */
  | 'idle'
  /** 正在同步 */
  | 'syncing'
  /** 离线（没有网络 / 服务器连不上） */
  | 'offline'
  /** 出错（服务器 5xx / 数据校验失败） */
  | 'error'

export interface SyncState {
  phase: SyncPhase
  /** 已拉到的游标 */
  cursor: number
  /** 上次同步成功时刻 */
  lastSyncAt: number | null
  /** 待推送条数 */
  pending: number
  /** 最近一次错误信息 */
  error: string | null
}

/** 初始同步状态 */
export const INITIAL_SYNC_STATE: SyncState = {
  phase: 'idle',
  cursor: 0,
  lastSyncAt: null,
  pending: 0,
  error: null,
}

/* ============================================================
 * 决胜规则
 * ========================================================== */

/** 参与 LWW 决胜的最小信息 */
export interface LwwStamp {
  updatedAt: number
  deviceId: string
}

/**
 * 判断 `incoming` 是否应该覆盖 `current`。
 *
 * 规则：先比 `updatedAt`（毫秒），相同则比 `deviceId` 字典序。
 * 两端算出来的结果**必须一致**，否则会出现「同步震荡」——
 * 所以这里刻意不用 `>=`，同一条记录只可能有一个赢家。
 */
export function isNewer(incoming: LwwStamp, current: LwwStamp): boolean {
  if (incoming.updatedAt !== current.updatedAt) return incoming.updatedAt > current.updatedAt
  return incoming.deviceId > current.deviceId
}

/**
 * 合并两条卡片记录，返回应保留的那条。
 *
 * 客户端本地和服务器都调用这个函数，保证合并逻辑单一来源。
 */
export function mergeCards(
  local: { card: Card; deviceId: string },
  remote: { card: Card; deviceId: string },
): { card: Card; deviceId: string } {
  return isNewer(
    { updatedAt: local.card.updatedAt, deviceId: local.deviceId },
    { updatedAt: remote.card.updatedAt, deviceId: remote.deviceId },
  )
    ? local
    : remote
}

/* ============================================================
 * 接口常量
 * ========================================================== */

export const API_PATHS = {
  health: '/api/health',
  push: '/api/sync/push',
  pull: '/api/sync/pull',
} as const

/** 认证请求头名 */
export const AUTH_HEADER = 'Authorization'
/** 认证方案 */
export const AUTH_SCHEME = 'Bearer'

/** 单次推送最多带多少条（避免请求体过大） */
export const PUSH_BATCH_SIZE = 50
/** 单次拉取默认条数 */
export const PULL_PAGE_SIZE = 200
