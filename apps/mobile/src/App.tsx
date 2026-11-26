import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import {
  addDays,
  cardsInRange,
  clockLabel,
  createCardItem,
  dayKey,
  isSameDay,
  overdueDaysOf,
  progressOf,
  startOfDay,
  WEEKDAY_LABELS,
  weekdayIndex
} from '@timecard/shared'
import type { Card, CardItem, Skin } from '@timecard/shared'
import * as db from './store'
import type { State } from './store'
import { atOnDay, isCardDone, isOverdueCard } from './date'
import { describeError, scheduleSync, startSyncLoop, subscribeSync, syncIfStale, syncNow, syncState, testConnection } from './sync'

type Filter = 'all' | 'open' | 'done'
type Sheet =
  | null
  | { kind: 'compose'; anchorAt: number }
  | { kind: 'edit'; cardId: string }
  | { kind: 'settings' }
  | { kind: 'search' }

const MONTHS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'] as const
const SKINS: Skin[] = ['organic', 'brutal', 'neo']
const SKIN_LABELS: Record<Skin, string> = { organic: '自然有机', brutal: '野兽派', neo: '新拟物质' }

function useStore(): State {
  return useSyncExternalStore(db.subscribe, db.getSnapshot, db.getSnapshot)
}

function dayLabel(at: number): string {
  const now = Date.now()
  if (isSameDay(at, now)) return '今天'
  if (isSameDay(at, now + 86_400_000)) return '明天'
  if (isSameDay(at, now - 86_400_000)) return '昨天'
  return `${WEEKDAY_LABELS[weekdayIndex(at)]} ${new Date(at).getDate()}`
}

const FILTER_LABELS: Record<Filter, string> = { all: '全部', open: '未完成', done: '已完成' }

/**
 * 「今天」的零点。
 *
 * 不能用 useMemo(..., []) 只算一次：App 常驻后台过夜、或跨零点还开着，
 * 那样「今天」会永远停在启动那天 —— 逾期区清空、日期大字错、「回今天」回错一天。
 * 这里到下一个零点自动重算，切回前台再校正一次（手动改系统时间也能兜住）。
 */
function useToday(): number {
  const [today, setToday] = useState(() => startOfDay(Date.now()))

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null

    const syncDay = (): void => {
      setToday((prev) => {
        const next = startOfDay(Date.now())
        return prev === next ? prev : next
      })
    }

    const schedule = (): void => {
      if (timer) clearTimeout(timer)
      const now = Date.now()
      const nextMidnight = startOfDay(now) + 86_400_000
      timer = setTimeout(
        () => {
          syncDay()
          schedule()
        },
        Math.max(1000, nextMidnight - now + 1000)
      )
    }

    const onVisible = (): void => {
      if (document.visibilityState !== 'visible') return
      syncDay()
      schedule()
    }

    schedule()
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [])

  return today
}

/**
 * 把可见视口高度写进 `--vp-h`。
 *
 * Android WebView 弹键盘时如果系统选了 adjustPan，布局视口不会缩、`vh` 也不会变，
 * 抽屉底部按钮就会被键盘压住；用它兜底，CSS 那边用 min(86vh, var(--vp-h))。
 */
function useVisibleHeightVar(): void {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const apply = (): void => {
      document.documentElement.style.setProperty('--vp-h', `${Math.round(vv.height)}px`)
    }
    apply()
    vv.addEventListener('resize', apply)
    vv.addEventListener('scroll', apply)
    return () => {
      vv.removeEventListener('resize', apply)
      vv.removeEventListener('scroll', apply)
    }
  }, [])
}

