import { useEffect, useRef, useState } from 'react'
import type { Card } from '@timecard/shared'
import { openEditor } from '../editor-store'

/**
 * 全库搜索浮层（Ctrl+F 或标题栏放大镜打开）。
 *
 * 和手机端搜索同一套逻辑：按标题 / 分类搜全部卡片，点结果直接开编辑器。
 * 桌面端不复用手机组件（两套渲染层不同），但交互与文案保持一致。
 */
function dayText(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export function SearchOverlay({
  cards,
  open,
  onClose
}: {
  cards: Card[]
  open: boolean
  onClose: () => void
}): React.JSX.Element | null {
  const [q, setQ] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) {
      setQ('')
      return
    }
    const t = setTimeout(() => inputRef.current?.focus(), 30)
    return () => clearTimeout(t)
  }, [open])

  if (!open) return null

  const query = q.trim().toLowerCase()
  const results = query
    ? cards
        .filter(
          (c) =>
            c.deletedAt === null &&
            (c.title.toLowerCase().includes(query) ||
              (c.tag || '').toLowerCase().includes(query))
        )
        .sort((a, b) => b.anchorAt - a.anchorAt)
        .slice(0, 60)
    : []

  const pick = (c: Card): void => {
    openEditor(c.id)
    onClose()
  }

  return (
    <div className="tsearch" onMouseDown={onClose}>
      <div className="tsearch-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="tsearch-head">
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
          <input
            ref={inputRef}
            value={q}
            maxLength={40}
            placeholder="搜索卡片（标题 / 分类）…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && results[0]) pick(results[0])
              else if (e.key === 'Escape') onClose()
            }}
          />
          <kbd className="tsearch-esc">Esc</kbd>
        </div>
        <div className="tsearch-list">
          {query === '' ? (
            <p className="tsearch-hint">输入关键词，全库找卡</p>
          ) : results.length === 0 ? (
            <p className="tsearch-hint">没有匹配的卡片</p>
          ) : (
            results.map((c) => (
              <button key={c.id} className="tsearch-row" onClick={() => pick(c)}>
                <span className="tsearch-row-main">
                  <span className="tsearch-row-title">{c.title || '（无标题）'}</span>
                  <span className="tsearch-row-meta">
                    {dayText(c.anchorAt)}
                    {c.tag ? ' · ' + c.tag : ''}
                    {c.status === 'archived'
                      ? ' · 已归档'
                      : c.status === 'done'
                        ? ' · 已完成'
                        : ''}
                  </span>
                </span>
                <span className="tsearch-row-day">{new Date(c.anchorAt).getDate()}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}
