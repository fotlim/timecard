/**
 * 移动端数据层
 *
 * 和桌面端同一套模型（Card / updatedAt / deletedAt / rev），
 * 只是把「主进程 + JSON 文件」换成了「浏览器 + localStorage」。
 * 同步协议完全一致：Outbox + 游标 + LWW。
 */

import { createCard, createCardItem } from '@timecard/shared'
import type { Card, ChangeOp, OutboxEntry, Skin } from '@timecard/shared'

const KEY = 'timecard.mobile.v1'

export interface SyncSettings {
  enabled: boolean
  serverUrl: string
  token: string
}

export interface Persisted {
  skin: Skin
  cards: Card[]
  deviceId: string
  cursor: number
  lastSyncAt: number | null
  sync: SyncSettings
  outbox: OutboxEntry[]
  outboxSeq: number
}

const DEFAULT_SYNC: SyncSettings = { enabled: false, serverUrl: '', token: '' }

function newDeviceId(): string {
  // crypto.randomUUID 在 WebView 里可用；没有就退回手搓
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `m-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** 首次启动的演示数据：和桌面端一致的几张示例卡 */
function seedCards(): Card[] {
  const now = Date.now()
  const day = (offset: number, hour: number): number => {
    const d = new Date(now)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() + offset)
    return d.getTime() + hour * 3600_000
  }
  return [
    createCard(
      {
        title: '交水电费',
        tag: '交费 / BILLS',
        color: '#b3613a',
        anchorAt: day(-1, 9),
        items: [createCardItem('抄电表读数'), createCardItem('App 里缴费')]
      },
      now
    ),
    createCard(
      {
        title: '买菜清单',
        tag: '家庭 / HOME',
        color: '#71805a',
        anchorAt: day(0, 9),
        items: [createCardItem('鸡蛋 ×10'), createCardItem('青菜 两把'), createCardItem('米 5kg')]
      },
      now
    ),
    createCard(
      {
        title: '装修这个事',
        tag: '工作 / WORK',
        color: '#8c7440',
        anchorAt: day(0, 14),
        items: [createCardItem('买灯具'), createCardItem('施工对接')]
      },
      now
    )
  ]
}

function blank(): Persisted {
  return {
    skin: 'organic',
    cards: [],
    deviceId: newDeviceId(),
    cursor: 0,
    lastSyncAt: null,
    sync: { ...DEFAULT_SYNC },
    outbox: [],
    outboxSeq: 0
  }
}

function normalize(p: Partial<Persisted>): Persisted {
  return {
    ...blank(),
    ...p,
    sync: { ...DEFAULT_SYNC, ...(p.sync ?? {}) },
    cards: Array.isArray(p.cards) ? p.cards : [],
    outbox: Array.isArray(p.outbox) ? p.outbox : [],
    deviceId: p.deviceId || newDeviceId()
  }
}

/**
 * 读本地库。
 *
 * 铁律：**解析失败绝不用演示数据覆盖**。
 * 先把原始字符串另存到 `timecard.mobile.v1.corrupt-<ts>`，本次从空库开始，
 * 并把提示挂到 notice 上（界面上必须看得见）。
 * 万一连备份都写不进去（配额已满之类），整个会话都不落盘——否则下一次 save
 * 就把仅存的那点原始数据冲掉了。
 */
function load(): Persisted {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    raw = null
  }

  if (raw) {
    try {
      return normalize(JSON.parse(raw) as Partial<Persisted>)
    } catch {
      const backupKey = `${KEY}.corrupt-${Date.now()}`
      let backedUp = false
      try {
        localStorage.setItem(backupKey, raw)
        backedUp = true
      } catch {
        backedUp = false
      }
      if (!backedUp) saveBlocked = true
      notice = {
        kind: 'corrupt',
        message: backedUp
          ? `本地数据读不出来，已原样备份到 ${backupKey}，这次从空库开始（没有灌演示数据）。`
          : '本地数据读不出来，备份也写不进去，所以这一次的改动不会保存。'
      }
      return blank()
    }
  }

  // 第一次打开：灌演示数据
  const fresh = blank()
  fresh.cards = seedCards()
  return fresh
}

/* ============================================================
 * 单例
 * ========================================================== */

export interface Notice {
  kind: 'corrupt'
  message: string
}

/** 启动时的异常提示（目前只有「本地库损坏」），给界面用 */
let notice: Notice | null = null
/** 连备份都写不进去时，整个会话都不落盘 */
let saveBlocked = false
/** 本地变更序号：每次写卡 +1，用来触发同步排程（outbox 合并后长度可能不变） */
let changeSeq = 0

let data: Persisted = load()
const listeners = new Set<() => void>()
let snapshot = makeSnapshot()

export interface State {
  skin: Skin
  cards: Card[]
  sync: SyncSettings
  cursor: number
  lastSyncAt: number | null
  pending: number
  deviceId: string
  /** 本地变更序号：每次写卡 +1，同步排程看它 */
  changeSeq: number
  notice: Notice | null
}

function makeSnapshot(): State {
  return {
    skin: data.skin,
    cards: data.cards,
    sync: { ...data.sync },
    cursor: data.cursor,
    lastSyncAt: data.lastSyncAt,
    pending: data.outbox.length,
    deviceId: data.deviceId,
    changeSeq,
    notice
  }
}

function emit(): void {
  snapshot = makeSnapshot()
  save()
  listeners.forEach((fn) => fn())
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

function writeNow(): void {
  if (saveBlocked) return
  try {
    localStorage.setItem(KEY, JSON.stringify(data))
  } catch (e) {
    console.error('[store] 保存失败', e)
  }
}

function save(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    writeNow()
  }, 120)
}

/**
 * 立刻落盘，不等 120ms 防抖。
 *
 * 切后台 / 页面卸载时调用：否则最后一次改动会卡在定时器里，进程被系统回收就丢了。
 */
export function flush(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  writeNow()
}

export function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getSnapshot(): State {
  return snapshot
}

/* ============================================================
 * 读
 * ========================================================== */

export function raw(): Persisted {
  return data
}

export function cardById(id: string): Card | null {
  return data.cards.find((c) => c.id === id) ?? null
}

export function takeOutbox(limit: number): OutboxEntry[] {
  return data.outbox.slice(0, limit)
}

/* ============================================================
 * 写：本地 + 入队
 * ========================================================== */

function opFor(next: Card, prev: Card | null): ChangeOp {
  if (!prev) return 'create'
  if (next.deletedAt !== null && prev.deletedAt === null) return 'delete'
  if (next.deletedAt === null && prev.deletedAt !== null) return 'restore'
  return 'update'
}

/**
 * 入队：同一张卡在队列里**只保留一条最新快照**。
 *
 * 之前每次勾选/改字都 append 一条完整卡快照，离线久了队列能涨到几千条、
 * 把 localStorage 撑爆；服务端本来就是按 updatedAt 决胜，压成一条完全等价。
 * id 沿用最早那条，保证推送顺序稳定。
 */
function enqueue(card: Card, op: ChangeOp): void {
  const kept = data.outbox.find((e) => e.cardId === card.id)
  if (kept) {
    const merged: OutboxEntry = {
      ...kept,
      // 第一次就是 create 的，合并时别降级成 update
      op: kept.op === 'create' ? 'create' : op,
      card: { ...card }
    }
    data.outbox = data.outbox.map((e) => (e.cardId === card.id ? merged : e))
    return
  }
  data.outboxSeq += 1
  data.outbox = [
    ...data.outbox,
    {
      id: data.outboxSeq,
      cardId: card.id,
      op,
      card: { ...card },
      attempts: 0,
      enqueuedAt: Date.now(),
      lastError: null
    }
  ]
}

function putCard(next: Card, op: ChangeOp): void {
  const exists = data.cards.some((c) => c.id === next.id)
  data = {
    ...data,
    cards: exists ? data.cards.map((c) => (c.id === next.id ? next : c)) : [...data.cards, next]
  }
  // 没开同步就不攒队列：关着同步也一直入队，队列只进不出（永远没人 ack）
  if (data.sync.enabled) enqueue(next, op)
  changeSeq += 1
  emit()
}

export function setSkin(skin: Skin): void {
  data = { ...data, skin }
  emit()
}

export function toggleItem(cardId: string, itemId: string): void {
  const prev = cardById(cardId)
  if (!prev) return
  const items = prev.items.map((i) => (i.id === itemId ? { ...i, done: !i.done } : i))
  const allDone = items.length > 0 && items.every((i) => i.done)
  const status: Card['status'] =
    prev.status === 'archived' ? 'archived' : allDone ? 'done' : 'open'
  const next: Card = { ...prev, items, status, updatedAt: Date.now(), rev: prev.rev + 1 }
  putCard(next, opFor(next, prev))
}

export function addCard(input: { title: string; anchorAt: number; tag?: string }): void {
  const title = input.title.trim()
  if (!title) return
  const card = createCard({
    title,
    anchorAt: input.anchorAt,
    tag: input.tag?.trim() ?? '',
    color: '#71805a',
    items: []
  })
  putCard(card, 'create')
}

export function patchCard(
  cardId: string,
  patch: {
    title?: string
    tag?: string
    anchorAt?: number
    items?: Array<{ id: string; text: string; done: boolean }>
  }
): void {
  const prev = cardById(cardId)
  if (!prev) return
  const title = patch.title !== undefined ? patch.title.trim() : prev.title
  if (!title) return
  const items = patch.items ?? prev.items
  const allDone = items.length > 0 && items.every((i) => i.done)
  const next: Card = {
    ...prev,
    title,
    tag: patch.tag !== undefined ? patch.tag.trim() : prev.tag,
    anchorAt: patch.anchorAt ?? prev.anchorAt,
    items,
    status: prev.status === 'archived' ? 'archived' : allDone ? 'done' : 'open',
    updatedAt: Date.now(),
    rev: prev.rev + 1
  }
  putCard(next, opFor(next, prev))
}

export function removeCard(cardId: string): void {
  const prev = cardById(cardId)
  if (!prev) return
  const next: Card = {
    ...prev,
    deletedAt: Date.now(),
    updatedAt: Date.now(),
    rev: prev.rev + 1
  }
  putCard(next, 'delete')
}

export function setArchived(cardId: string, archived: boolean): void {
  const prev = cardById(cardId)
  if (!prev) return
  const items = prev.items
  const allDone = items.length > 0 && items.every((i) => i.done)
  const status: Card['status'] = archived
    ? 'archived'
    : items.length === 0
      ? 'open'
      : allDone
        ? 'done'
        : 'open'
  if (prev.status === status) return
  const next: Card = { ...prev, status, updatedAt: Date.now(), rev: prev.rev + 1 }
  putCard(next, 'update')
}

export function setSyncSettings(patch: Partial<SyncSettings>): void {
  const before = data.sync.enabled
  data = { ...data, sync: { ...data.sync, ...patch } }
  // 从「关」切到「开」时，把所有本地卡补进队列：
  // 关闭同步期间 putCard 不入队，不补的话那些卡永远推不上去。
  // 服务端对「同时间戳重复推送」返回 unchanged，重复推一遍是安全的。
  if (!before && data.sync.enabled) {
    for (const card of data.cards) {
      if (card.deletedAt === null) enqueue(card, 'create')
    }
  }
  emit()
}

/* ============================================================
 * 同步引擎用的接口
 * ========================================================== */

export function ackOutbox(ids: number[]): void {
  if (ids.length === 0) return
  const drop = new Set(ids)
  data = { ...data, outbox: data.outbox.filter((e) => !drop.has(e.id)) }
  emit()
}

export function markOutboxFailure(ids: number[], message: string): void {
  data = {
    ...data,
    outbox: data.outbox.map((e) =>
      ids.includes(e.id) ? { ...e, attempts: e.attempts + 1, lastError: message } : e
    )
  }
  emit()
}

/** 服务端版本覆盖本地（不入队，避免死循环） */
function applyOne(card: Card): boolean {
  const prev = cardById(card.id)
  if (!prev) {
    data = { ...data, cards: [...data.cards, card] }
    return true
  }
  if (JSON.stringify(prev) === JSON.stringify(card)) return false
  data = { ...data, cards: data.cards.map((c) => (c.id === card.id ? card : c)) }
  return true
}

export function applyServerCard(card: Card): boolean {
  const changed = applyOne(card)
  if (changed) emit()
  return changed
}

/**
 * 一次拉取里批量落库。
 *
 * 逐张 emit 会让 React 重渲染 N 次、排 N 次 save：首同步（服务端几百张卡）
 * 时真机上是肉眼可见的卡顿。这里只 emit 一次。
 */
export function applyServerCards(cards: Card[]): number {
  let changed = 0
  for (const card of cards) if (applyOne(card)) changed += 1
  if (changed > 0) emit()
  return changed
}

export function setCursor(cursor: number): void {
  if (data.cursor === cursor) return
  data = { ...data, cursor }
  emit()
}

export function markSynced(): void {
  data = { ...data, lastSyncAt: Date.now() }
  emit()
}

/** 用户看过启动提示了 */
export function clearNotice(): void {
  if (notice === null) return
  notice = null
  emit()
}