export default function App(): React.JSX.Element {
  const state = useStore()
  const today = useToday()
  useVisibleHeightVar()
  const [day, setDay] = useState(today)
  const [filter, setFilter] = useState<Filter>('all')
  const [showFilter, setShowFilter] = useState(false)
  const [sheet, setSheet] = useState<Sheet>(null)
  const prevToday = useRef(today)

  // 下拉刷新：列表在顶部时往下拽，松手触发一次同步
  const listRef = useRef<HTMLDivElement>(null)
  const pullStart = useRef<number | null>(null)
  const [pull, setPull] = useState(0)
  const [pullBusy, setPullBusy] = useState(false)
  const [pullMsg, setPullMsg] = useState<string | null>(null)
  const PULL_TRIGGER = 56

  const doPullRefresh = async (): Promise<void> => {
    setPullBusy(true)
    setPull(PULL_TRIGGER)
    const report = await syncNow()
    setPullBusy(false)
    setPullMsg(report.ok ? '已同步' : '同步失败')
    setPull(0)
    setTimeout(() => setPullMsg(null), 1200)
  }

  const allLive = useMemo(() => state.cards.filter((c) => c.deletedAt === null), [state.cards])
  const live = useMemo(() => allLive.filter((c) => c.status !== 'archived'), [allLive])

  // 皮肤落到 html[data-theme]
  useEffect(() => {
    document.documentElement.dataset.theme = state.skin
  }, [state.skin])

  // 启动 / 回前台补一次同步；切后台立刻把本地改动落盘（不等 120ms 防抖）
  useEffect(() => {
    syncIfStale()
    startSyncLoop()
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') syncIfStale()
      else db.flush()
    }
    const onHide = (): void => db.flush()
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onHide)
      db.flush()
    }
  }, [])

  // 安卓硬件返回键：原生 MainActivity 会调 window.__tcBack()。
  // 有抽屉先关抽屉、有筛选先关筛选，都没有返回 'false' 让原生退出。
  useEffect(() => {
    const w = window as unknown as { __tcBack?: () => string }
    w.__tcBack = () => {
      if (sheet) {
        setSheet(null)
        return 'true'
      }
      if (showFilter) {
        setShowFilter(false)
        return 'true'
      }
      return 'false'
    }
    return () => {
      delete w.__tcBack
    }
  }, [sheet, showFilter])

  // 跨零点：原来停在「今天」的话，跟着滚到新的今天
  useEffect(() => {
    if (prevToday.current === today) return
    const was = prevToday.current
    prevToday.current = today
    setDay((d) => (d === was ? today : d))
  }, [today])

  // 本地一改就排一次同步。
  // 看两个信号：pending 变多是「刚开同步 / 队列里还有货」，
  // changeSeq 变更是「同一张卡又改了一次」（合并后 pending 长度不变，光看 pending 会漏）。
  const { changeSeq, pending } = state
  useEffect(() => {
    if (pending > 0 || changeSeq > 0) scheduleSync()
  }, [pending, changeSeq])

  const isToday = isSameDay(day, today)
  // 逾期区按「挂载日 < 今天」算，不看 status（详见 date.ts 的注释）：
  // 勾完最后一项的逾期卡要留在原地，不能凭空消失。
  const overdue = isToday
    ? live
        .filter((c) => isOverdueCard(c, today))
        .sort((a, b) => Number(isCardDone(a)) - Number(isCardDone(b)) || a.anchorAt - b.anchorAt)
    : []
  const dayCards = live
    .filter((c) => isSameDay(c.anchorAt, day))
    .sort((a, b) => a.anchorAt - b.anchorAt)
  const tomorrow = addDays(day, 1)
  const tomorrowCount = cardsInRange(live, tomorrow, addDays(tomorrow, 1)).length

  const matchFilter = (card: Card): boolean => {
    if (filter === 'all') return true
    const done = isCardDone(card)
    return filter === 'done' ? done : !done
  }
  const rows = [...overdue, ...dayCards].filter(matchFilter)

  const d = new Date(day)

  return (
    <div className="screen">
      {state.notice && (
        <div className="m-notice" role="alert">
          <span>{state.notice.message}</span>
          <button className="m-notice-x" onClick={() => db.clearNotice()}>
            知道了
          </button>
        </div>
      )}

      {/* 一 · 应用条 */}
      <div className="m-appbar">
        <button className="brand-row" onClick={() => setSheet({ kind: 'settings' })}>
          <span className="branddot" />
          挂卡时间轴
        </button>
        <div className="m-tools">
          <button
            className="m-search"
            onClick={() => setSheet({ kind: 'search' })}
            aria-label="搜索卡片"
            title="搜索"
          >
            <svg
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.5-3.5" />
            </svg>
          </button>
          <button
            className={`m-filter${filter === 'all' ? '' : ' on'}`}
            onClick={() => setShowFilter((v) => !v)}
            aria-expanded={showFilter}
          >
            {filter === 'all' ? '筛选' : FILTER_LABELS[filter]}
          </button>
          <button
            className="m-add"
            onClick={() => setSheet({ kind: 'compose', anchorAt: day })}
            aria-label="挂一张新卡"
          >
            ＋
          </button>
        </div>
      </div>

      {showFilter && (
        <div className="m-filterbar">
          {(
            [
              { k: 'all', t: '全部' },
              { k: 'open', t: '未完成' },
              { k: 'done', t: '已完成' }
            ] as Array<{ k: Filter; t: string }>
          ).map((f) => (
            <button
              key={f.k}
              className={filter === f.k ? 'on' : ''}
              onClick={() => {
                setFilter(f.k)
                setShowFilter(false)
              }}
            >
              {f.t}
            </button>
          ))}
        </div>
      )}

      {/* 二 · 日期 */}
      <div className="m-date">
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
            {overdue.length > 0 ? `今天 ${dayCards.length} · 逾期 ${overdue.length}` : `今天 · ${dayCards.length} 张`}
          </span>
        ) : (
          <button className="m-back" onClick={() => setDay(today)}>
            回今天
          </button>
        )}
      </div>

      {/* 三 · 卡片 */}
      <div className="m-list-wrap">
        {(pull > 0 || pullMsg) && (
          <div
            className={`m-pull${pullBusy ? ' busy' : ''}${pull >= PULL_TRIGGER ? ' ready' : ''}`}
            style={{ height: Math.max(pull, pullMsg ? 32 : 0) }}
            aria-live="polite"
          >
            <span>
              {pullMsg ?? (pullBusy ? '同步中…' : pull >= PULL_TRIGGER ? '松手同步' : '下拉同步')}
            </span>
          </div>
        )}
        <div
          className="m-list"
          ref={listRef}
          onTouchStart={(e) => {
            if ((listRef.current?.scrollTop ?? 0) > 0) return
            pullStart.current = e.touches[0]?.clientY ?? null
          }}
          onTouchMove={(e) => {
            if (pullStart.current === null || pullBusy) return
            const dy = (e.touches[0]?.clientY ?? 0) - pullStart.current
            if (dy <= 0) {
              setPull(0)
              return
            }
            // 阻尼：手指移动 2px，指示条长 1px，最多 80
            setPull(Math.min(80, dy * 0.5))
          }}
          onTouchEnd={() => {
            const reached = pull >= PULL_TRIGGER
            pullStart.current = null
            if (reached && !pullBusy) void doPullRefresh()
            else setPull(0)
          }}
        >
          {rows.length === 0 ? (
            <button className="card new" onClick={() => setSheet({ kind: 'compose', anchorAt: day })}>
              <strong>＋ 挂一张</strong>
              <span>{filter === 'all' ? '想到什么就挂什么' : '这一类今天是空的'}</span>
            </button>
          ) : (
            <>
              {rows.map((card, i) => (
                <div key={card.id} className="card-slot" style={{ '--i': i } as React.CSSProperties}>
                  <HangCard
                    card={card}
                    onToggleItem={db.toggleItem}
                    onOpen={() => setSheet({ kind: 'edit', cardId: card.id })}
                  />
                </div>
              ))}
              <button className="card new" onClick={() => setSheet({ kind: 'compose', anchorAt: day })}>
                <strong>＋ 挂一张</strong>
                <span>想到什么就挂什么</span>
              </button>
              <p className="m-empty">— 这一天到此为止，别再塞了 —</p>
            </>
          )}
        </div>
      </div>

      {/* 四 · 底栏 */}
      <div className="m-bar">
        <button className="datepill" onClick={() => setDay(tomorrow)}>
          <b>
            {WEEKDAY_LABELS[weekdayIndex(tomorrow)]} · {new Date(tomorrow).getDate()}
          </b>
          <small>{tomorrowCount === 0 ? '空白的一天' : `${tomorrowCount} 张卡`}</small>
        </button>
        <button className="rnd" onClick={() => setDay(today)} aria-label="回到今天">
          今
        </button>
        <button
          className="rnd primary"
          onClick={() => setSheet({ kind: 'compose', anchorAt: day })}
          aria-label="挂一张新卡"
        >
          ＋
        </button>
      </div>

      {sheet?.kind === 'compose' && (
        <ComposeSheet
          anchorAt={sheet.anchorAt}
          onClose={() => setSheet(null)}
          onSave={(title, tag, at) => {
            db.addCard({ title, anchorAt: at, tag })
            setSheet(null)
          }}
        />
      )}

      {sheet?.kind === 'edit' && (
        <EditSheet
          cardId={sheet.cardId}
          cards={state.cards}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet?.kind === 'settings' && <SettingsSheet onClose={() => setSheet(null)} />}

      {sheet?.kind === 'search' && (
        <SearchSheet
          cards={allLive}
          onClose={() => setSheet(null)}
          onPick={(card) => {
            // 跳到那张卡所在的日期，再打开它的编辑抽屉
            setDay(startOfDay(card.anchorAt))
            setSheet({ kind: 'edit', cardId: card.id })
          }}
        />
      )}
    </div>
  )
}

