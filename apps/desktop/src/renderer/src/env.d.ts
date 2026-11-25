import type { Card, RejectedCard, Skin, SyncState } from '@timecard/shared'

export interface Prefs {
  closeToTray: boolean
}

export interface Snapshot {
  skin: Skin
  cards: Card[]
  prefs: Prefs
  /** 最近一次落盘失败原因；null = 正常 */
  saveError?: string | null
}

export interface SyncSettings {
  enabled: boolean
  serverUrl: string
  token: string
}

export interface SyncReport {
  ok: boolean
  pushed: number
  pulled: number
  conflicts: RejectedCard[]
  error: string | null
}

export interface ConnectionTest {
  ok: boolean
  version?: string
  cardCount?: number
  message?: string
  ms?: number
}

export interface SyncBundle {
  settings: SyncSettings
  state: SyncState
  report: SyncReport | null
}

export interface AddCardInput {
  title: string
  anchorAt: number
  tag?: string
}

export interface AppInfo {
  version: string
  electron: string
  chrome: string
  node: string
  dataDir: string
  dataFile: string
  quickAccelerator: string
  /** 全局快捷键是否真的注册成功（被别的程序占用时为 false） */
  quickShortcutRegistered: boolean
  platform: string
}

export interface TimecardApi {
  platform: string
  isMac: boolean
  quickAcceleratorLabel: string

  store: {
    snapshot: () => Promise<Snapshot>
    setSkin: (skin: Skin) => Promise<Snapshot>
    setPrefs: (patch: Partial<Prefs>) => Promise<Snapshot>
    toggleItem: (cardId: string, itemId: string) => Promise<Snapshot>
    toggleCardDone: (cardId: string) => Promise<Snapshot>
    addCard: (input: AddCardInput) => Promise<Snapshot>
    removeCard: (cardId: string) => Promise<Snapshot>
    moveCard: (cardId: string, anchorAt: number) => Promise<Snapshot>
    patchCard: (
      cardId: string,
      patch: { title?: string; tag?: string; items?: Array<{ id: string; text: string; done: boolean }> }
    ) => Promise<Snapshot>
    restoreCard: (cardId: string) => Promise<Snapshot>
    setArchived: (cardId: string, archived: boolean) => Promise<Snapshot>
    reset: () => Promise<Snapshot>
    clearAll: () => Promise<Snapshot>
    onChanged: (cb: (snapshot: Snapshot) => void) => () => void
  }

  info: () => Promise<AppInfo>
  openDataFolder: () => Promise<void>
  retrySave: () => Promise<{ error: string | null; lastSavedAt: number | null }>
  quitApp: () => Promise<void>
  focusMain: () => Promise<void>
  signalReady: () => void

  quick: {
    show: () => Promise<void>
    hide: () => void
    resize: (height: number) => void
    resetPosition: () => Promise<{ x: number; y: number }>
    bounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>
    openComposer: (anchorAt: number) => void
  }

  openSettings: () => Promise<void>

  sync: {
    get: () => Promise<SyncBundle>
    setSettings: (patch: Partial<SyncSettings>) => Promise<SyncBundle>
    now: () => Promise<SyncBundle>
    test: (serverUrl: string, token: string) => Promise<ConnectionTest>
    clearOutbox: () => Promise<SyncBundle>
    onChanged: (cb: (b: SyncBundle) => void) => () => void
  }


  onOpenComposer: (cb: (anchorAt: number) => void) => () => void

  minimize: () => Promise<void>
  toggleMaximize: () => Promise<void>
  close: () => Promise<void>
}

declare global {
  interface Window {
    timecard?: TimecardApi
  }
}

export {}
