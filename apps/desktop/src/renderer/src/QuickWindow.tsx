import { useEffect, useLayoutEffect, useRef, useState } from 'react'
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
  WEEKDAY_LABELS,
  WEEKDAY_SHORT,
  weekdayIndex
} from '@timecard/shared'
import type { Card } from '@timecard/shared'
import { useStore } from './store'
import { buildCardMenu, buildQuickRowMenu } from './menu-build'
import { openMenuFromEvent } from './menu-store'
import { ContextMenu } from './components/ContextMenu'
import { UndoToast } from './components/UndoToast'

const MAX_ROWS = 4

/** 「今天 / 明天 / 周三」 这种短标签，给输入框占位符用 */
function dayLabel(at: number): string {
  const now = Date.now()
  if (isSameDay(at, now)) return '今天'
  if (isSameDay(at, now + 86_400_000)) return '明天'
  if (isSameDay(at, now - 86_400_000)) return '昨天'
  return `${WEEKDAY_LABELS[weekdayIndex(at)]}`
}

/** 真·浮窗：一个 360px 的挂卡面板，Esc 收起，高度跟着内容走 */
export function QuickWindow(): React.JSX.Element {
  const store = useStore()
  const { cards, skin, ready } = store
  const today = startOfDay(Date.now())
  const [selectedDay, setSelectedDay] = useState(today)
  const [draft, setDraft] = useState('')
  const shellRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 截图/验收时用 hash 强制皮肤，保证出图确定性
  useEffect(() => {
    const forced = window.location.hash.replace('#', '')
    if (forced === 'organic' || forced === 'brutal' || forced === 'neo') {
      document.documentElement.dataset.theme = forced
    } else {
      document.documentElement.dataset.theme = skin
    }
  }, [skin])

  const weekStart = startOfWeek(today)
  const weekCards = cardsInRange(cards, weekStart, addDays(weekStart, 7))
  const overdue = cards.filter((c) => c.deletedAt === null && urgencyOf(c, today) === 'overdue')
  const dayCards = weekCards.filter((c) => isSameDay(c.anchorAt, selectedDay))
  const allRows = [...(isSameDay(selectedDay, today) ? overdue : []), ...dayCards]
  const rows = allRows.slice(0, MAX_ROWS)
  // 超出的部分不能默默吞掉 —— 用户需要知道还有几张
  const hidden = Math.max(0, allRows.length - rows.length)

  // Esc：输入框里有内容先清掉，空了才收起浮窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      // 中文输入法组字中按 Esc = 取消候选词，不是「清空/收起」。
      // 不判这个，用户选词按一下就丢了半截拼音，还会把浮窗收掉。
      if (e.isComposing) return
      if (draft) {
        e.preventDefault()
        setDraft('')
        inputRef.current?.focus()
        return
      }
      window.timecard?.quick.hide()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [draft])

  // 浮窗一露面就聚焦输入框 —— 顺手就能打字，这才是"按一下挂一张"
  useEffect(() => {
    const focus = (): void => inputRef.current?.focus()
    focus()
    window.addEventListener('focus', focus)
    return () => window.removeEventListener('focus', focus)
  }, [])

  const submit = (): void => {
    const title = draft.trim()
    if (!title) return
    store.addCard(title, selectedDay)
    setDraft('')
    // 保持焦点，方便连着挂第二张
    requestAnimationFrame(() => inputRef.current?.focus())
  }

  // 内容高度回传主进程，窗口跟着长
  useLayoutEffect(() => {
    const el = shellRef.current
    if (!el) return
    let last = 0
    let raf = 0
    // rAF 节流：ResizeObserver 在一次布局里可能连发多次，
    // 每发一次就是一次 IPC + setBounds，很浪费。
    const report = (): void => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        const h = Math.ceil(el.getBoundingClientRect().height)
        if (h > 0 && h !== last) {
          last = h
          window.timecard?.quick.resize(h)
        }
      })
    }
    report()
    const ro = new ResizeObserver(report)
    ro.observe(el)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
    }
  }, [ready, rows.length])

  const toggleCard = (card: Card): void => {
    window.timecard?.store.toggleCardDone(card.id)
  }

  return (
    <>
      <ContextMenu />
      <UndoToast />
      <div className="quick-shell" ref={shellRef}>
      <div className="quick">
        {/* 拖动把手：无边框窗口全靠这一条 -webkit-app-region: drag 才能移动 */}
        <div className="qgrab" title="拖动移动浮窗">
          <span className="qgrip" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <button
            className="qclose"
            onClick={() => window.timecard?.quick.hide()}
            aria-label="收起浮窗"
            title="收起（Esc）"
          >
            ✕
          </button>
        </div>

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
          <button
            className="qadd"
            onClick={() => {
              // 带上当前选中的那一天，否则用户刚点的「周三」会被丢掉
              window.timecard?.quick.openComposer(selectedDay)
            }}
            aria-label="挂一张卡"
          >
            ＋
          </button>
        </div>

        {/* 输入行：顺手就能打字，回车挂上 */}
        <div className="qinput">
          <span className="qinput-mark" aria-hidden="true">
            ＋
          </span>
          <input
            ref={inputRef}
            className="qinput-field"
            type="text"
            value={draft}
            maxLength={60}
            placeholder={`给 ${dayLabel(selectedDay)} 挂一张…`}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // 组字态的回车是「确认候选」，不能当成提交
              if (e.nativeEvent.isComposing) return
              if (e.key === 'Enter') {
                e.preventDefault()
                submit()
              }
            }}
          />
          {draft.trim() && (
            <button className="qinput-go" onClick={submit} title="挂上（回车）">
              挂上
            </button>
          )}
        </div>

        <div className="qlist">
          {rows.length === 0 ? (
            <div className="qempty">这一天还是空的 · 按 ＋ 挂一张</div>
          ) : (
            rows.map((card, i) => {
              const progress = progressOf(card)
              const isDone = card.status === 'done' || progress.complete
              const overdueDays = overdueDaysOf(card, today)
              return (
                <button
                  key={card.id}
                  className={`qrow${isDone ? ' qdone' : ''}`}
                  style={{ '--i': i } as React.CSSProperties}
                  onClick={() => toggleCard(card)}
                  onContextMenu={(e) => openMenuFromEvent(e, buildQuickRowMenu(card, store))}
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
          {hidden > 0 && (
            <button
              className="qmore"
              onClick={() => void window.timecard?.focusMain()}
              title="打开主窗口看全部"
            >
              还有 {hidden} 张<span aria-hidden="true"> →</span>
            </button>
          )}
        </div>

        <div className="qfoot">
          <span>点一行就打勾</span>
          {store.sync?.settings?.enabled && (
            <span
              className={`qsync ${store.sync?.state?.phase ?? 'idle'}`}
              title={store.sync?.state?.error ?? '同步状态'}
            >
              <span className="qsync-dot" />
              {store.sync?.state?.phase === 'syncing'
                ? '同步中'
                : store.sync?.state?.pending
                  ? `${store.sync.state.pending} 待推`
                  : store.sync?.state?.phase === 'offline'
                    ? '离线'
                    : ''}
            </span>
          )}
          <span className="grow">
            <kbd>Esc</kbd> 收起
          </span>
        </div>
      </div>
      </div>
    </>
  )
}
