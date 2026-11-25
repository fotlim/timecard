import { contextBridge, ipcRenderer } from 'electron'
import type { Card, RejectedCard, Skin, SyncState } from '@timecard/shared'

export interface Prefs {
  closeToTray: boolean
}

export interface Snapshot {
  skin: Skin
  cards: Card[]
  prefs: Prefs
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
  platform: string
}

const api = {
  platform: process.platform,
  isMac: process.platform === 'darwin',
  quickAcceleratorLabel: process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space',

  /* --- 数据（真源在主进程） --- */
  store: {
    snapshot: (): Promise<Snapshot> => ipcRenderer.invoke('store:snapshot'),
    setSkin: (skin: Skin): Promise<Snapshot> => ipcRenderer.invoke('store:set-skin', skin),
    setPrefs: (patch: Partial<Prefs>): Promise<Snapshot> =>
      ipcRenderer.invoke('store:set-prefs', patch),
    toggleItem: (cardId: string, itemId: string): Promise<Snapshot> =>
      ipcRenderer.invoke('store:toggle-item', cardId, itemId),
    toggleCardDone: (cardId: string): Promise<Snapshot> =>
      ipcRenderer.invoke('store:toggle-card', cardId),
    addCard: (input: AddCardInput): Promise<Snapshot> => ipcRenderer.invoke('store:add-card', input),
    removeCard: (cardId: string): Promise<Snapshot> =>
      ipcRenderer.invoke('store:remove-card', cardId),
    moveCard: (cardId: string, anchorAt: number): Promise<Snapshot> =>
      ipcRenderer.invoke('store:move-card', cardId, anchorAt),
    patchCard: (
      cardId: string,
      patch: { title?: string; tag?: string; items?: Array<{ id: string; text: string; done: boolean }> }
    ): Promise<Snapshot> => ipcRenderer.invoke('store:patch-card', cardId, patch),
    restoreCard: (cardId: string): Promise<Snapshot> =>
      ipcRenderer.invoke('store:restore-card', cardId),
    setArchived: (cardId: string, archived: boolean): Promise<Snapshot> =>
      ipcRenderer.invoke('store:set-archived', cardId, archived),
    reset: (): Promise<Snapshot> => ipcRenderer.invoke('store:reset'),
    clearAll: (): Promise<Snapshot> => ipcRenderer.invoke('store:clear-all'),

    onChanged: (cb: (snapshot: Snapshot) => void): (() => void) => {
      const handler = (_event: unknown, snapshot: Snapshot): void => cb(snapshot)
      ipcRenderer.on('store:changed', handler)
      return () => ipcRenderer.removeListener('store:changed', handler)
    }
  },

  /* --- 应用信息 / 动作 --- */
  info: (): Promise<AppInfo> => ipcRenderer.invoke('app:info'),
  openDataFolder: (): Promise<void> => ipcRenderer.invoke('app:open-data-folder'),
  retrySave: (): Promise<{ error: string | null; lastSavedAt: number | null }> =>
    ipcRenderer.invoke('app:retry-save'),
  quitApp: (): Promise<void> => ipcRenderer.invoke('app:quit'),
  focusMain: (): Promise<void> => ipcRenderer.invoke('app:focus-main'),

  /**
   * 告诉主进程「首屏数据已经画好了，可以显示窗口了」。
   * 避免用户看到「先闪一下空列表，再长出卡片」。
   */
  signalReady: (): void => ipcRenderer.send('ui:ready'),

  /* --- 浮窗 --- */
  quick: {
    show: (): Promise<void> => ipcRenderer.invoke('quick:show'),
    hide: (): void => ipcRenderer.send('quick:hide'),
    resize: (height: number): void => ipcRenderer.send('quick:resize', height),
    resetPosition: (): Promise<{ x: number; y: number }> =>
      ipcRenderer.invoke('quick:reset-position'),
    bounds: (): Promise<{ x: number; y: number; width: number; height: number } | null> =>
      ipcRenderer.invoke('quick:bounds'),
    /** 浮窗点 ＋：让主窗口在指定日期打开输入框（别丢用户刚选的那天） */
    openComposer: (anchorAt: number): void => ipcRenderer.send('quick:open-composer', anchorAt)
  },

  /* --- 设置 --- */
  openSettings: (): Promise<void> => ipcRenderer.invoke('settings:open'),

  /* --- 同步 --- */
  sync: {
    get: (): Promise<SyncBundle> => ipcRenderer.invoke('sync:get'),
    setSettings: (patch: Partial<SyncSettings>): Promise<SyncBundle> =>
      ipcRenderer.invoke('sync:set-settings', patch),
    now: (): Promise<SyncBundle> => ipcRenderer.invoke('sync:now'),
    test: (serverUrl: string, token: string): Promise<ConnectionTest> =>
      ipcRenderer.invoke('sync:test', serverUrl, token),
    clearOutbox: (): Promise<SyncBundle> => ipcRenderer.invoke('sync:clear-outbox'),
    onChanged: (cb: (b: SyncBundle) => void): (() => void) => {
      const handler = (_e: unknown, b: SyncBundle): void => cb(b)
      ipcRenderer.on('sync:changed', handler)
      return () => ipcRenderer.removeListener('sync:changed', handler)
    }
  },


  /** 主进程要求打开「挂一张」输入框 */
  onOpenComposer: (cb: (anchorAt: number) => void): (() => void) => {
    const handler = (_e: unknown, anchorAt: number): void => cb(anchorAt)
    ipcRenderer.on('ui:open-composer', handler)
    return () => ipcRenderer.removeListener('ui:open-composer', handler)
  },

  /* --- 备份 --- */
  data: {
    exportTo: (path?: string): Promise<{ ok: boolean; canceled?: boolean; path?: string; bytes?: number; error?: string }> =>
      ipcRenderer.invoke('data:export', path),
    importFrom: (
      path?: string
    ): Promise<{
      ok: boolean
      canceled?: boolean
      added?: number
      updated?: number
      skipped?: number
      path?: string
      error?: string
    }> => ipcRenderer.invoke('data:import', path)
  },

  /* --- 主窗口控制 --- */
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: (): Promise<void> => ipcRenderer.invoke('window:toggle-maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close')
}

contextBridge.exposeInMainWorld('timecard', api)
