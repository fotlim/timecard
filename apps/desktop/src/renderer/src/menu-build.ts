import { addDays, dayKey, startOfDay, WEEKDAY_LABELS, weekdayIndex } from '@timecard/shared'
import type { Card } from '@timecard/shared'
import type { Store } from './store'
import type { MenuItem } from './menu-store'
import { closeMenu } from './menu-store'
import { showToast } from './toast-store'
import { openEditor } from './editor-store'

/** 包装一下：点完自动关菜单 */
function act(fn: () => void): () => void {
  return () => {
    closeMenu()
    fn()
  }
}

/**
 * 删除 = 软删（留墓碑）+ 6 秒撤销窗口。
 * 右键菜单里一点就没、又没有任何恢复入口，太危险了。
 */
function deleteWithUndo(card: Card, store: Store): () => void {
  return act(() => {
    store.removeCard(card.id)
    showToast(`已删除「${card.title}」`, '撤销', () => store.restoreCard(card.id))
  })
}

const dayLabel = (at: number): string =>
  `${WEEKDAY_LABELS[weekdayIndex(at)]} · ${new Date(at).getDate()}`

/**
 * 判断两个时间戳是不是「同一天」。
 * 千万别用 Math.floor(ts / 86400000) —— 那是 UTC 的天数，
 * 在东八区会把「11-23 09:30」和「11-24 00:00」算成同一 UTC 日，
 * 导致「改到今天」被误禁用。必须用 dayKey（本地时区）。
 */
const sameDay = (a: number, b: number): boolean => dayKey(a) === dayKey(b)

/** 「改到哪天」的四个快捷选项 */
function moveOptions(card: Card, store: Store): MenuItem[] {
  const today = startOfDay(Date.now())
  const options: Array<{ label: string; at: number }> = [
    { label: `今天（${dayLabel(today)}）`, at: today },
    { label: `明天（${dayLabel(addDays(today, 1))}）`, at: addDays(today, 1) },
    { label: `后天（${dayLabel(addDays(today, 2))}）`, at: addDays(today, 2) },
    { label: `下周同一天（${dayLabel(addDays(today, 7))}）`, at: addDays(today, 7) }
  ]
  return options.map((o) => ({
    kind: 'item' as const,
    label: o.label,
    disabled: sameDay(o.at, card.anchorAt),
    run: act(() => store.moveCard(card.id, o.at))
  }))
}

/* ============================================================
 * 卡片菜单（主窗口 / 周视图）
 * ========================================================== */

export function buildCardMenu(card: Card, store: Store): MenuItem[] {
  const allDone = card.items.length > 0 && card.items.every((i) => i.done)

  return [
    {
      kind: 'note',
      label: `挂在 ${dayKey(card.anchorAt)}`
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: allDone ? '取消全部打勾' : '全部打勾',
      run: act(() => store.toggleCardDone(card.id))
    },
    { kind: 'item', label: '编辑这张卡…', run: act(() => openEditor(card.id)) },
    {
      kind: 'item',
      label: card.status === 'archived' ? '取消归档' : '归档',
      run: act(() => store.setArchived(card.id, card.status !== 'archived'))
    },
    { kind: 'sep' },
    ...moveOptions(card, store),
    { kind: 'sep' },
    {
      kind: 'item',
      label: '删除这张卡',
      danger: true,
      run: deleteWithUndo(card, store)
    },
    { kind: 'sep' },
    { kind: 'item', label: '打开浮窗', run: act(() => void window.timecard?.quick.show()) },
    { kind: 'item', label: '设置…', run: act(() => void window.timecard?.openSettings()) }
  ]
}

/* ============================================================
 * 空白处菜单
 * ========================================================== */

export function buildBlankMenu(
  at: number,
  store: Store,
  onComposer: (anchorAt: number) => void
): MenuItem[] {
  const live = store.cards.filter((c) => c.deletedAt === null)
  return [
    {
      kind: 'item',
      label: `在这一天挂一张（${dayLabel(at)}）`,
      run: act(() => onComposer(at))
    },
    { kind: 'sep' },
    { kind: 'item', label: '打开浮窗', run: act(() => void window.timecard?.quick.show()) },
    { kind: 'item', label: '设置…', run: act(() => void window.timecard?.openSettings()) },
    {
      kind: 'item',
      label: '打开数据文件夹',
      run: act(() => void window.timecard?.openDataFolder())
    },
    { kind: 'sep' },
    { kind: 'note', label: `共 ${live.length} 张卡` },
    { kind: 'note', label: `今天是 ${dayLabel(startOfDay(Date.now()))}` },
    { kind: 'sep' },
    { kind: 'item', label: '退出应用', run: act(() => void window.timecard?.quitApp()) }
  ]
}

/* ============================================================
 * 浮窗行菜单（精简版）
 * ========================================================== */

export function buildQuickRowMenu(card: Card, store: Store): MenuItem[] {
  const allDone = card.items.length > 0 && card.items.every((i) => i.done)
  const today = startOfDay(Date.now())

  return [
    { kind: 'note', label: `挂在 ${dayKey(card.anchorAt)}` },
    { kind: 'sep' },
    {
      kind: 'item',
      label: allDone ? '取消全部打勾' : '全部打勾',
      run: act(() => store.toggleCardDone(card.id))
    },
    {
      kind: 'item',
      label: '改到今天',
      disabled: sameDay(card.anchorAt, today),
      run: act(() => store.moveCard(card.id, today))
    },
    {
      kind: 'item',
      label: '改到明天',
      disabled: sameDay(card.anchorAt, addDays(today, 1)),
      run: act(() => store.moveCard(card.id, addDays(today, 1)))
    },
    { kind: 'sep' },
    {
      kind: 'item',
      label: '删除这张卡',
      danger: true,
      run: deleteWithUndo(card, store)
    }
  ]
}
