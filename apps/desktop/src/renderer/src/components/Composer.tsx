import { useEffect, useRef, useState } from 'react'
import { clockLabel, dayKey, isSameDay, WEEKDAY_LABELS, weekdayIndex } from '@timecard/shared'

interface ComposerProps {
  anchorAt: number
  onCancel: () => void
  onSubmit: (title: string, tag: string) => void
}

/** 「今天 / 明天 / 昨天 / 周四」 这类人话 */
function dayLabel(anchorAt: number): string {
  const now = Date.now()
  if (isSameDay(anchorAt, now)) return '今天'
  if (isSameDay(anchorAt, now + 86_400_000)) return '明天'
  if (isSameDay(anchorAt, now - 86_400_000)) return '昨天'
  return WEEKDAY_LABELS[weekdayIndex(anchorAt)]
}

export function Composer({ anchorAt, onCancel, onSubmit }: ComposerProps): React.JSX.Element {
  const [title, setTitle] = useState('')
  const [tag, setTag] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      // 输入法组字中按 Esc 只是取消候选，别把整个输入框关掉
      if (e.isComposing) return
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const submit = (): void => {
    if (!title.trim()) return
    onSubmit(title, tag)
  }

  return (
    <div className="composer" onMouseDown={onCancel}>
      <div className="composer-box" onMouseDown={(e) => e.stopPropagation()}>
        <div className="composer-meta">
          <span className="composer-date">
            {dayLabel(anchorAt)} · {dayKey(anchorAt)} · {clockLabel(anchorAt)}
          </span>
        </div>

        <input
          ref={inputRef}
          className="composer-input"
          placeholder="要挂一张什么卡…"
          value={title}
          maxLength={60}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') submit()
          }}
        />

        <input
          className="composer-input small"
          placeholder="分类，如「家庭」「工作」（可留空）"
          value={tag}
          maxLength={18}
          onChange={(e) => setTag(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return
            if (e.key === 'Enter') submit()
          }}
        />

        <div className="composer-actions">
          <button className="ghost" onClick={onCancel}>
            取消
          </button>
          <button className="btn-accent" onClick={submit} disabled={!title.trim()}>
            ＋ 挂上
          </button>
        </div>
      </div>
    </div>
  )
}
