/**
 * D1 实现（Cloudflare Workers）
 *
 * D1 的 Worker API 不支持交互式事务，所以这里完全靠
 * 「一条 upsert 语句内完成 LWW 判断」来保证原子性 —— 见 store.ts 的 SQL_UPSERT。
 */

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

export class D1Store implements SyncStore {
  constructor(private readonly db: D1Database) {}

  async init(): Promise<void> {
    for (const sql of SCHEMA) {
      await this.db.exec(sql.replace(/\s+/g, ' ').trim())
    }
  }

  async count(): Promise<number> {
    const row = await this.db.prepare(SQL_COUNT).first<{ n: number }>()
    return row?.n ?? 0
  }

  async maxSeq(): Promise<number> {
    const row = await this.db.prepare(SQL_MAX_SEQ).first<{ s: number }>()
    return row?.s ?? 0
  }

  async listSince(since: number, limit: number): Promise<CardRow[]> {
    const res = await this.db.prepare(SQL_LIST_SINCE).bind(since, limit).all<RawRow>()
    return (res.results ?? []).map(rowToCardRow)
  }

  async stats(): Promise<StoreStats> {
    const row = await this.db.prepare(SQL_STATS).first<{
      total: number
      open: number
      done: number
      archived: number
      deleted: number
      max_seq: number
    }>()
    if (!row) return { total: 0, open: 0, done: 0, archived: 0, deleted: 0, maxSeq: 0 }
    return rowToStoreStats(row)
  }

  async listCards(options: ListCardsOptions): Promise<ListCardsResult> {
    const list = buildListCardsSql(options)
    const count = buildCountCardsSql(options)
    const rowsRes = await this.db.prepare(list.sql).bind(...list.params).all<RawRow>()
    const totalRow = await this.db.prepare(count.sql).bind(...count.params).first<{ n: number }>()
    return { rows: (rowsRes.results ?? []).map(rowToCardRow), total: totalRow?.n ?? 0 }
  }

  async getCard(id: string): Promise<CardRow | null> {
    const row = await this.db.prepare(SQL_GET).bind(id).first<RawRow>()
    return row ? rowToCardRow(row) : null
  }

  async apply(change: CardChange): Promise<ApplyResult> {
    // 先读当前版本，只为了在「被拒绝」时能把服务端版本回给客户端
    const currentRaw = await this.db.prepare(SQL_GET).bind(change.card.id).first<RawRow>()
    const current = currentRaw ? rowToCardRow(currentRaw) : null

    const decision = shouldAccept({ card: change.card, deviceId: change.deviceId }, current)
    if (!decision.accept) {
      const outcome = decision.reason === 'same-stamp' ? 'unchanged' : 'rejected'
      return { outcome, serverCard: current?.card, seq: current?.seq ?? 0 }
    }

    // 接受：分配游标再 upsert。游标分配可能因为并发有空洞，无所谓 —— 游标只是水位线。
    const seqRow = await this.db.prepare(SQL_NEXT_SEQ).first<{ v: number }>()
    const seq = seqRow?.v ?? (await this.maxSeq()) + 1

    const res = await this.db
      .prepare(SQL_UPSERT)
      .bind(
        change.card.id,
        JSON.stringify(change.card),
        change.card.updatedAt,
        change.deviceId,
        seq
      )
      .run()

    // changes === 0 说明在「读」和「写」之间有人抢先写了更新的版本
    if (!res.meta || res.meta.changes === 0) {
      const againRaw = await this.db.prepare(SQL_GET).bind(change.card.id).first<RawRow>()
      const again = againRaw ? rowToCardRow(againRaw) : null
      return { outcome: 'rejected', serverCard: again?.card, seq: again?.seq ?? 0 }
    }

    return { outcome: 'accepted', seq }
  }
}

/** Cloudflare 绑定 */
export interface Env {
  DB: D1Database
  TIMECARD_TOKEN?: string
}
