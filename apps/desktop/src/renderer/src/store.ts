import { useCallback, useEffect, useState } from 'react'
import type { Card, Skin } from '@timecard/shared'
import type { Prefs, SyncBundle, TimecardApi } from './env'

export interface Store {
  skin: Skin
  cards: Card[]
  prefs: Prefs
  /** 同步状态（含配置、阶段、上次结果） */
  sync: SyncBundle | null
  /** 本地落盘失败原因；null = 正常。非空时界面要提示用户 */
  saveError: string | null
  /** 首次从主进程取到数据之前为 false */
  ready: boolean
  setSkin: (skin: Skin) => void
  setPrefs: (patch: Partial<Prefs>) => void
  toggleItem: (cardId: string, itemId: string) => void
  /** 整卡打勾：全勾完就清空，否则全勾上 */
  toggleCardDone: (cardId: string) => void
  addCard: (title: string, anchorAt: number, tag?: string) => void
  removeCard: (cardId: string) => void
  moveCard: (cardId: string, anchorAt: number) => void
  patchCard: (
    cardId: string,
    patch: {
      title?: string
      tag?: string
      color?: string
      items?: Array<{ id: string; text: string; done: boolean }>
    }
  ) => void
  restoreCard: (cardId: string) => void
  /** 归档 / 取消归档 */
  setArchived: (cardId: string, archived: boolean) => void
  resetAll: () => void
  clearAll: () => void
}

function bridge(): TimecardApi {
  const api = window.timecard
  if (!api) throw new Error('window.timecard 不存在：preload 没加载成功')
  return api
}

const DEFAULT_PREFS: Prefs = { closeToTray: true }

/**
 * 渲染进程侧的薄壳。
 * 数据真源在主进程（src/main/store.ts），这里只做订阅 + 转发，
 * 这样主窗口、浮窗、设置窗口看到的是同一份数据。
 */
export function useStore(): Store {
  const [skin, setSkinState] = useState<Skin>('organic')
  const [cards, setCards] = useState<Card[]>([])
  const [prefs, setPrefsState] = useState<Prefs>(DEFAULT_PREFS)
  const [sync, setSyncState] = useState<SyncBundle | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    const api = bridge()
    let alive = true

    void api.store.snapshot().then((snapshot) => {
      if (!alive) return
      setSkinState(snapshot.skin)
      setCards(snapshot.cards)
      setPrefsState(snapshot.prefs ?? DEFAULT_PREFS)
      setSaveError(snapshot.saveError ?? null)
      setReady(true)
    })

    const off = api.store.onChanged((snapshot) => {
      if (!alive) return
      setSkinState(snapshot.skin)
      setCards(snapshot.cards)
      setPrefsState(snapshot.prefs ?? DEFAULT_PREFS)
      setSaveError(snapshot.saveError ?? null)
    })

    return () => {
      alive = false
      off()
    }
  }, [])

  // 同步状态：主进程主动推，渲染层只订阅
  useEffect(() => {
    const api = bridge()
    void api.sync.get().then(setSyncState)
    const off = api.sync.onChanged(setSyncState)
    return off
  }, [])

  // 皮肤同步到 html[data-theme]
  useEffect(() => {
    document.documentElement.dataset.theme = skin
  }, [skin])

  const setSkin = useCallback((next: Skin) => {
    setSkinState(next) // 先本地切换，避免等 IPC 时的闪动
    void bridge().store.setSkin(next)
  }, [])

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    setPrefsState((prev) => ({ ...prev, ...patch }))
    void bridge().store.setPrefs(patch)
  }, [])

  const toggleItem = useCallback((cardId: string, itemId: string) => {
    void bridge().store.toggleItem(cardId, itemId)
  }, [])

  const toggleCardDone = useCallback((cardId: string) => {
    void bridge().store.toggleCardDone(cardId)
  }, [])

  const addCard = useCallback((title: string, anchorAt: number, tag = '') => {
    if (!title.trim()) return
    void bridge().store.addCard({ title, anchorAt, tag })
  }, [])

  const removeCard = useCallback((cardId: string) => {
    void bridge().store.removeCard(cardId)
  }, [])

  const moveCard = useCallback((cardId: string, anchorAt: number) => {
    void bridge().store.moveCard(cardId, anchorAt)
  }, [])

  const patchCard = useCallback(
    (
      cardId: string,
      patch: {
        title?: string
        tag?: string
        color?: string
        items?: Array<{ id: string; text: string; done: boolean }>
      }
    ) => {
      void bridge().store.patchCard(cardId, patch)
    },
    []
  )

  const restoreCard = useCallback((cardId: string) => {
    void bridge().store.restoreCard(cardId)
  }, [])

  const setArchived = useCallback((cardId: string, archived: boolean) => {
    void bridge().store.setArchived(cardId, archived)
  }, [])

  const resetAll = useCallback(() => {
    void bridge().store.reset()
  }, [])

  const clearAll = useCallback(() => {
    void bridge().store.clearAll()
  }, [])

  return {
    skin,
    cards,
    prefs,
    sync,
    saveError,
    ready,
    setSkin,
    setPrefs,
    toggleItem,
    toggleCardDone,
    addCard,
    removeCard,
    moveCard,
    patchCard,
    restoreCard,
    setArchived,
    resetAll,
    clearAll
  }
}
