/* ============================================================
 * 撤销提示条
 * 删除是不可逆的破坏性操作，给一个 6 秒的后悔窗口。
 * 模块级单例：主窗口和浮窗各自挂一个组件，共用同一份状态。
 * ========================================================== */

export interface ToastState {
  id: number
  text: string
  actionLabel: string
  onAction: () => void
}

let state: ToastState | null = null
let snapshot: ToastState | null = null
let seq = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

const TIMEOUT = 6000

function flush(): void {
  snapshot = state
  listeners.forEach((fn) => fn())
}

export function subscribeToast(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** 必须是稳定引用（同 menu-store 的教训） */
export function getToastSnapshot(): ToastState | null {
  return snapshot
}

export function showToast(text: string, actionLabel: string, onAction: () => void): void {
  if (timer) clearTimeout(timer)
  seq += 1
  state = { id: seq, text, actionLabel, onAction }
  flush()
  timer = setTimeout(() => {
    timer = null
    dismissToast()
  }, TIMEOUT)
}

export function dismissToast(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!state) return
  state = null
  flush()
}

export function runToastAction(): void {
  const current = state
  if (!current) return
  const run = current.onAction
  dismissToast()
  run()
}
