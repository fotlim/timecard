import { useState } from 'react'
import {
  addDays,
  cardsInRange,
  isSameDay,
  overdueDaysOf,
  progressLabel,
  progressOf,
  startOfDay,
  startOfWeek,
  urgencyOf,
  WEEKDAY_SHORT
} from '@timecard/shared'
import type { Card } from '@timecard/shared'

interface QuickPanelProps {
  cards: Card[]
  onToggleCardDone: (cardId: string) => void
  onAddCard: (anchorAt: number) => void
}

const MAX_ROWS = 4

export function QuickPanel({
  cards,
  onToggleCardDone,
  onAddCard
}: QuickPanelProps): React.JSX.Element {
  const today = startOfDay(Date.now())
  const [selectedDay, setSelectedDay] = useState(today)

  const weekStart = startOfWeek(today)
  const weekCards = cardsInRange(cards, weekStart, addDays(weekStart, 7))
  const overdue = cards.filter((c) => c.deletedAt === null && urgencyOf(c, today) === 'overdue')

  const dayCards = weekCards.filter((c) => isSameDay(c.anchorAt, selectedDay))
  const rows = [...(isSameDay(selectedDay, today) ? overdue : []), ...dayCards].slice(0, MAX_ROWS)

  return (
    <>
      <div className="view-head">
        <span className="no">视图 03</span>
        <h2>浮窗 · 快速使用</h2>
        <span className="hint">下面这一块是真浮窗里显示的样子</span>
      </div>

      <div className="quick-launcher">
        <button className="btn-accent" onClick={() => void window.timecard?.quick.show()}>
          ↗ 打开浮窗
        </button>
        <span className="quick-kbd">{window.timecard?.quickAcceleratorLabel ?? 'Ctrl+Shift+Space'}</span>
        <span className="quick-note">无边框 · 置顶 · 不进任务栏 · Esc 收起</span>
      </div>

      <div className="quick-stage">
        <div className="quickmat">
          <div className="quick">
            <div className="qstrip">
              {WEEKDAY_SHORT.map((label, index) => {
                const dayStart = addDays(weekStart, index)
                const has = weekCards.some((c) => isSameDay(c.anchorAt, dayStart))
                const on = isSameDay(dayStart, selectedDay)
                return (
                  <button
                    key={index}
                    className={`qday${has ? ' has' : ''}${on ? ' on' : ''}`}
                    onClick={() => setSelectedDay(dayStart)}
                    aria-pressed={on}
                  >
                    <b>{new Date(dayStart).getDate()}</b>
                    <span>{label}</span>
                    <i />
                  </button>
                )
              })}
              <button className="qadd" onClick={() => onAddCard(selectedDay)} aria-label="挂一张卡">
                ＋
              </button>
            </div>

            <div className="qlist">
              {rows.length === 0 ? (
                <div className="qempty">这一天还是空的 · 按 ＋ 挂一张</div>
              ) : (
                rows.map((card) => {
                  const progress = progressOf(card)
                  const isDone = card.status === 'done' || progress.complete
                  const overdueDays = overdueDaysOf(card, today)
                  return (
                    <button
                      key={card.id}
                      className={`qrow${isDone ? ' qdone' : ''}`}
                      onClick={() => onToggleCardDone(card.id)}
                    >
                      <span className="qcheck" aria-hidden="true" />
                      <span className="qd">
                        <span className="qt">{card.title}</span>
                        <span className="qm">
                          {progressLabel(progress)}
                          {card.items[0] ? ` · ${card.items[0].text}` : ''}
                        </span>
                      </span>
                      <span className={`qtag${overdueDays > 0 ? ' alert' : ''}`}>
                        {overdueDays > 0 ? `逾期 ${overdueDays} 天` : card.tag || '未分类'}
                      </span>
                    </button>
                  )
                })
              )}
            </div>

            <div className="qfoot">
              <span>点一行就打勾</span>
              <span className="grow">拖卡改时间</span>
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
