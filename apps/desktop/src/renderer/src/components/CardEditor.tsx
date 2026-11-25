import { useEffect, useMemo, useRef, useState } from 'react'
import { addDays, createCardItem, dayKey, isSameDay, startOfDay, WEEKDAY_LABELS, weekdayIndex } from '@timecard/shared'
import type { Card, CardItem } from '@timecard/shared'
import { closeEditor, getEditorSnapshot, subscribeEditor } from '../editor-store'
import { useSyncExternalStore } from 'react'
import type { Store } from '../store'

/**
 * 卡片编辑弹层。
 * 条目整表提交 —— 增删改都在本地数组里做，点「保存」一次性 patch，
 * 少一堆 IPC，也不会出现改一半的中间态。
 */
export function CardEditor({ store }: { store: Store }): React.JSX.Element | null {
  const editingId = useSyncExternalStore(subscribeEditor, getEditorSnapshot, getEditorSnapshot)
  const card = editingId ? store.cards.find((c) => c.id === editingId) ?? null : null

  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('')
  const [items, setItems] = useState<CardItem[]>([])
  const [anchorAt, setAnchorAt] = useState(0)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const titleRef = useRef<HTMLInputElement>(null)
  const seededFor = useRef<string | null>(null)

  // 打开时把卡片灌进本地草稿（同一个卡只灌一次，别覆盖用户正在改的内容）
  useEffect(() => {
    if (!card) return
    if (seededFor.current === card.id) return
    seededFor.current = card.id
    setTitle(card.title)
    setTag(card.tag)
    setItems(card.items.map((i) => ({ ...i })))
    setAnchorAt(card.anchorAt)
    setConfirmDelete(false)
    requestAnimationFrame(() => titleRef.current?.focus())
  }, [card])

  useEffect(() => {
    if (!editingId) seededFor.current = null
  }, [editingId])

  // Esc 关闭
  useEffect(() => {
    if (!editingId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeEditor()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [editingId])

  const today = useMemo(() => startOfDay(Date.now()), [])
  if (!card) return null

  const save = (): void => {
    if (!title.trim()) {
      titleRef.current?.focus()
      return
    }
    store.patchCard(card.id, { title, tag, items })
    // 日期没改就别再发一次 moveCard：白跑一条 IPC、多一次 rev 跳变，
    // 还会在 Outbox 里多排一条没必要的更新
    if (anchorAt !== card.anchorAt) store.moveCard(card.id, anchorAt)
    closeEditor()
  }

  const addItem = (): void => {
    const item = createCardItem('')
    setItems((prev) => [...prev, item])
    // 新条目自动聚焦
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLInputElement>(`[data-item-input="${item.id}"]`)
      el?.focus()
    })
  }

  const removeItem = (id: string): void => {
    setItems((prev) => prev.filter((i) => i.id !== id))
  }

  const dateLabel = (at: number): string => {
    if (isSameDay(at, today)) return '今天'
    if (isSameDay(at, addDays(today, 1))) return '明天'
    if (isSameDay(at, addDays(today, 2))) return '后天'
    return `${WEEKDAY_LABELS[weekdayIndex(at)]} ${new Date(at).getDate()}`
  }

  const dateChips: Array<{ label: string; at: number }> = [
    { label: '今天', at: today },
    { label: '明天', at: addDays(today, 1) },
    { label: '后天', at: addDays(today, 2) },
    { label: '下周', at: addDays(today, 7) }
  ]

  return (
    <div className="editor" onMouseDown={closeEditor}>
      <div className="editor-box" onMouseDown={(e) => e.stopPropagation()}>
        <header className="editor-head">
          <span className="editor-kicker">编辑卡片</span>
          <span className="editor-date">
            {dateLabel(anchorAt)} · {dayKey(anchorAt)}
          </span>
          <button className="editor-x" onClick={closeEditor} aria-label="关闭">
            ✕
          </button>
        </header>

        <input
          ref={titleRef}
          className="editor-title"
          value={title}
          maxLength={60}
          placeholder="卡片标题"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            // 组字态回车 = 选词，不是保存
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') save()
          }}
        />

        <input
          className="editor-tag"
          value={tag}
          maxLength={18}
          placeholder="分类，如「家庭」「工作」（可留空）"
          onChange={(e) => setTag(e.target.value)}
        />

        <div className="editor-dates">
          {dateChips.map((c) => (
            <button
              key={c.label}
              className={`editor-chip${isSameDay(anchorAt, c.at) ? ' on' : ''}`}
              onClick={() => setAnchorAt(c.at)}
            >
              {c.label}
            </button>
          ))}
        </div>

        <div className="editor-items">
          {items.map((item) => (
            <div key={item.id} className="editor-item">
              <input
                type="checkbox"
                checked={item.done}
                onChange={() =>
                  setItems((prev) =>
                    prev.map((i) => (i.id === item.id ? { ...i, done: !i.done } : i))
                  )
                }
                aria-label="完成"
              />
              <input
                className="editor-item-text"
                data-item-input={item.id}
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
                className="editor-item-del"
                onClick={() => removeItem(item.id)}
                aria-label="删除条目"
                title="删除这一条"
              >
                ✕
              </button>
            </div>
          ))}

          <button className="editor-add" onClick={addItem}>
            ＋ 加一条
          </button>
        </div>

        <footer className="editor-foot">
          <button
            className="editor-btn"
            onClick={() => {
              store.setArchived(card.id, card.status !== 'archived')
              closeEditor()
            }}
            title={
              card.status === 'archived'
                ? '放回时间轴'
                : '从时间轴摘下，但搜索里还能找到'
            }
          >
            {card.status === 'archived' ? '取消归档' : '归档'}
          </button>

          {confirmDelete ? (
            <span className="editor-confirm">
              <button
                className="editor-btn danger"
                onClick={() => {
                  store.removeCard(card.id)
                  closeEditor()
                }}
              >
                确定删除
              </button>
              <button className="editor-btn" onClick={() => setConfirmDelete(false)}>
                取消
              </button>
            </span>
          ) : (
            <button className="editor-btn danger-ghost" onClick={() => setConfirmDelete(true)}>
              删除这张卡
            </button>
          )}

          <span className="editor-spacer" />

          <button className="editor-btn" onClick={closeEditor}>
            取消
          </button>
          <button className="editor-btn primary" onClick={save} disabled={!title.trim()}>
            保存
          </button>
        </footer>
      </div>
    </div>
  )
}
