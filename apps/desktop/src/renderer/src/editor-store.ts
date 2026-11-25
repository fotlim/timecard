/**
 * 卡片编辑器：谁在编辑。
 * 和 menu-store 一样用模块级单例，免得把 openEditor 一层层透传。
 */

let editingId: string | null = null
let snapshot: string | null = null
const listeners = new Set<() => void>()

function emit(): void {
  snapshot = editingId
  listeners.forEach((fn) => fn())
}

export function subscribeEditor(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function getEditorSnapshot(): string | null {
  return snapshot
}

export function openEditor(cardId: string): void {
  editingId = cardId
  emit()
}

export function closeEditor(): void {
  editingId = null
  emit()
}
