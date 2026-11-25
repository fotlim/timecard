import { useEffect, useRef, useState } from 'react'
import { SKINS, SKIN_LABELS } from '@timecard/shared'
import type { Skin } from '@timecard/shared'
import { useStore } from './store'
import { WeekView } from './components/WeekView'
import { TodayView } from './components/TodayView'
import { QuickPanel } from './components/QuickPanel'
import { Composer } from './components/Composer'
import { ContextMenu } from './components/ContextMenu'
import { UndoToast } from './components/UndoToast'
import { CardEditor } from './components/CardEditor'
import { SearchOverlay } from './components/SearchOverlay'
import { FloatIcon, SettingsIcon } from './components/icons'

/** 竖屏（今日）与横屏（周视图）的切换阈值 */
const WIDE_BREAKPOINT = 720

type View = 'today' | 'week' | 'quick'

/** 顶栏只放今日 / 周；浮窗是真窗口，不进这里 */
const VIEWS: Array<{ key: View; label: string }> = [
  { key: 'today', label: '今日' },
  { key: 'week', label: '周' }
]

/** 从 URL hash 读启动状态，形如 #today 或 #quick/brutal（开发与验收时用） */
function readBoot(): { view: View | null; skin: Skin | null } {
  const raw = window.location.hash.replace('#', '')
  if (!raw) return { view: null, skin: null }
  const parts = raw.split(/[/,]/).filter(Boolean)
  const view = parts.find((p) => p === 'today' || p === 'week' || p === 'quick')
  const skin = parts.find((p) => (SKINS as readonly string[]).includes(p)) as Skin | undefined
  return { view: (view as View) ?? null, skin: skin ?? null }
}

export default function App(): React.JSX.Element {
  const store = useStore()
  const boot = readBoot()

  // 默认竖屏 = 今日。窗口拉宽过阈值自动切周视图（和 noteapp 的大窗/中窗一个套路）
  const [wide, setWide] = useState(() => window.innerWidth >= WIDE_BREAKPOINT)
  const [forced, setForced] = useState<View | null>(boot.view)
  const [weekOffset, setWeekOffset] = useState(0)
  const [composerAt, setComposerAt] = useState<number | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)

  useEffect(() => {
    const onResize = (): void => setWide(window.innerWidth >= WIDE_BREAKPOINT)
    window.addEventListener('resize', onResize)
    onResize()
    return () => window.removeEventListener('resize', onResize)
  }, [])

  // Ctrl/⌘ + F 打开全库搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // 首屏数据到位后告诉主进程可以显示窗口了（先画好再露面，不闪空态）
  useEffect(() => {
    if (store.ready) window.timecard?.signalReady()
  }, [store.ready])

  // 主进程右键菜单里点「挂一张」时，让它把输入框弹出来
  useEffect(() => {
    const off = window.timecard?.onOpenComposer((anchorAt) => setComposerAt(anchorAt))
    return () => off?.()
  }, [])

  // 启动时按 hash 覆盖皮肤（开发 / 截图验收用）
  // 必须等主进程数据到位后再比，否则比的是 useState 的初值，永远相等、永远不生效
  const appliedBootSkin = useRef(false)
  useEffect(() => {
    if (appliedBootSkin.current) return
    if (!boot.skin || !store.ready) return
    appliedBootSkin.current = true
    if (boot.skin !== store.skin) store.setSkin(boot.skin)
  }, [boot.skin, store.ready, store.skin, store])

  const view = forced ?? (wide ? 'week' : 'today')

  return (
    <div className={`shell${view === 'today' ? ' shell-portrait' : ''}`}>
      <ContextMenu />
      <UndoToast />
      <CardEditor store={store} />
      <SearchOverlay cards={store.cards} open={searchOpen} onClose={() => setSearchOpen(false)} />
      <header className="titlebar">
        <div className="skinswitch" role="group" aria-label="皮肤切换">
          {SKINS.map((skin) => (
            <button
              key={skin}
              data-skin={skin}
              className={store.skin === skin ? 'on' : ''}
              title={SKIN_LABELS[skin]}
              aria-label={SKIN_LABELS[skin]}
              onClick={() => store.setSkin(skin as Skin)}
            />
          ))}
        </div>

        <span className="spacer" />

        <button
          className="tb-icon"
          onClick={() => setSearchOpen(true)}
          title="搜索卡片（Ctrl+F）"
          aria-label="搜索卡片"
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
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
          className="tb-icon"
          onClick={() => void window.timecard?.quick.show()}
          title={`打开浮窗（${window.timecard?.quickAcceleratorLabel ?? 'Ctrl+Shift+Space'}）`}
          aria-label="打开浮窗"
        >
          <FloatIcon />
        </button>

        {store.sync?.settings?.enabled && (
          <span
            className={`tb-sync ${store.sync?.state?.phase ?? 'idle'}`}
            title={
              store.sync?.state?.error
                ? `同步出错：${store.sync?.state?.error}`
                : store.sync?.state.phase === 'syncing'
                  ? '正在同步…'
                  : store.sync?.state?.pending
                    ? `${store.sync?.state?.pending} 条待推送`
                    : '已同步'
            }
            aria-hidden="true"
          />
        )}

        <button
          className="tb-icon"
          onClick={() => void window.timecard?.openSettings()}
          title="设置"
          aria-label="设置"
        >
          <SettingsIcon />
        </button>

        <nav className="tb-seg" aria-label="视图切换">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              className={view === v.key ? 'on' : ''}
              onClick={() => setForced(v.key)}
            >
              {v.label}
            </button>
          ))}
        </nav>
      </header>

      {store.saveError && (
        <div className="save-error" role="alert">
          <span className="save-error-txt">
            本地保存失败：{store.saveError} —— 改动可能没落盘
          </span>
          <button
            className="save-error-btn"
            onClick={() => {
              void window.timecard?.retrySave()
            }}
          >
            重试
          </button>
        </div>
      )}

      <main className="stage">
        {view === 'week' && (
          <WeekView
            cards={store.cards}
            store={store}
            weekOffset={weekOffset}
            onWeekOffset={setWeekOffset}
            onToggleItem={store.toggleItem}
            onAddCard={setComposerAt}
            onBackToToday={() => setForced('today')}
          />
        )}
        {view === 'today' && (
          <TodayView
            cards={store.cards}
            store={store}
            onToggleItem={store.toggleItem}
            onAddCard={setComposerAt}
          />
        )}
        {view === 'quick' && (
          <QuickPanel
            cards={store.cards}
            onToggleCardDone={store.toggleCardDone}
            onAddCard={setComposerAt}
          />
        )}
      </main>

      {composerAt !== null && (
        <Composer
          anchorAt={composerAt}
          onCancel={() => setComposerAt(null)}
          onSubmit={(title, tag) => {
            store.addCard(title, composerAt, tag)
            setComposerAt(null)
          }}
        />
      )}
    </div>
  )
}
