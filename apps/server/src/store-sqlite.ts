/**
 * SQLite 实现（自己的 VPS / 本地开发）
 *
 * 用 Node 24 内置的 `node:sqlite`，不需要 better-sqlite3 那种原生模块，
 * 装包不会因为编译环境炸掉。
 */

import { DatabaseSync } from 'node:sqlite'
import type { StatementSync } from 'node:sqlite'
import type { CardChange } from '@timecard/shared'
import {
  SCHEMA,
  SQL_COUNT,
  SQL_GET,
  SQL_LIST_SINCE,
  SQL_MAX_SEQ,
  SQL_NEXT_SEQ,
  SQL_STATS,
  SQL_UPSERT,
  buildCountCardsSql,
  buildListCardsSql,
  rowToCardRow,
  rowToStoreStats,
  shouldAccept
} from './store.js'
import type {
  ApplyResult,
  CardRow,
  ListCardsOptions,
  ListCardsResult,
  StoreStats,
  SyncStore
} from './store.js'

interface RawRow {
  card_json: string
  updated_at: number
  last_device_id: string
  seq: number
}

export class SqliteStore implements SyncStore {
  private readonly db: DatabaseSync
  // 注意：这些只能在 init() 建完表之后再 prepare，
  // 否则在空库上 prepare 会直接抛 "no such table"。
  private qGet!: StatementSync
  private qCount!: StatementSync
  private qMaxSeq!: StatementSync
  private qList!: StatementSync
  private qNextSeq!: StatementSync
  private qUpsert!: StatementSync
  private qStats!: StatementSync

  constructor(path: string) {
    this.db = new DatabaseSync(path)
    // WAL 让读不挡写；busy_timeout 防止并发时直接抛 SQLITE_BUSY
    this.db.exec('PRAGMA journal_mode = WAL')
    // WAL 下 synchronous=NORMAL 已经足够安全（断电最多丢最后一个事务），
    // 但写入吞吐比默认 FULL 高一大截 —— 对这种高频小写入的服务很值。
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
  }

  async init(): Promise<void> {
    for (const sql of SCHEMA) this.db.exec(sql)

    this.qGet = this.db.prepare(SQL_GET)
    this.qCount = this.db.prepare(SQL_COUNT)
    this.qMaxSeq = this.db.prepare(SQL_MAX_SEQ)
    this.qList = this.db.prepare(SQL_LIST_SINCE)
    this.qNextSeq = this.db.prepare(SQL_NEXT_SEQ)
    this.qUpsert = this.db.prepare(SQL_UPSERT)
    this.qStats = this.db.prepare(SQL_STATS)
  }

  async count(): Promise<number> {
    const row = this.qCount.get() as { n: number } | undefined
    return row?.n ?? 0
  }

  async maxSeq(): Promise<number> {
    const row = this.qMaxSeq.get() as { s: number } | undefined
    return row?.s ?? 0
  }

  async listSince(since: number, limit: number): Promise<CardRow[]> {
    const rows = this.qList.all(since, limit) as unknown as RawRow[]
    return rows.map(rowToCardRow)
  }

  async stats(): Promise<StoreStats> {
    const row = this.qStats.get() as
      | { total: number; open: number; done: number; archived: number; deleted: number; max_seq: number }
      | undefined
    if (!row) {
      return { total: 0, open: 0, done: 0, archived: 0, deleted: 0, maxSeq: 0 }
    }
    return rowToStoreStats(row)
  }

  async listCards(options: ListCardsOptions): Promise<ListCardsResult> {
    const list = buildListCardsSql(options)
    const count = buildCountCardsSql(options)
    // 动态 SQL 每次现 prepare（面板低频调用，开销可忽略），
    // 这样不用为「状态 × 搜索」的组合预先缓存一大堆语句。
    const rows = this.db.prepare(list.sql).all(...list.params) as unknown as RawRow[]
    const totalRow = this.db.prepare(count.sql).get(...count.params) as { n: number } | undefined
    return { rows: rows.map(rowToCardRow), total: totalRow?.n ?? 0 }
  }

  async getCard(id: string): Promise<CardRow | null> {
    const row = this.qGet.get(id) as RawRow | undefined
    return row ? rowToCardRow(row) : null
  }

  async apply(change: CardChange): Promise<ApplyResult> {
    // node:sqlite 没有内置的 transaction 包装，手工 BEGIN/COMMIT。
    // 用 IMMEDIATE 直接拿写锁，避免「读到旧值 → 写时已被别人改」的窗口。
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const currentRaw = this.qGet.get(change.card.id) as RawRow | undefined
      const current = currentRaw ? rowToCardRow(currentRaw) : null

      const decision = shouldAccept({ card: change.card, deviceId: change.deviceId }, current)
      if (!decision.accept) {
        this.db.exec('COMMIT')
        const outcome = decision.reason === 'same-stamp' ? 'unchanged' : 'rejected'
        return { outcome, serverCard: current?.card, seq: current?.seq ?? 0 }
      }

      const seqRow = this.qNextSeq.get() as { v: number } | undefined
      const seq = seqRow?.v ?? 0

      const res = this.qUpsert.run(
        change.card.id,
        JSON.stringify(change.card),
        change.card.updatedAt,
        change.deviceId,
        seq
      )

      if (res.changes === 0) {
        // 理论上在 IMMEDIATE 事务里不会走到，留个兜底
        this.db.exec('COMMIT')
        const again = this.qGet.get(change.card.id) as RawRow | undefined
        const row = again ? rowToCardRow(again) : null
        return { outcome: 'rejected', serverCard: row?.card, seq: row?.seq ?? 0 }
      }

      this.db.exec('COMMIT')
      return { outcome: 'accepted', seq }
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** 整理数据库：更新统计信息后重建主文件，回收墓碑占的空间 */
  async optimize(): Promise<void> {
    this.db.exec('PRAGMA optimize')
    this.db.exec('VACUUM')
  }

  close(): void {
    this.db.close()
  }
}
