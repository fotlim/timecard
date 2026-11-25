/**
 * 挂卡时间轴 · 派生计算
 *
 * 卡片本身只存「事实」（挂在哪、勾了没），
 * 这里负责把事实翻译成界面语言：「还差一步」「逾期 2 天」。
 */

import type { Card, CardProgress, CardUrgency } from './model.js'
import { startOfDay } from './time.js'

const DAY_MS = 86_400_000

/** 完成度 */
export function progressOf(card: Card): CardProgress {
  const total = card.items.length
  let done = 0
  for (const item of card.items) if (item.done) done += 1
  const complete = total > 0 && done === total
  return { done, total, ratio: total === 0 ? 0 : done / total, complete }
}

/** 紧急度（按自然日判断，不按小时） */
export function urgencyOf(card: Card, now = Date.now()): CardUrgency {
  if (card.status === 'archived') return 'archived'
  if (card.status === 'done') return 'done'
  const anchorDay = startOfDay(card.anchorAt)
  const today = startOfDay(now)
  if (anchorDay < today) return 'overdue'
  if (anchorDay === today) return 'today'
  return 'upcoming'
}

/** 逾期了几天（未逾期返回 0） */
export function overdueDaysOf(card: Card, now = Date.now()): number {
  const days = Math.floor((startOfDay(now) - startOfDay(card.anchorAt)) / DAY_MS)
  return days > 0 ? days : 0
}

/**
 * 进度文案：`还差一步` / `0/3` / `全做完了`
 *
 * 这是卡片右下角那个小计数器背后的人话。
 */
export function progressLabel(progress: CardProgress): string {
  if (progress.total === 0) return '空卡片'
  if (progress.complete) return '全做完了'
  const left = progress.total - progress.done
  if (left === 1) return '还差一步'
  return `${progress.done}/${progress.total}`
}

/** 紧急度文案；`upcoming` 返回空串（未来不打扰） */
export function urgencyLabel(urgency: CardUrgency, overdueDays: number): string {
  switch (urgency) {
    case 'overdue':
      return overdueDays > 0 ? `逾期 ${overdueDays} 天` : '逾期'
    case 'today':
      return '今天'
    case 'done':
      return '已完成'
    case 'archived':
      return '已归档'
    case 'upcoming':
      return ''
  }
}

/** 卡片是否可以放在时间轴上（未删除） */
export function isLive(card: Card): boolean {
  return card.deletedAt === null
}

/** 卡片是否还需要你操心（未删除、未完成、未归档） */
export function isActive(card: Card): boolean {
  return isLive(card) && card.status === 'open'
}

/**
 * 时间轴排序：先按挂载时刻，再按手排顺序，最后按创建时刻兜底。
 * 保证三端渲染出来的顺序完全一致。
 */
export function compareCards(a: Card, b: Card): number {
  if (a.anchorAt !== b.anchorAt) return a.anchorAt - b.anchorAt
  if (a.order !== b.order) return a.order - b.order
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** 按自然日分组（key 为 `YYYY-MM-DD`），组内已排好序 */
export function groupByDay(cards: Card[]): Map<string, Card[]> {
  const out = new Map<string, Card[]>()
  for (const card of [...cards].sort(compareCards)) {
    const d = new Date(startOfDay(card.anchorAt))
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
      d.getDate(),
    ).padStart(2, '0')}`
    const bucket = out.get(key)
    if (bucket) bucket.push(card)
    else out.set(key, [card])
  }
  return out
}

/** 取某个时间区间内的卡片（左闭右开），已过滤删除 */
export function cardsInRange(cards: Card[], from: number, to: number): Card[] {
  return cards.filter((c) => isLive(c) && c.anchorAt >= from && c.anchorAt < to).sort(compareCards)
}

/** 今天需要操心的卡片（今天到期 + 已逾期），按紧急度排 */
export function todayFocus(cards: Card[], now = Date.now()): Card[] {
  return cards
    .filter((c) => {
      if (!isActive(c)) return false
      const u = urgencyOf(c, now)
      return u === 'overdue' || u === 'today'
    })
    .sort((a, b) => {
      const au = urgencyOf(a, now)
      const bu = urgencyOf(b, now)
      if (au !== bu) return au === 'overdue' ? -1 : 1
      return compareCards(a, b)
    })
}
