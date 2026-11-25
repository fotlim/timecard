import { useSyncExternalStore } from 'react'
import { dismissToast, getToastSnapshot, runToastAction, subscribeToast } from '../toast-store'

/** 底部撤销提示条。只显示 6 秒，点「撤销」执行回调。 */
export function UndoToast(): React.JSX.Element | null {
  const toast = useSyncExternalStore(subscribeToast, getToastSnapshot, getToastSnapshot)
  if (!toast) return null

  return (
    <div className="toast" role="status">
      <span className="toast-text" title={toast.text}>
        {toast.text}
      </span>
      <button className="toast-action" onClick={runToastAction}>
        {toast.actionLabel}
      </button>
      <button className="toast-close" onClick={dismissToast} aria-label="关闭提示">
        ✕
      </button>
    </div>
  )
}
