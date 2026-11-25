/**
 * 挂卡时间轴 · 服务端存储抽象
 *
 * 几个运行时要共用同一套「这单要不要收」的判断，
 * 所以决胜逻辑只写在这里，具体存储（SQLite / D1）只管读写字。
 */

import { isNewer } from '@timecard/shared'
import type { Card, CardChange } from '@timecard/shared'

/** 服务端存的一条卡片记录 */
export interface CardRow {
  /** 全局自增游标，单调递增；拉取靠它做增量 */
  seq: number
  card: Card
  /** 最后写入的设备 id，参与 LWW 决胜 */
  lastDeviceId: string
  /** 冗余一份时间戳，方便索引与排障 */
  updatedAt: number
}

/**
 * 单条推送的落库结果。
 *
 * 刻意分成三态而不是两态：
 *  - accepted  接受了，客户端把这条从 Outbox 划掉
 *  - rejected  服务端更新，客户端应覆盖本地
 *  - unchanged 完全相同的重复推送（时间戳和设备都一样），当没发生
 *
 * 如果只有两态，幂等重推就会被报成"冲突"，客户端白跑一次覆盖，
 * 还容易在日志里制造假的同步异常。
 */
export type ApplyOutcome = 'accepted' | 'rejected' | 'unchanged'

export interface ApplyResult {
  outcome: ApplyOutcome
  /** 被拒绝时，服务端当前的版本（客户端应当覆盖本地） */
  serverCard?: Card
  /** 该记录当前的游标（接受就是新游标，拒绝就是旧游标） */
  seq: number
}

/** 面板用的聚合统计（一次 SQL 算出来，别让面板自己扫全表） */
export interface StoreStats {
  /** 总行数（含软删除墓碑） */
  total: number
  /** 进行中（未删除） */
  open: number
  /** 已完成（未删除） */
  done: number
  /** 已归档（未删除） */
  archived: number
  /** 软删除墓碑数 */
  deleted: number
  /** 当前最大游标 */
  maxSeq: number
}

/** 卡片浏览的状态筛选 */
export type CardFilterStatus = 'all' | 'open' | 'done' | 'archived' | 'deleted'

export interface ListCardsOptions {
  status: CardFilterStatus
  /** 标题模糊搜索；空串 = 不过滤 */
  q: string
  limit: number
  offset: number
}

export interface ListCardsResult {
  rows: CardRow[]
  /** 满足过滤条件的总数（用于分页） */
  total: number
}

/** 存储适配器。两个运行时各实现一份。 */
export interface SyncStore {
  /** 建表 / 迁移，幂等 */
  init(): Promise<void>
  /** 卡片总数（含软删除） */
  count(): Promise<number>
  /** 当前最大游标（空库为 0） */
  maxSeq(): Promise<number>
  /** 拉取 seq > since 的记录，按 seq 升序 */
  listSince(since: number, limit: number): Promise<CardRow[]>
  /** 落一条变更，内部完成 LWW 比较 + 游标分配 */
  apply(change: CardChange): Promise<ApplyResult>

  /* ---- 管理面板用的只读查询 ---- */
  /** 聚合统计 */
  stats(): Promise<StoreStats>
  /** 后台卡片浏览（状态过滤 / 标题搜索 / 分页），按更新时间倒序 */
  listCards(options: ListCardsOptions): Promise<ListCardsResult>
  /** 取单张（含软删除），找不到返回 null */
  getCard(id: string): Promise<CardRow | null>

  /* ---- 可选维护动作（D1 不提供） ---- */
  /** 整理数据库：SQLite 下做 PRAGMA optimize + VACUUM */
  optimize?(): Promise<void>
}

/* ============================================================
 * 决胜判断（纯函数，单测覆盖）
 * ========================================================== */

export interface LwwDecision {
  accept: boolean
  reason: 'no-current' | 'newer' | 'stale' | 'same-stamp'
}

/**
 * 服务端要不要接受这条变更。
 *
 * `isNewer` 和客户端用的是**同一个函数**，保证两端算出一致结果 ——
 * 否则会出现「我推上去你退回来」的同步震荡。
 */
export function shouldAccept(
  incoming: { card: Card; deviceId: string },
  current: CardRow | null
): LwwDecision {
  if (!current) return { accept: true, reason: 'no-current' }

  const a = { updatedAt: incoming.card.updatedAt, deviceId: incoming.deviceId }
  const b = { updatedAt: current.updatedAt, deviceId: current.lastDeviceId }

  if (isNewer(a, b)) return { accept: true, reason: 'newer' }
  // 时间戳和设备都一样 = 同一条东西又推了一遍，直接忽略，别当成冲突
  if (a.updatedAt === b.updatedAt && a.deviceId === b.deviceId) {
    return { accept: false, reason: 'same-stamp' }
  }
  return { accept: false, reason: 'stale' }
}

/* ============================================================
 * 共用的 SQL（SQLite 与 D1 都吃这一套）
 * ========================================================== */

