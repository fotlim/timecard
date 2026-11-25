import { useState } from 'react'
import {
  addDays,
  cardsInRange,
  isSameDay,
  rangeLabel,
  startOfDay,
  startOfWeek,
  todayFocus,
  urgencyOf,
  weekKey,
  WEEKDAY_SHORT
} from '@timecard/shared'
import type { Card } from '@timecard/shared'
import { HangCard } from './HangCard'
import { buildBlankMenu, buildCardMenu } from '../menu-build'
import { openMenuFromEvent } from '../menu-store'
import { openEditor } from '../editor-store'
import type { Store } from '../store'

const DOW = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'] as const

interface WeekViewProps {
  cards: Card[]
  store: Store
  weekOffset: number
  onWeekOffset: (next: number) => void
  onToggleItem: (cardId: string, itemId: string) => void
  onAddCard: (anchorAt: number) => void
  onBackToToday: () => void
}

export function WeekView({
  cards,
  store,
  weekOffset,
  onWeekOffset,
  onToggleItem,
  onAddCard,
  onBackToToday
}: WeekViewProps): React.JSX.Element {
  const [dropTarget, setDropTarget] = useState<number | null>(null)
  const today = startOfDay(Date.now())
  const weekStart = addDays(startOfWeek(today), weekOffset * 7)
  const weekEnd = addDays(weekStart, 7)
  const weekCards = cardsInRange(
    cards.filter((c) => c.status !== 'archived'),
    weekStart,
    weekEnd
  )
  const focus = todayFocus(cards)
  const overdueCount = cards.filter(
    (c) => c.deletedAt === null && c.status !== 'archived' && urgencyOf(c) === 'overdue'
  ).length

  const days = WEEKDAY_SHORT.map((_, index) => {
    const dayStart = addDays(weekStart, index)
    const dayCards = weekCards.filter((c) => isSameDay(c.anchorAt, dayStart))
    return { index, dayStart, dayCards, isToday: isSameDay(dayStart, today) }
  })

  return (
    <>
      <div className="view-head">
        <span className="no">视图 01</span>
        <h2>桌面 · 周视图</h2>
        <span className="hint">一周一条线 · 每天一张卡 · 逾期自动描红</span>
      </div>

      <div
        className="appframe"
        onContextMenu={(e) => {
          if ((e.target as HTMLElement).closest('.card')) return
          openMenuFromEvent(e, buildBlankMenu(today, store, onAddCard))
        }}
      >
        <div className="appbar">
          <span className="brand-row">
            <span className="branddot" />
            挂卡时间轴
          </span>
          <span className="center-label">Timeline / Weekly</span>
          <span className="chip">DESKTOP 0.1</span>
        </div>

        <div className="weekbar">
          <div className="wknav">
            <button onClick={() => onWeekOffset(weekOffset - 1)} aria-label="上一周">
              ◂
            </button>
            <span className="wkpill">
              {rangeLabel(weekStart, addDays(weekStart, 6))}
              <small>{weekKey(weekStart).replace('-', ' · ')}</small>
            </span>
            <button onClick={() => onWeekOffset(weekOffset + 1)} aria-label="下一周">
              ▸
            </button>
          </div>

          <div className="tools">
            <button className="ghost" onClick={onBackToToday}>
              今日
            </button>
            {weekOffset !== 0 && (
              <button className="ghost" onClick={() => onWeekOffset(0)}>
                回到本周
              </button>
            )}
            <button className="btn-accent" onClick={() => onAddCard(today)}>
              ＋ 挂一张
            </button>
          </div>
        </div>

        <div className="timeline">
          <div className="rail" aria-hidden="true" />

          {days.map((day) => (
            <div
              key={day.index}
              className={`day${day.isToday ? ' today' : ''}${dropTarget === day.index ? ' drop' : ''}`}
              style={{ '--day-i': day.index } as React.CSSProperties}
              onDragOver={(e) => {
                if (!e.dataTransfer.types.includes('text/timecard-card')) return
                e.preventDefault()
                e.dataTransfer.dropEffect = 'move'
                if (dropTarget !== day.index) setDropTarget(day.index)
              }}
              onDragLeave={(e) => {
                // 只在真的离开这个 day 时才消高亮（子元素间移动会触发 leave）
                if (e.currentTarget.contains(e.relatedTarget as Node)) return
                if (dropTarget === day.index) setDropTarget(null)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDropTarget(null)
                const cardId = e.dataTransfer.getData('text/timecard-card')
                if (!cardId) return
                const card = cards.find((c) => c.id === cardId)
                if (!card) return
                // 落到同一天就什么都不做
                if (isSameDay(card.anchorAt, day.dayStart)) return
                store.moveCard(cardId, day.dayStart)
              }}
            >
              <span className="dot" aria-hidden="true" />
              <div className="day-head">
                <span className="dow">{DOW[day.index]}</span>
                <span className="dn">{new Date(day.dayStart).getDate()}</span>
                {day.isToday && <span className="badge-today">今天</span>}
              </div>

              <div className="cards">
                {day.dayCards.length === 0 ? (
                  <button className="card new" onClick={() => onAddCard(day.dayStart)}>
                    <strong>＋ 挂一张</strong>
                    <span>空白的一天</span>
                  </button>
                ) : (
                  day.dayCards.map((card, i) => (
                    <div
                      key={card.id}
                      className="card-slot"
                      style={{ '--i': i } as React.CSSProperties}
                    >
                      <HangCard
                        card={card}
                        onToggleItem={onToggleItem}
                        onMenu={(e, c) => openMenuFromEvent(e, buildCardMenu(c, store))}
                        onEdit={(c) => openEditor(c.id)}
                        draggable
                      />
                    </div>
                  ))
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="stats">
          <span>
            共 {weekCards.length} 张卡 · 今天 {focus.length} 张 · 逾期 {overdueCount} 张
          </span>
          <span>每天挂一张 · 挂在时间上</span>
        </div>
      </div>
    </>
  )
}
