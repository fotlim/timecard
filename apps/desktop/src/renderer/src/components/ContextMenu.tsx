import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { closeMenu, getMenuSnapshot, subscribeMenu } from '../menu-store'

/**
 * 自绘右键菜单。
 * 放在 body 的 portal 里，这样不会被父级 overflow:hidden 裁掉
 * （今日视图的 .screen 就是 overflow:hidden）。
 */
export function ContextMenu(): React.JSX.Element | null {
  const menu = useSyncExternalStore(subscribeMenu, getMenuSnapshot, getMenuSnapshot)
  const ref = useRef<HTMLDivElement>(null)

  // 贴边时把菜单拉回可视区
  useLayoutEffect(() => {
    const el = ref.current
    if (!el || !menu) return
    const pad = 8
    const r = el.getBoundingClientRect()
    let left = menu.x
    let top = menu.y
    if (left + r.width > window.innerWidth - pad) left = window.innerWidth - r.width - pad
    if (top + r.height > window.innerHeight - pad) top = window.innerHeight - r.height - pad
    el.style.left = `${Math.max(pad, left)}px`
    el.style.top = `${Math.max(pad, top)}px`
  }, [menu])

  // 点别处 / Esc / 滚轮 / 失焦 都关掉
  useEffect(() => {
    if (!menu) return

    const onDown = (e: MouseEvent): void => {
      if (ref.current && ref.current.contains(e.target as Node)) return
      closeMenu()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        closeMenu()
      }
    }
    const onScroll = (): void => closeMenu()
    const onBlur = (): void => closeMenu()

    // mousedown 用捕获阶段，保证先于卡片自身的点击
    window.addEventListener('mousedown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('mousedown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('blur', onBlur)
    }
  }, [menu])

  if (!menu) return null

  return createPortal(
    <div
      className="ctxmenu"
      ref={ref}
      role="menu"
      style={{ left: menu.x, top: menu.y }}
      onContextMenu={(e) => e.preventDefault()}
    >
      {menu.items.map((item, i) => {
        if (item.kind === 'sep') {
          return <div className="ctx-sep" key={`s${i}`} />
        }
        if (item.kind === 'note') {
          return (
            <div className="ctx-note" key={`n${i}`}>
              {item.label}
            </div>
          )
        }
        return (
          <button
            key={`i${i}`}
            className={`ctx-item${item.danger ? ' danger' : ''}`}
            role="menuitem"
            disabled={item.disabled}
            onClick={item.run}
          >
            {item.label}
          </button>
        )
      })}
    </div>,
    document.body
  )
}
