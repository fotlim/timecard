/* ============================================================
 * 自绘右键菜单：模块级单例 + 订阅
 * 不用 props 一层层传，任何地方 import 完直接 openMenu(...) 就能弹。
 * ========================================================== */

export type MenuItem =
  | { kind: 'item'; label: string; run: () => void; disabled?: boolean; danger?: boolean }
  | { kind: 'sep' }
  | { kind: 'note'; label: string }

export interface MenuState {
  x: number
  y: number
  items: MenuItem[]
}

let state: MenuState | null = null
const listeners = new Set<() => void>()

/**
 * useSyncExternalStore 用 Object.is 比较快照。
 * 每次都 new 一个对象会被判定成「一直在变」，React 直接罢工。
 * 所以这里缓存住，只在真的变了才换引用。
 */
let snapshot: MenuState | null = null

function emit(): void {
  snapshot = state ? { ...state } : null
  listeners.forEach((fn) => fn())
}

export function subscribeMenu(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 必须是稳定引用，否则 useSyncExternalStore 会无限重渲染 */
export function getMenuSnapshot(): MenuState | null {
  return snapshot
}

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  if (items.length === 0) return
  state = { x, y, items }
  emit()
}

export function closeMenu(): void {
  if (!state) return
  state = null
  emit()
}

export function isMenuOpen(): boolean {
  return state !== null
}

/** 从事件里取坐标并弹菜单，顺手挡掉默认行为 */
export function openMenuFromEvent(
  e: React.MouseEvent | MouseEvent,
  items: MenuItem[]
): void {
  e.preventDefault()
  e.stopPropagation()
  openMenu(e.clientX, e.clientY, items)
}