export const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS meta (
     k TEXT PRIMARY KEY,
     v INTEGER NOT NULL
   )`,
  `INSERT OR IGNORE INTO meta (k, v) VALUES ('seq', 0)`,
  `CREATE TABLE IF NOT EXISTS cards (
     id            TEXT PRIMARY KEY,
     card_json     TEXT NOT NULL,
     updated_at    INTEGER NOT NULL,
     last_device_id TEXT NOT NULL,
     seq           INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_cards_seq ON cards (seq)`,
  `CREATE INDEX IF NOT EXISTS idx_cards_updated ON cards (updated_at)`
] as const

/**
 * 分配下一个游标。
 * 用 UPDATE ... RETURNING 是原子的 —— 两个人同时推也拿不到同一个号。
 */
export const SQL_NEXT_SEQ = `UPDATE meta SET v = v + 1 WHERE k = 'seq' RETURNING v`

/**
 * Upsert + LWW 合并在一条语句里完成。
 *
 * `ON CONFLICT ... DO UPDATE ... WHERE <条件>` 的 WHERE 不成立时整条不生效，
 * 受影响行数为 0 —— 这就是「被拒绝」，不需要先读后写，天然原子。
 */
export const SQL_UPSERT = `
INSERT INTO cards (id, card_json, updated_at, last_device_id, seq)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT(id) DO UPDATE SET
  card_json      = excluded.card_json,
  updated_at     = excluded.updated_at,
  last_device_id = excluded.last_device_id,
  seq            = excluded.seq
WHERE
  excluded.updated_at > cards.updated_at
  OR (excluded.updated_at = cards.updated_at AND excluded.last_device_id > cards.last_device_id)
`

export const SQL_GET = `SELECT id, card_json, updated_at, last_device_id, seq FROM cards WHERE id = ?`
export const SQL_COUNT = `SELECT COUNT(*) AS n FROM cards`
export const SQL_MAX_SEQ = `SELECT COALESCE(MAX(seq), 0) AS s FROM cards`
export const SQL_LIST_SINCE = `
SELECT id, card_json, updated_at, last_device_id, seq
FROM cards WHERE seq > ? ORDER BY seq ASC LIMIT ?
`

/**
 * 聚合统计。用 json_extract 在 SQL 里一次算完，避免把整表读进内存。
 * total 含墓碑；open/done/archived 只数未删除的；deleted 数墓碑。
 */
export const SQL_STATS = `
SELECT
  COUNT(*) AS total,
  COALESCE(SUM(CASE WHEN json_extract(card_json, '$.deletedAt') IS NOT NULL THEN 1 ELSE 0 END), 0) AS deleted,
  COALESCE(SUM(CASE WHEN json_extract(card_json, '$.deletedAt') IS NULL
                     AND json_extract(card_json, '$.status') = 'open' THEN 1 ELSE 0 END), 0) AS open,
  COALESCE(SUM(CASE WHEN json_extract(card_json, '$.deletedAt') IS NULL
                     AND json_extract(card_json, '$.status') = 'done' THEN 1 ELSE 0 END), 0) AS done,
  COALESCE(SUM(CASE WHEN json_extract(card_json, '$.deletedAt') IS NULL
                     AND json_extract(card_json, '$.status') = 'archived' THEN 1 ELSE 0 END), 0) AS archived,
  COALESCE(MAX(seq), 0) AS max_seq
FROM cards
`

/** 卡片浏览的 WHERE 子句构造（参数化，防注入；两端共用） */
function cardFilterWhere(status: CardFilterStatus, q: string): { where: string; params: string[] } {
  const clauses: string[] = []
  const params: string[] = []

  if (status === 'deleted') {
    clauses.push(`json_extract(card_json, '$.deletedAt') IS NOT NULL`)
  } else if (status !== 'all') {
    clauses.push(`json_extract(card_json, '$.deletedAt') IS NULL`)
    clauses.push(`json_extract(card_json, '$.status') = ?`)
    params.push(status)
  }

  const query = q.trim()
  if (query) {
    clauses.push(`instr(lower(json_extract(card_json, '$.title')), lower(?)) > 0`)
    params.push(query)
  }

  return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params }
}

export function buildListCardsSql(options: ListCardsOptions): {
  sql: string
  params: Array<string | number>
} {
  const { where, params } = cardFilterWhere(options.status, options.q)
  return {
    sql: `SELECT id, card_json, updated_at, last_device_id, seq FROM cards ${where} ORDER BY updated_at DESC, seq DESC LIMIT ? OFFSET ?`,
    params: [...params, options.limit, options.offset]
  }
}

export function buildCountCardsSql(options: ListCardsOptions): {
  sql: string
  params: string[]
} {
  const { where, params } = cardFilterWhere(options.status, options.q)
  return { sql: `SELECT COUNT(*) AS n FROM cards ${where}`, params }
}

/** 把数据库行转成 CardRow */
export function rowToCardRow(row: {
  card_json: string
  updated_at: number
  last_device_id: string
  seq: number
}): CardRow {
  return {
    seq: row.seq,
    card: JSON.parse(row.card_json) as Card,
    lastDeviceId: row.last_device_id,
    updatedAt: row.updated_at
  }
}

/** 把聚合查询的行转成 StoreStats */
export function rowToStoreStats(row: {
  total: number
  open: number
  done: number
  archived: number
  deleted: number
  max_seq: number
}): StoreStats {
  return {
    total: row.total ?? 0,
    open: row.open ?? 0,
    done: row.done ?? 0,
    archived: row.archived ?? 0,
    deleted: row.deleted ?? 0,
    maxSeq: row.max_seq ?? 0
  }
}