/* ============================================================
 * 卡片
 * ========================================================== */

function HangCard({
  card,
  onToggleItem,
  onOpen
}: {
  card: Card
  onToggleItem: (cardId: string, itemId: string) => void
  onOpen: () => void
}): React.JSX.Element {
  const progress = progressOf(card)
  const overdue = overdueDaysOf(card)
  const isDone = isCardDone(card)

  return (
    <article
      className={`card${overdue > 0 ? ' alert' : ''}${isDone ? ' is-done' : ''}`}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onOpen()
        }
      }}
    >
      <div className="meta-top">
        <span className="tag">{card.tag || '未分类'}</span>
        {overdue > 0 && <span className="flag">逾期 {overdue} 天</span>}
        {isDone && <span className="flag done">已完成</span>}
      </div>

      <h3>{card.title}</h3>

      {card.items.length > 0 && (
        <ul className="checks">
          {card.items.map((item) => (
            <li key={item.id}>
              <div
                className={`check${item.done ? ' done' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleItem(card.id, item.id)
                }}
                role="checkbox"
                aria-checked={item.done}
                tabIndex={0}
              >
                <span className="box" />
                <span className="txt">{item.text}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="card-foot">
        <span>
          {clockLabel(card.anchorAt)} 挂上 · {progress.total} 个待办
        </span>
        <span className="count">
          {progress.done}/{progress.total}
        </span>
      </div>
    </article>
  )
}

/* ============================================================
 * 底部抽屉
 * ========================================================== */

function SheetShell({
  kicker,
  dateLabel: dateText,
  onClose,
  dirty = false,
  notice,
  children,
  foot
}: {
  kicker: string
  dateLabel?: string
  onClose: () => void
  /** 有未保存内容时，点遮罩不许直接关（先问一句） */
  dirty?: boolean
  /** 贴在底部按钮行「上方」的一条提示条（如删除确认）：不塞进按钮行，按钮位子一个都不挪 */
  notice?: React.ReactNode
  children: React.ReactNode
  foot: React.ReactNode
}): React.JSX.Element {
  const [confirmClose, setConfirmClose] = useState(false)

  const tryClose = (): void => {
    if (!dirty) {
      onClose()
      return
    }
    setConfirmClose(true)
  }

  return (
    <div className="sheet-mask" onClick={tryClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-grip" />
        <div className="sheet-head">
          <span className="sheet-kicker">{kicker}</span>
          {dateText && <span className="sheet-date">{dateText}</span>}
        </div>
        <div className="sheet-body">{children}</div>
        {notice}
        {confirmClose && (
          <div className="sheet-confirm" role="alertdialog">
            <span>还有没保存的内容</span>
            <button className="sheet-btn" onClick={() => setConfirmClose(false)}>
              继续编辑
            </button>
            <button className="sheet-btn danger-ghost" onClick={onClose}>
              放弃并关闭
            </button>
          </div>
        )}
        <div className="sheet-foot">{foot}</div>
      </div>
    </div>
  )
}

const CHIPS = ['今天', '明天', '后天', '下周'] as const

/**
 * 日期快选：只换「哪一天」，时:分沿用当前选中的时刻。
 * （`baseAt` 就是当前 anchorAt，保证点 chip 不会把 09:30 抹成 00:00。）
 */
function dateChips(today: number, baseAt: number): Array<{ label: string; at: number }> {
  return [
    { label: CHIPS[0], at: atOnDay(today, baseAt) },
    { label: CHIPS[1], at: atOnDay(addDays(today, 1), baseAt) },
    { label: CHIPS[2], at: atOnDay(addDays(today, 2), baseAt) },
    { label: CHIPS[3], at: atOnDay(addDays(today, 7), baseAt) }
  ]
}

function ComposeSheet({
  anchorAt,
  onClose,
  onSave
}: {
  anchorAt: number
  onClose: () => void
  onSave: (title: string, tag: string, at: number) => void
}): React.JSX.Element {
  const today = startOfDay(Date.now())
  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('')
  // 时:分默认取「打开抽屉的这一刻」，日期跟着 anchorAt：
  // 挂到明天/后天不会变成 00:00，卡片脚注也就和桌面端一样有真实时刻。
  const [at, setAt] = useState(() => atOnDay(anchorAt, Date.now()))
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 180)
    return () => clearTimeout(t)
  }, [])

  const submit = (): void => {
    if (!title.trim()) return
    onSave(title, tag, at)
  }

  return (
    <SheetShell
      kicker="挂一张卡"
      dateLabel={`${dayLabel(at)} · ${dayKey(at)}`}
      dirty={title.trim() !== '' || tag.trim() !== ''}
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="sheet-btn" onClick={onClose}>
            取消
          </button>
          <button className="sheet-btn primary" onClick={submit} disabled={!title.trim()}>
            ＋ 挂上
          </button>
        </>
      }
    >
      <div className="field-stack">
        <input
          ref={inputRef}
          value={title}
          maxLength={60}
          placeholder="要挂一张什么卡…"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit()
          }}
        />
        <input
          value={tag}
          maxLength={18}
          placeholder="分类，如「家庭」「工作」（可留空）"
          onChange={(e) => setTag(e.target.value)}
        />
      </div>
      <div className="sheet-chips">
        {dateChips(today, at).map((c) => (
          <button
            key={c.label}
            className={`sheet-chip${isSameDay(c.at, at) ? ' on' : ''}`}
            onClick={() => setAt(c.at)}
          >
            {c.label}
          </button>
        ))}
      </div>
    </SheetShell>
  )
}

function SearchSheet({
  cards,
  onClose,
  onPick
}: {
  cards: Card[]
  onClose: () => void
  onPick: (card: Card) => void
}): React.JSX.Element {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    const t = setTimeout(() => inputRef.current?.focus(), 180)
    return () => clearTimeout(t)
  }, [])
  const query = q.trim().toLowerCase()
  const results = query
    ? cards
        .filter(
          (c) =>
            c.title.toLowerCase().includes(query) ||
            (c.tag || '').toLowerCase().includes(query) ||
            // 条目内容也搜：常常记得的是「卡里写了什么」
            c.items.some((i) => i.text.toLowerCase().includes(query))
        )
        .sort((a, b) => b.anchorAt - a.anchorAt)
        .slice(0, 50)
    : []
  return (
    <SheetShell
      kicker="搜索卡片"
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="sheet-btn primary" onClick={onClose}>
            关闭
          </button>
        </>
      }
    >
      <div className="field-stack">
        <input
          ref={inputRef}
          value={q}
          maxLength={40}
          placeholder="搜标题、分类或条目…"
          onChange={(e) => setQ(e.target.value)}
        />
      </div>
      <div className="search-list">
        {query === '' ? (
          <p className="search-hint">输入关键词，在全库里找一张卡</p>
        ) : results.length === 0 ? (
          <p className="search-hint">没有匹配的卡片</p>
        ) : (
          results.map((c) => {
            const hitItem = c.items.find((i) => i.text.toLowerCase().includes(query))
            return (
              <button key={c.id} className="search-row" onClick={() => onPick(c)}>
                <span className="search-row-main">
                  <span className="search-row-title">{c.title || '（无标题）'}</span>
                  <span className="search-row-meta">
                    {dayLabel(c.anchorAt)} · {dayKey(c.anchorAt)}
                    {c.tag ? ' · ' + c.tag : ''}
                    {c.status === 'archived' ? ' · 已归档' : isCardDone(c) ? ' · 已完成' : ''}
                    {hitItem && (
                      <span className="search-row-hit">
                        {' '}
                        · 条目「{hitItem.text.trim().slice(0, 24)}」
                      </span>
                    )}
                  </span>
                </span>
                <span className="search-row-date">{new Date(c.anchorAt).getDate()}</span>
              </button>
            )
          })
        )}
      </div>
    </SheetShell>
  )
}

function EditSheet({
  cardId,
  cards,
  onClose
}: {
  cardId: string
  cards: Card[]
  onClose: () => void
}): React.JSX.Element | null {
  const card = cards.find((c) => c.id === cardId) ?? null
  const today = startOfDay(Date.now())
  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('')
  const [items, setItems] = useState<CardItem[]>([])
  // 初值直接取卡上的时刻（0 会让抽屉第一帧闪出 1970-01-01）
  const [at, setAt] = useState(() => card?.anchorAt ?? startOfDay(Date.now()))
  const [confirmDel, setConfirmDel] = useState(false)
  const seeded = useRef<string | null>(null)

  useEffect(() => {
    if (!card || seeded.current === card.id) return
    seeded.current = card.id
    setTitle(card.title)
    setTag(card.tag)
    setItems(card.items.map((i) => ({ ...i })))
    setAt(card.anchorAt)
    setConfirmDel(false)
  }, [card])

  if (!card) return null

  const dirty =
    title.trim() !== card.title ||
    tag.trim() !== card.tag ||
    at !== card.anchorAt ||
    JSON.stringify(items) !== JSON.stringify(card.items)

  const save = (): void => {
    if (!title.trim()) return
    db.patchCard(card.id, { title, tag, anchorAt: at, items })
    onClose()
  }

  return (
    <SheetShell
      kicker="编辑卡片"
      dateLabel={`${dayLabel(at)} · ${dayKey(at)}`}
      dirty={dirty}
      onClose={onClose}
      notice={
        /* 确认删除放在按钮行「上方」的提示条里：按钮一个都不挪，也不会冒出第二个「取消」 */
        confirmDel ? (
          <div className="sheet-confirm danger" role="alertdialog" aria-label="确认删除卡片">
            <span>删除「{card.title.trim() || '这张卡'}」？</span>
            <button className="sheet-btn" onClick={() => setConfirmDel(false)}>
              取消
            </button>
            <button
              className="sheet-btn danger"
              onClick={() => {
                db.removeCard(card.id)
                onClose()
              }}
            >
              删除
            </button>
          </div>
        ) : null
      }
      foot={
        <>
          <button
            className="sheet-btn"
            onClick={() => {
              db.setArchived(card.id, card.status !== 'archived')
              onClose()
            }}
          >
            {card.status === 'archived' ? '取消归档' : '归档'}
          </button>
          <button
            className={`sheet-btn danger-ghost${confirmDel ? ' on' : ''}`}
            aria-expanded={confirmDel}
            onClick={() => setConfirmDel((v) => !v)}
          >
            删除
          </button>
          <span className="sp" />
          <button className="sheet-btn" onClick={onClose}>
            取消
          </button>
          <button className="sheet-btn primary" onClick={save} disabled={!title.trim()}>
            保存
          </button>
        </>
      }
    >
      <div className="field-stack">
        <input value={title} maxLength={60} onChange={(e) => setTitle(e.target.value)} />
        <input
          value={tag}
          maxLength={18}
          placeholder="分类（可留空）"
          onChange={(e) => setTag(e.target.value)}
        />
      </div>

      <div className="sheet-chips">
        {dateChips(today, at).map((c) => (
          <button
            key={c.label}
            className={`sheet-chip${isSameDay(c.at, at) ? ' on' : ''}`}
            onClick={() => setAt(c.at)}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div>
        {items.map((item) => (
          <div key={item.id} className="item-row">
            <div
              className={`box${item.done ? ' on' : ''}`}
              onClick={() =>
                setItems((prev) =>
                  prev.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i))
                )
              }
              style={item.done ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
            />
            <input
              type="text"
              value={item.text}
              maxLength={80}
              placeholder="条目内容"
              onChange={(e) =>
                setItems((prev) =>
                  prev.map((i) => (i.id === item.id ? { ...i, text: e.target.value } : i))
                )
              }
            />
            <button
              className="item-del"
              onClick={() => setItems((prev) => prev.filter((i) => i.id !== item.id))}
              aria-label="删除条目"
            >
              ✕
            </button>
          </div>
        ))}
        <button
          className="sheet-add"
          onClick={() => setItems((prev) => [...prev, createCardItem('')])}
        >
          ＋ 加一条
        </button>
      </div>
    </SheetShell>
  )
}

function SettingsSheet({ onClose }: { onClose: () => void }): React.JSX.Element {
  const state = useStore()
  const [sync, setSync] = useState(syncState())
  const [url, setUrl] = useState(state.sync.serverUrl)
  const [token, setToken] = useState(state.sync.token)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => subscribeSync(() => setSync(syncState())), [])

  const dirty = url.trim() !== state.sync.serverUrl || token.trim() !== state.sync.token
  const phase = sync.phase
  const phaseText: Record<string, string> = {
    idle: '空闲',
    syncing: '同步中…',
    offline: '离线',
    error: '出错'
  }

  return (
    <SheetShell
      kicker="设置"
      dirty={dirty}
      onClose={onClose}
      foot={
        <>
          <span className="sp" />
          <button className="sheet-btn primary" onClick={onClose}>
            完成
          </button>
        </>
      }
    >
      <div className="srow">
        <div className="srow-main">
          <span className="srow-title">外观</span>
          <span className="srow-desc">三套皮肤随时换</span>
        </div>
      </div>
      <div className="sheet-chips" style={{ paddingTop: 0 }}>
        {SKINS.map((s) => (
          <button
            key={s}
            className={`sheet-chip${state.skin === s ? ' on' : ''}`}
            onClick={() => db.setSkin(s)}
          >
            {SKIN_LABELS[s]}
          </button>
        ))}
      </div>

      <div className="srow">
        <div className="srow-main">
          <span className="srow-title">启用同步</span>
          <span className="srow-desc">本地先写，联网后自动推上去</span>
        </div>
        <button
          className={`stoggle${state.sync.enabled ? ' on' : ''}`}
          role="switch"
          aria-checked={state.sync.enabled}
          onClick={() => db.setSyncSettings({ enabled: !state.sync.enabled })}
        >
          <span className="knob" />
        </button>
      </div>

      <div className="srow">
        <div className="srow-main" style={{ gap: 8 }}>
          <span className="srow-title">服务器地址</span>
          <input
            value={url}
            placeholder="https://你的服务器"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setUrl(e.target.value)
              setTest(null)
            }}
          />
          <span className="srow-title">访问令牌</span>
          <input
            type="password"
            value={token}
            placeholder="TIMECARD_TOKEN"
            autoCapitalize="off"
            autoCorrect="off"
            onChange={(e) => {
              setToken(e.target.value)
              setTest(null)
            }}
          />
        </div>
      </div>

      <div className="srow">
        <button
          className="sheet-btn"
          style={{ fontSize: 12.5, padding: '9px 14px' }}
          disabled={testing}
          onClick={async () => {
            setTesting(true)
            setTest(null)
            try {
              const r = await testConnection(url, token)
              setTest(
                r.ok
                  ? { ok: true, text: `连接成功 · ${r.ms}ms · 服务器上 ${r.cardCount ?? 0} 张卡` }
                  : { ok: false, text: r.message ?? '连接失败' }
              )
            } finally {
              setTesting(false)
            }
          }}
        >
          {testing ? '测试中…' : '测试连接'}
        </button>
        {dirty && (
          <button
            className="sheet-btn primary"
            style={{ fontSize: 12.5, padding: '9px 14px' }}
            onClick={() => {
              db.setSyncSettings({ serverUrl: url.trim(), token: token.trim() })
              setTest(null)
            }}
          >
            保存
          </button>
        )}
      </div>

      {test && (
        <div className="srow">
          <div className="srow-main">
            <span className={`srow-desc ${test.ok ? 'sync-ok' : 'sync-err'}`}>
              {test.ok ? '✓ ' : '✗ '}
              {test.text}
            </span>
          </div>
        </div>
      )}

      <div className="srow">
        <div className="srow-main">
          <span className="srow-title">
            <span className={`sync-dot ${phase}`} />
            {phaseText[phase] ?? phase}
            {state.pending > 0 ? ` · ${state.pending} 条待推送` : ''}
          </span>
          <span className="srow-desc">
            {state.lastSyncAt
              ? `上次同步 ${new Date(state.lastSyncAt).toLocaleTimeString()}`
              : '还没同步过'}
            {sync.error ? ` · ${sync.error}` : ''}
          </span>
        </div>
        <button
          className="sheet-btn"
          style={{ fontSize: 12.5, padding: '9px 14px' }}
          disabled={busy || !state.sync.enabled || !state.sync.serverUrl}
          onClick={async () => {
            setBusy(true)
            await syncNow()
            setBusy(false)
          }}
        >
          {busy ? '同步中…' : '立即同步'}
        </button>
      </div>

      {sync.report && sync.report.ok && (
        <div className="srow">
          <div className="srow-main">
            <span className="srow-desc">
              上次结果：推 {sync.report.pushed} 条，拉 {sync.report.pulled} 条
              {sync.report.conflicts.length > 0
                ? `，${sync.report.conflicts.length} 张被服务器版本覆盖`
                : ''}
            </span>
          </div>
        </div>
      )}

      {sync.error && !sync.report && (
        <div className="srow">
          <div className="srow-main">
            <span className="srow-desc sync-err">{describeError(sync.error)}</span>
          </div>
        </div>
      )}

      <div className="srow">
        <div className="srow-main">
          <span className="srow-desc">
            设备 {state.deviceId.slice(0, 8)} · 共 {state.cards.filter((c) => c.deletedAt === null).length} 张卡
          </span>
        </div>
      </div>
    </SheetShell>
  )
}
