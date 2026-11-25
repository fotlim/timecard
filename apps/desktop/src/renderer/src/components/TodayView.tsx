import { useEffect, useMemo, useState } from 'react'
import {
  addDays,
  cardsInRange,
  dayKey,
  isSameDay,
  progressOf,
  startOfDay,
  urgencyOf,
  WEEKDAY_LABELS,
  weekdayIndex
} from '@timecard/shared'
import type { Card } from '@timecard/shared'
import { HangCard } from './HangCard'
import { buildBlankMenu, buildCardMenu } from '../menu-build'
import { openMenuFromEvent } from '../menu-store'
import type { Store } from '../store'

/**
 * 视图 02 · 竖屏「今日」
 * 严格照样稿的 .m-appbar / .m-date / .m-list / .m-bar 四段结构。
 * 样稿里的状态栏（9:41 / 5G / 电池）是手机壳道具，真窗口不需要。
 */
interface TodayViewProps {
  cards: Card[]
  store: Store
  onToggleItem: (cardId: string, itemId: string) => void
  onAddCard: (anchorAt: number) => void
}

type Filter = 'all' | 'open' | 'done'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: '全部' },
  { key: 'open', label: '未完成' },
  { key: 'done', label: '已完成' }
]

const MONTHS = [
  '一',
  '二',
  '三',
  '四',
  '五',
  '六',
  '七',
  '八',
  '九',
  '十',
  '十一',
  '十二'
] as const

export function TodayView({
  cards,
  store,
  onToggleItem,
  onAddCard
}: TodayViewProps): React.JSX.Element {
  const today = startOfDay(Date.now())
  const [day, setDay] = useState(today)
  const [filter, setFilter] = useState<Filter>('all')
  const [showFilter, setShowFilter] = useState(false)

  const d = new Date(day)
  const isToday = isSameDay(day, today)
  const tomorrow = addDays(day, 1)

  // ←/→ 逐天翻，Home 回今天。输入框/抽屉里打字时不抢键。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const t = e.target as HTMLElement | null
      const tag = t?.tagName ?? ''
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        setDay((prev) => addDays(prev, -1))
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        setDay((prev) => addDays(prev, 1))
      } else if (e.key === 'Home') {
        e.preventDefault()
        setDay(today)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [today])

  const live = useMemo(
    () => cards.filter((c) => c.deletedAt === null && c.status !== 'archived'),
    [cards]
  )

  // 今天要把逾期的一起捞上来；其它日期只显示当天
  const overdue = isToday ? live.filter((c) => urgencyOf(c, today) === 'overdue') : []
  const dayCards = live
    .filter((c) => isSameDay(c.anchorAt, day))
    .sort((a, b) => a.anchorAt - b.anchorAt)

  const tomorrowCards = cardsInRange(live, tomorrow, addDays(tomorrow, 1))

  const matchFilter = (card: Card): boolean => {
    if (filter === 'all') return true
    const done = card.status === 'done' || progressOf(card).complete
    return filter === 'done' ? done : !done
  }

  const rows = [...overdue, ...dayCards].filter(matchFilter)

  return (
    <div
      className="screen"
      onContextMenu={(e) => {
        if ((e.target as HTMLElement).closest('.card')) return
        openMenuFromEvent(e, buildBlankMenu(day, store, onAddCard))
      }}
    >
      {/* 一 · 应用条：品牌 + 筛选 + 挂一张（照样稿） */}
      <div className="m-appbar">
        <span className="brand-row">
          <span className="branddot" />
          挂卡时间轴
        </span>
        <div className="m-tools">
          <button
            className={`m-filter${showFilter ? ' on' : ''}`}
            onClick={() => setShowFilter((v) => !v)}
            aria-expanded={showFilter}
          >
            筛选
          </button>
          <button className="m-add" onClick={() => onAddCard(day)} aria-label="挂一张新卡">
            ＋
          </button>
        </div>
      </div>

      {showFilter && (
        <div className="m-filterbar">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              className={filter === f.key ? 'on' : ''}
              onClick={() => {
                setFilter(f.key)
                setShowFilter(false)
              }}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}

      {/* 二 · 日期：最大的一行字 */}
      <div className="m-date" title="按 ← → 切换日期，Home 回今天">
        <span className="big">{d.getDate()}</span>
        <span className="sm">
          {WEEKDAY_LABELS[weekdayIndex(day)]} · {MONTHS[d.getMonth()]}月
        </span>
        <span className="m-step" role="group" aria-label="切换日期">
          <button onClick={() => setDay(addDays(day, -1))} aria-label="前一天" title="前一天">
            ‹
          </button>
          <button onClick={() => setDay(addDays(day, 1))} aria-label="后一天" title="后一天">
            ›
          </button>
        </span>
        {isToday ? (
          <span className="right">
            {overdue.length > 0
              ? `今天 ${dayCards.length} · 逾期 ${overdue.length}`
              : `今天 · ${dayCards.length} 张`}
          </span>
        ) : (
          <button className="m-back" onClick={() => setDay(today)}>
            回今天
          </button>
        )}
      </div>

      {/* 三 · 卡片列表 */}
      <div className="m-list">
        {rows.length === 0 ? (
          <button className="card new" onClick={() => onAddCard(day)}>
            <strong>＋ 挂一张</strong>
            <span>{filter === 'all' ? '想到什么就挂什么' : '这一类今天是空的'}</span>
          </button>
        ) : (
          <>
            {rows.map((card, i) => (
              <div key={card.id} className="card-slot" style={{ '--i': i } as React.CSSProperties}>
                <HangCard
                  card={card}
                  onToggleItem={onToggleItem}
                  onMenu={(e, c) => openMenuFromEvent(e, buildCardMenu(c, store))}
                />
              </div>
            ))}
            <button className="card new" onClick={() => onAddCard(day)}>
              <strong>＋ 挂一张</strong>
              <span>想到什么就挂什么</span>
            </button>
            <p className="m-empty">— 这一天到此为止，别再塞了 —</p>
          </>
        )}
      </div>

      {/* 四 · 底栏：偷看明天 + 回今天 + 挂一张 */}
      <div className="m-bar">
        <button className="datepill" onClick={() => setDay(tomorrow)}>
          <b>
            {WEEKDAY_LABELS[weekdayIndex(tomorrow)]} · {new Date(tomorrow).getDate()}
          </b>
          <small>
            {tomorrowCards.length === 0 ? '空白的一天' : `${tomorrowCards.length} 张卡`}
          </small>
        </button>
        <button
          className="rnd"
          onClick={() => setDay(today)}
          aria-label="回到今天"
          title={dayKey(today)}
        >
          今
        </button>
        <button className="rnd primary" onClick={() => onAddCard(day)} aria-label="挂一张新卡">
          ＋
        </button>
      </div>
    </div>
  )
}
