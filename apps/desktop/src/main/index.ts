import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  shell,
  Tray
} from 'electron'
import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { store } from './store'
import {
  onSyncStateChange,
  report,
  scheduleAutoSync,
  startPolling,
  state as syncState,
  syncNow,
  testConnection
} from './sync'

import { SKINS } from '@timecard/shared'
import type { Skin } from '@timecard/shared'

// 必须在 app ready 之前设置，否则 userData 会落到 @timecard/desktop 这种带斜杠的目录
app.setName('Timecard')

/*
 * 数据目录隔离（验证脚本 / 多开调试用）。
 *
 * 之前的验收脚本直接操作 %APPDATA%\Timecard\timecard.json —— 它们为了造场景
 * 会删掉真人的数据文件，跑一次测试就把用户配置和卡片清空，而且没法还原。
 * 现在脚本只要设 TIMECARD_DATA_DIR=<临时目录> 就完全隔离。
 */
const DATA_DIR_OVERRIDE = process.env['TIMECARD_DATA_DIR']
if (DATA_DIR_OVERRIDE) {
  try {
    mkdirSync(DATA_DIR_OVERRIDE, { recursive: true })
    app.setPath('userData', DATA_DIR_OVERRIDE)
  } catch (error) {
    console.warn('[app] 无法切到指定数据目录，继续用默认目录', error)
  }
}

/*
 * 单实例锁。
 *
 * 双击两次图标 = 两个进程同时读写同一个 timecard.json，
 * 后落盘的会把先落盘的整份覆盖掉（卡片、窗位、Outbox 一起丢）。
 * 拿不到锁就立刻退出；已有的实例会把窗口叫到前台（见 whenReady 里的 second-instance）。
 */
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
}

const isDev = !!process.env['ELECTRON_RENDERER_URL']
const RENDERER_URL = process.env['ELECTRON_RENDERER_URL'] ?? ''
const BOOT = process.env['TIMECARD_BOOT'] ?? ''

// 竖屏优先：默认就是一屏一天的卡片列表（样稿的 392 宽手机稿）
const MAIN_WIDTH = 420
const MAIN_HEIGHT = 760
const MAIN_MIN_WIDTH = 380
const MAIN_MIN_HEIGHT = 620
const QUICK_WIDTH = 380
const QUICK_DEFAULT_HEIGHT = 320
const SETTINGS_WIDTH = 520
const SETTINGS_HEIGHT = 640

const TITLEBAR_HEIGHT = 34

/** 三种皮肤的窗口底色，避免启动白屏闪烁 */
const PAPER: Record<string, string> = {
  organic: '#f1ebdf',
  brutal: '#f6f1e2',
  neo: '#e7e6f1'
}

/** 标题栏里系统按钮（— □ ✕）的符号色，跟皮肤墨色一致 */
const SYMBOL: Record<string, string> = {
  organic: '#2b2620',
  brutal: '#141310',
  neo: '#4a4760'
}

/** 全局唤起浮窗的快捷键（Windows 上是 Ctrl+Shift+Space） */
const QUICK_ACCELERATOR = 'CommandOrControl+Shift+Space'
const QUICK_ACCELERATOR_LABEL =
  process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl+Shift+Space'

let mainWindow: BrowserWindow | null = null
let quickWindow: BrowserWindow | null = null
/** 浮窗页面是否已渲染完（懒创建时第一次 show 不能抢在加载前） */
let quickReady = false
/** 有唤起请求在等浮窗加载完成 */
let quickPendingShow = false
let settingsWindow: BrowserWindow | null = null
let tray: Tray | null = null

/** 浮窗上次被拖到的位置；null 表示还没拖过 */
let lastQuickPos: { x: number; y: number } | null = null

/** 真正退出时置 true，用来区分「关闭窗口」和「退出应用」 */
let quitting = false
/** 全局快捷键是否注册成功（被别的程序占用时为 false），设置页据此如实展示 */
let shortcutRegistered = false
/** 托盘气泡只提示一次 */
let trayHintShown = false

function isShotMode(): boolean {
  return !!(
    process.env['TIMECARD_SHOT'] ||
    process.env['TIMECARD_SHOT_QUICK'] ||
    process.env['TIMECARD_SHOT_SETTINGS']
  )
}

/* ============================================================
 * 渲染层加载
 * ========================================================== */

type Page = 'index' | 'quick' | 'settings'

function preloadPath(): string {
  return join(__dirname, '../preload/index.js')
}

function loadRenderer(win: BrowserWindow, page: Page, hash?: string): void {
  if (isDev && RENDERER_URL) {
    void win.loadURL(`${RENDERER_URL}/${page}.html${hash ? `#${hash}` : ''}`)
  } else {
    void win.loadFile(join(__dirname, `../renderer/${page}.html`), {
      hash: hash || undefined
    })
  }
}

/* ============================================================
 * 主窗口
 * ========================================================== */

const WIDE_SHOT_WIDTH = 1000
const WIDE_SHOT_HEIGHT = 760

function createMainWindow(): void {
  if (mainWindow) {
    mainWindow.show()
    mainWindow.focus()
    return
  }

  const wideShot = process.env['TIMECARD_WIDE'] === '1'
  const rawSaved = wideShot ? null : store.getWindowState()
  // 上次的坐标可能在屏外（拔了副屏 / 改分辨率）。先证明它在屏内，否则回主屏居中：
  // 不校验的话窗口会"启动成功但看不见"，用户只能去改 json。
  // 没有记过坐标（只存了尺寸）也允许用，那样交给系统居中。
  const savedRect =
    rawSaved && rawSaved.x !== undefined && rawSaved.y !== undefined
      ? { x: rawSaved.x, y: rawSaved.y, width: rawSaved.width, height: rawSaved.height }
      : null
  const saved = rawSaved && (!savedRect || isOnScreen(savedRect)) ? rawSaved : null

  mainWindow = new BrowserWindow({
    width: saved ? Math.max(MAIN_MIN_WIDTH, saved.width) : wideShot ? WIDE_SHOT_WIDTH : MAIN_WIDTH,
    height: saved
      ? Math.max(MAIN_MIN_HEIGHT, saved.height)
      : wideShot
        ? WIDE_SHOT_HEIGHT
        : MAIN_HEIGHT,
    ...(saved?.x !== undefined && saved?.y !== undefined
      ? { x: saved.x, y: saved.y }
      : {}),
    minWidth: MAIN_MIN_WIDTH,
    minHeight: MAIN_MIN_HEIGHT,
    show: false,
    backgroundColor: PAPER[store.snapshot().skin] ?? PAPER['organic'],
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: SYMBOL[store.snapshot().skin] ?? SYMBOL['organic'],
      height: TITLEBAR_HEIGHT
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      // preload 只用 contextBridge + ipcRenderer，沙箱下完全够用，开起来更安全
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  if (saved?.maximized) mainWindow.maximize()

  // 位置 / 大小变化时存下来（防抖，拖动时不会疯狂写盘）
  let boundsTimer: NodeJS.Timeout | null = null
  const rememberBounds = (): void => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    // 截图 / 宽屏验收模式下不要污染用户真实的窗口尺寸
    if (isShotMode() || process.env['TIMECARD_WIDE'] === '1') return
    if (boundsTimer) clearTimeout(boundsTimer)
    boundsTimer = setTimeout(() => {
      boundsTimer = null
      if (!mainWindow || mainWindow.isDestroyed()) return
      const maximized = mainWindow.isMaximized()
      if (maximized) {
        // 最大化时记下 maximized，几何沿用上次的还原尺寸
        const prev = store.getWindowState()
        store.setWindowState({
          ...(prev ?? { width: MAIN_WIDTH, height: MAIN_HEIGHT }),
          maximized: true
        })
        return
      }
      const b = mainWindow.getBounds()
      if (!isOnScreen(b)) return
      store.setWindowState({ x: b.x, y: b.y, width: b.width, height: b.height, maximized: false })
    }, 400)
  }
  mainWindow.on('resize', rememberBounds)
  mainWindow.on('move', rememberBounds)

  // 等渲染层把数据渲染完再显示，避免「先闪一下空列表再长出卡片」
  let shown = false
  const revealMain = (): void => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return
    shown = true
    mainWindow.show()
    if (isShotMode()) void runShot()
  }
  ipcMain.once('ui:ready', revealMain)
  // 兜底：万一渲染层没发信号，也不能一直不显示
  setTimeout(revealMain, 2000)

  // 关闭 → 收进托盘（可在设置里关掉）
  mainWindow.on('close', (event) => {
    if (quitting || !store.prefs().closeToTray || isShotMode()) return
    event.preventDefault()
    mainWindow?.hide()
    if (!trayHintShown && tray) {
      trayHintShown = true
      try {
        tray.displayBalloon({
          title: '挂卡时间轴还在跑',
          content: `点托盘图标可以再打开；${QUICK_ACCELERATOR_LABEL} 随时唤起浮窗`
        })
      } catch {
        /* 某些系统不支持气泡 */
      }
    }
  })

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  loadRenderer(mainWindow, 'index', BOOT)

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

function showMainWindow(): void {
  if (!mainWindow) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/* ============================================================
 * 浮窗：无边框、可拖动、置顶在所有窗口之上
 * ========================================================== */

function createQuickWindow(): void {
  const area = screen.getPrimaryDisplay().workArea

  quickWindow = new BrowserWindow({
    width: QUICK_WIDTH,
    height: QUICK_DEFAULT_HEIGHT,
    x: Math.round(area.x + (area.width - QUICK_WIDTH) / 2),
    y: Math.round(area.y + area.height * 0.18),
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    // 关键：无边框窗口必须允许移动，真正的拖拽区由渲染层的 -webkit-app-region: drag 给
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: true,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Windows 上 'screen-saver' 才是能压住几乎所有窗口（含全屏程序）的层级
  quickWindow.setAlwaysOnTop(true, 'screen-saver')
  if (process.platform === 'darwin') {
    quickWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  // 记住用户拖到的位置
  quickWindow.on('moved', () => {
    if (!quickWindow) return
    const [x, y] = quickWindow.getPosition()
    lastQuickPos = { x, y }
  })

  const quickHash = isShotMode() ? BOOT.split('/')[1] : undefined
  loadRenderer(quickWindow, 'quick', quickHash)

  quickWindow.webContents.once('did-finish-load', () => {
    quickReady = true
    if (quickPendingShow) {
      quickPendingShow = false
      revealQuick()
    }
  })

  quickWindow.on('closed', () => {
    quickWindow = null
    quickReady = false
    quickPendingShow = false
  })

  /**
   * 渲染进程崩了 / 页面加载失败：无边框 + 置顶 + 透明的窗口会变成一块
   * 连 ✕ 都画不出来的空白，而且 quickReady 还是 true，快捷键再也救不回来。
   * 所以这里直接销毁，下次 show 会自动重建。
   */
  const recoverQuick = (reason: string): void => {
    console.warn(`[quick] ${reason}，销毁以便下次重建`)
    quickReady = false
    quickPendingShow = false
    const w = quickWindow
    quickWindow = null
    if (w && !w.isDestroyed()) {
      try {
        w.destroy()
      } catch {
        /* 已经没了就无所谓 */
      }
    }
  }

  quickWindow.webContents.on('render-process-gone', (_event, details) => {
    recoverQuick(`渲染进程退出（${details.reason}）`)
  })
  quickWindow.webContents.on('did-fail-load', (_event, code, desc, _url, isMainFrame) => {
    if (!isMainFrame) return
    recoverQuick(`页面加载失败（${code} ${desc}）`)
  })
}

/** 矩形是否真的和某块屏幕有可见交集（防止窗口跑到屏幕外） */
function isOnScreen(rect: { x: number; y: number; width: number; height: number }): boolean {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea
    const ix = Math.max(0, Math.min(rect.x + rect.width, a.x + a.width) - Math.max(rect.x, a.x))
    const iy = Math.max(0, Math.min(rect.y + rect.height, a.y + a.height) - Math.max(rect.y, a.y))
    return ix > 40 && iy > 24
  })
}

/** 把坐标夹回当前显示器可视区域，防止换屏后被扔到屏幕外 */
function clampToDisplay(pos: { x: number; y: number }): { x: number; y: number } {
  const size = quickWindow?.getBounds() ?? { width: QUICK_WIDTH, height: QUICK_DEFAULT_HEIGHT }
  // 用 getDisplayMatching（按矩形重叠面积）而不是 getDisplayNearestPoint（按最近点）：
  // 后者在双屏边界上会来回跳，导致窗口被搬来搬去
  const display = screen.getDisplayMatching({
    x: pos.x,
    y: pos.y,
    width: size.width,
    height: size.height
  })
  const area = display.workArea
  return {
    x: Math.min(Math.max(pos.x, area.x), area.x + area.width - size.width),
    y: Math.min(Math.max(pos.y, area.y), area.y + area.height - size.height)
  }
}

function showQuickWindow(): void {
  if (!quickWindow) createQuickWindow()
  if (!quickWindow) return

  // 首次或没拖过 → 居中；拖过 → 回原位（夹回可视区）
  if (lastQuickPos) {
    const p = clampToDisplay(lastQuickPos)
    quickWindow.setPosition(p.x, p.y)
  } else {
    const area = screen.getPrimaryDisplay().workArea
    const bounds = quickWindow.getBounds()
    lastQuickPos = {
      x: Math.round(area.x + (area.width - bounds.width) / 2),
      y: Math.round(area.y + area.height * 0.18)
    }
    quickWindow.setPosition(lastQuickPos.x, lastQuickPos.y)
  }

  if (!quickReady) {
    // 懒创建时页面还没加载完，等 did-finish-load 再显示，避免闪一下空白
    quickPendingShow = true
    return
  }

  revealQuick()
}

/** 真正把浮窗显示出来（已确保几何与层级） */
function revealQuick(): void {
  if (!quickWindow || quickWindow.isDestroyed()) return
  quickWindow.show()
  quickWindow.focus()
  quickWindow.setAlwaysOnTop(true, 'screen-saver')

  // 兜底：万一几何被搞到屏幕外（多屏拔插 / 分辨率变化 / 历史脏数据），直接回中间
  const shown = quickWindow.getBounds()
  if (!isOnScreen(shown)) {
    console.warn('[quick] 窗口跑出屏幕外，重置位置', shown)
    resetQuickPosition()
  }
}

function hideQuickWindow(): void {
  quickWindow?.hide()
}

function toggleQuickWindow(): void {
  if (quickWindow?.isVisible()) hideQuickWindow()
  else showQuickWindow()
}

/** 设置里点了「浮窗回到屏幕中间」 */
function resetQuickPosition(): { x: number; y: number } {
  lastQuickPos = null
  const area = screen.getPrimaryDisplay().workArea
  const bounds = quickWindow?.getBounds() ?? { width: QUICK_WIDTH, height: QUICK_DEFAULT_HEIGHT }
  const pos = {
    x: Math.round(area.x + (area.width - bounds.width) / 2),
    y: Math.round(area.y + area.height * 0.18)
  }
  if (quickWindow) {
    quickWindow.setPosition(pos.x, pos.y)
    lastQuickPos = pos
  }
  return pos
}

/* ============================================================
 * 设置窗口
 * ========================================================== */

function createSettingsWindow(): void {
  if (settingsWindow) {
    settingsWindow.show()
    settingsWindow.focus()
    return
  }

  settingsWindow = new BrowserWindow({
    width: SETTINGS_WIDTH,
    height: SETTINGS_HEIGHT,
    minWidth: 460,
    minHeight: 520,
    parent: mainWindow ?? undefined,
    modal: false,
    show: false,
    backgroundColor: PAPER[store.snapshot().skin] ?? PAPER['organic'],
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: SYMBOL[store.snapshot().skin] ?? SYMBOL['organic'],
      height: TITLEBAR_HEIGHT
    },
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  settingsWindow.on('ready-to-show', () => settingsWindow?.show())
  settingsWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  loadRenderer(settingsWindow, 'settings')
  settingsWindow.on('closed', () => {
    settingsWindow = null
  })
}

/* ============================================================
 * 托盘
 * ========================================================== */

function trayIconPath(): string {
  // 打包后走 extraResources；开发时用源码里的 build/
  const packaged = join(process.resourcesPath, 'icon.ico')
  if (existsSync(packaged)) return packaged
  return join(__dirname, '../../build/icon.ico')
}

function buildTrayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '打开挂卡时间轴', click: () => showMainWindow() },
    {
      label: `打开浮窗（${QUICK_ACCELERATOR_LABEL}）`,
      click: () => showQuickWindow()
    },
    { type: 'separator' },
    { label: '设置…', click: () => createSettingsWindow() },
    {
      label: '打开数据文件夹',
      click: () => void shell.openPath(store.dataDir)
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        app.quit()
      }
    }
  ])
}

function createTray(): void {
  const img = nativeImage.createFromPath(trayIconPath())
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('挂卡时间轴')
  tray.setContextMenu(buildTrayMenu())
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else showMainWindow()
  })
  tray.on('double-click', () => showMainWindow())
}

/* ============================================================
 * 验收截图（TIMECARD_SHOT / TIMECARD_SHOT_QUICK）
 * ========================================================== */

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function runShot(): Promise<void> {
  await sleep(900)
  try {
    const shotMain = process.env['TIMECARD_SHOT']
    const shotQuick = process.env['TIMECARD_SHOT_QUICK']
    const shotSettings = process.env['TIMECARD_SHOT_SETTINGS']

    if (shotSettings) {
      createSettingsWindow()
      await sleep(900)
    }
    if (shotQuick) {
      showQuickWindow()
      // 浮窗是懒创建的，等它真的可见再截（最多等 4 秒）
      for (let i = 0; i < 40 && !quickWindow?.isVisible(); i++) await sleep(100)
      await sleep(500)
    }
    if (shotMain && mainWindow) {
      await writeFile(shotMain, (await mainWindow.webContents.capturePage()).toPNG())
    }
    if (shotQuick && quickWindow) {
      await writeFile(shotQuick, (await quickWindow.webContents.capturePage()).toPNG())
    }
    if (shotSettings && settingsWindow) {
      await writeFile(shotSettings, (await settingsWindow.webContents.capturePage()).toPNG())
    }
  } catch (error) {
    console.error('[shot] 截图失败', error)
  } finally {
    quitting = true
    app.quit()
  }
}

/* ============================================================
 * IPC
 * ========================================================== */

function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload)
  }
}

/** 参数校验小工具：渲染层来的东西一律当不可信 */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

/** 只保留形状合法的条目，脏数据直接丢掉而不是让渲染层炸 */
function cleanItems(
  v: unknown
): Array<{ id: string; text: string; done: boolean }> | undefined {
  if (!Array.isArray(v)) return undefined
  const out: Array<{ id: string; text: string; done: boolean }> = []
  for (const it of v) {
    if (!isRecord(it)) continue
    if (
      typeof it['id'] !== 'string' ||
      typeof it['text'] !== 'string' ||
      typeof it['done'] !== 'boolean'
    ) {
      continue
    }
    out.push({ id: it['id'], text: it['text'].slice(0, 500), done: it['done'] })
  }
  return out
}

function applySkinToChrome(skin: Skin): void {
  const overlay = {
    color: '#00000000',
    symbolColor: SYMBOL[skin] ?? SYMBOL['organic'],
    height: TITLEBAR_HEIGHT
  }
  mainWindow?.setBackgroundColor(PAPER[skin] ?? PAPER['organic'])
  settingsWindow?.setBackgroundColor(PAPER[skin] ?? PAPER['organic'])
  for (const win of [mainWindow, settingsWindow]) {
    if (!win || win.isDestroyed()) continue
    try {
      win.setTitleBarOverlay(overlay)
    } catch {
      /* 非 Windows 忽略 */
    }
  }
}

function registerIpc(): void {
  /* --- 数据 --- */
  ipcMain.handle('store:snapshot', async () => {
    await store.init()
    return store.snapshot()
  })

  const emit = async (next: Awaited<ReturnType<typeof store.snapshot>>): Promise<void> => {
    broadcast('store:changed', next)
    // 本地改了 → 防抖后自动推给服务器（未启用时 scheduleAutoSync 自己会跳过）
    scheduleAutoSync()
    broadcastSync()
  }

  // 落盘状态变化（成功↔失败）时把最新快照广播给所有窗口，界面才能弹出/收起"保存失败"警告。
  // 只做 store:changed，不触发同步 —— 这跟"数据改了"不是一回事。
  store.onSaveStateChange(() => {
    broadcast('store:changed', store.snapshot())
  })

  // 必须带全量（含 settings）。只发 state+report 的话渲染层拿到的
  // store.sync 缺了 settings，App 里访问 store.sync.settings.enabled 直接崩，
  // 一崩整个 UI 都没了 —— 这个 bug 一次干掉了四个回归测试。
  const syncBundle = (): {
    settings: ReturnType<typeof store.sync>
    state: ReturnType<typeof syncState>
    report: ReturnType<typeof report>
  } => ({ settings: store.sync(), state: syncState(), report: report() })

  const broadcastSync = (): void => {
    broadcast('sync:changed', syncBundle())
  }
  onSyncStateChange(broadcastSync)



  ipcMain.handle('store:set-skin', async (_e, skin: Skin) => {
    // 白名单：非法的皮肤值会让 html[data-theme] 落空、整屏没样式
    if (!SKINS.includes(skin)) return store.snapshot()
    const next = await store.setSkin(skin)
    applySkinToChrome(skin)
    await emit(next)
    return next
  })

  ipcMain.handle('store:set-prefs', async (_e, patch: Record<string, unknown>) => {
    // 只认已知键 + 正确类型，避免 closeToTray: "false" 这种脏值被永久写盘
    const clean: { closeToTray?: boolean } = {}
    if (isRecord(patch) && typeof patch['closeToTray'] === 'boolean') {
      clean.closeToTray = patch['closeToTray']
    }
    const next = await store.setPrefs(clean)
    tray?.setContextMenu(buildTrayMenu())
    await emit(next)
    return next
  })

  ipcMain.handle('store:toggle-item', async (_e, cardId: string, itemId: string) => {
    const next = await store.toggleItem(cardId, itemId)
    await emit(next)
    return next
  })

  ipcMain.handle('store:toggle-card', async (_e, cardId: string) => {
    const next = await store.toggleCardDone(cardId)
    await emit(next)
    return next
  })

  ipcMain.handle(
    'store:add-card',
    async (_e, input: { title: string; anchorAt: number; tag?: string }) => {
      const next = await store.addCard(input)
      await emit(next)
      return next
    }
  )

  ipcMain.handle('store:remove-card', async (_e, cardId: string) => {
    const next = await store.removeCard(cardId)
    await emit(next)
    return next
  })

  ipcMain.handle('store:restore-card', async (_e, cardId: string) => {
    const next = await store.restoreCard(cardId)
    await emit(next)
    return next
  })

  ipcMain.handle('store:reset', async () => {
    const next = await store.reset()
    await emit(next)
    return next
  })

  ipcMain.handle('store:clear-all', async () => {
    const next = await store.clearAll()
    await emit(next)
    return next
  })

  /* --- 应用信息 / 动作 --- */
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dataDir: store.dataDir,
    dataFile: store.filePath,
    quickAccelerator: QUICK_ACCELERATOR_LABEL,
    quickShortcutRegistered: shortcutRegistered,
    platform: process.platform
  }))

  ipcMain.handle('app:open-data-folder', () => void shell.openPath(store.dataDir))
  ipcMain.handle('app:retry-save', async () => {
    await store.retrySave()
    return store.saveState()
  })
  ipcMain.handle('app:quit', () => {
    quitting = true
    app.quit()
  })

  /* --- 浮窗 --- */
  ipcMain.handle('quick:show', () => showQuickWindow())
  ipcMain.on('quick:hide', () => hideQuickWindow())
  // 高度跟随内容。
  // 铁律：x 和 width 一律钉死，只允许 y 为了"别顶出屏幕底部"而微调。
  // 之前这里调过 clampToDisplay()，它会用 getDisplayNearestPoint 判断屏幕，
  // 多显示器边界上会来回抖 —— 表现就是"换个皮肤浮窗横向乱飞"。
  ipcMain.on('quick:resize', (_e, height: unknown) => {
    if (!quickWindow || quickWindow.isDestroyed()) return
    // 渲染层来的参数一律当不可信：NaN 会让 setBounds 直接抛
    if (typeof height !== 'number' || !Number.isFinite(height)) return
    const h = Math.max(120, Math.min(720, Math.round(height)))
    const b = quickWindow.getBounds()
    if (b.height === h && b.width === QUICK_WIDTH) return

    const visible = quickWindow.isVisible()

    // 隐藏状态下只更新尺寸，绝不动位置 —— 隐藏窗口的 getBounds() 不可靠，
    // 拿它去算"是否超出屏幕底部"会把窗口搬到屏幕外，之后就"出现不了"了。
    if (!visible) {
      quickWindow.setBounds({ x: b.x, y: b.y, width: QUICK_WIDTH, height: h })
      return
    }

    const area = screen.getDisplayMatching(b).workArea
    const overflow = b.y + h - (area.y + area.height)
    const y = overflow > 0 ? Math.max(area.y, b.y - overflow) : b.y

    quickWindow.setBounds({ x: b.x, y, width: QUICK_WIDTH, height: h })
    // 这里不写 lastQuickPos：它只该由 'moved'（用户真拖动）和 showQuickWindow() 写
  })
  ipcMain.handle('quick:reset-position', () => resetQuickPosition())
  // 诊断用：读浮窗当前几何，验证改皮肤时不会被搬走
  ipcMain.handle('quick:bounds', () => quickWindow?.getBounds() ?? null)

  /* --- 设置 --- */
  ipcMain.handle('settings:open', () => createSettingsWindow())

  /* --- 同步 --- */
  ipcMain.handle('sync:get', () => syncBundle())

  ipcMain.handle('sync:set-settings', async (_e, patch: Record<string, unknown>) => {
    const before = store.sync()
    // 白名单 + 类型校验：未知键直接丢弃，字符串做长度上限
    const clean: { enabled?: boolean; serverUrl?: string; token?: string } = {}
    if (isRecord(patch)) {
      if (typeof patch['enabled'] === 'boolean') clean.enabled = patch['enabled']
      if (typeof patch['serverUrl'] === 'string') clean.serverUrl = patch['serverUrl'].slice(0, 500)
      if (typeof patch['token'] === 'string') clean.token = patch['token'].slice(0, 500)
    }
    const next = await store.setSyncSettings(clean)
    broadcastSync()

    // 只有「从关到开」才立刻试一次同步。
    // 之前是每次改设置都排一次同步 —— 用户在地址栏打字，
    // 每敲一个字就往半成品 URL 发请求，日志里一堆噪音。
    const justEnabled = !before.enabled && next.enabled
    // 换了服务器：游标已归零、本地卡已重新入队，必须马上推一次，
    // 否则用户会以为"换了个服务器，卡都没了"
    const urlChanged =
      before.serverUrl.trim().replace(/\/+$/, '') !== next.serverUrl.trim().replace(/\/+$/, '')
    if ((justEnabled || (urlChanged && next.enabled)) && next.serverUrl) {
      setTimeout(() => void syncNow().then(broadcastSync), 200)
    }
    return syncBundle()
  })

  ipcMain.handle('sync:test', async (_e, url: string, token: string) => testConnection(url, token))

  ipcMain.handle('sync:now', async () => {
    const r = await syncNow()
    broadcastSync()
    return { ...syncBundle(), report: r }
  })

  ipcMain.handle('sync:clear-outbox', () => {
    store.clearOutbox()
    broadcastSync()
    return syncBundle()
  })


  ipcMain.handle('store:patch-card', async (_e, cardId: string, patch: Record<string, unknown>) => {
    if (typeof cardId !== 'string') return store.snapshot()
    const clean: {
      title?: string
      tag?: string
      items?: Array<{ id: string; text: string; done: boolean }>
    } = {}
    if (isRecord(patch)) {
      if (typeof patch['title'] === 'string') clean.title = patch['title']
      if (typeof patch['tag'] === 'string') clean.tag = patch['tag']
      const items = cleanItems(patch['items'])
      if (items) clean.items = items
    }
    const next = await store.patchCard(cardId, clean)
    await emit(next)
    return next
  })

  ipcMain.handle('store:move-card', async (_e, cardId: string, anchorAt: number) => {
    // 非数字 anchorAt 会让卡片挂到 NaN 天，列表再也找不到它
    if (typeof cardId !== 'string' || typeof anchorAt !== 'number' || !Number.isFinite(anchorAt)) {
      return store.snapshot()
    }
    const next = await store.moveCard(cardId, anchorAt)
    await emit(next)
    return next
  })

  /* --- 主窗口控制 --- */
  ipcMain.handle('store:set-archived', async (_e, cardId: string, archived: boolean) => {
    if (typeof cardId !== 'string' || typeof archived !== 'boolean') return store.snapshot()
    const next = await store.setArchived(cardId, archived)
    await emit(next)
    return next
  })
  ipcMain.handle('app:focus-main', () => {
    hideQuickWindow()
    showMainWindow()
  })

  /**
   * 浮窗里点 ＋：在主窗口用「浮窗选中的那一天」打开输入框。
   * 之前这里只是 focusMain()，用户刚点的周三会被丢掉。
   */
  ipcMain.on('quick:open-composer', (_e, anchorAt: unknown) => {
    const at =
      typeof anchorAt === 'number' && Number.isFinite(anchorAt) ? anchorAt : Date.now()
    hideQuickWindow()
    showMainWindow()
    const w = mainWindow
    if (!w || w.isDestroyed()) return
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', () => w.webContents.send('ui:open-composer', at))
    } else {
      w.webContents.send('ui:open-composer', at)
    }
  })
  ipcMain.handle('window:minimize', () => mainWindow?.minimize())
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  ipcMain.handle('window:close', () => mainWindow?.close())
}

/* ============================================================
 * 生命周期
 * ========================================================== */

void app.whenReady().then(async () => {
  app.setAppUserModelId('com.timecard.desktop')
  await store.init()

  registerIpc()
  createMainWindow()
  createTray()
  // 浮窗改成懒创建：不用就不占那 ~90MB 的渲染进程。
  // showQuickWindow() 里已有 `if (!quickWindow) createQuickWindow()`，无需预建。

  shortcutRegistered = globalShortcut.register(QUICK_ACCELERATOR, toggleQuickWindow)
  const ok = shortcutRegistered
  if (ok) {
    console.log(`[shortcut] ${QUICK_ACCELERATOR} 已注册（显示为 ${QUICK_ACCELERATOR_LABEL}）`)
  } else {
    console.warn(`[shortcut] ${QUICK_ACCELERATOR} 注册失败（可能被别的程序占用）`)
  }
  console.log(`[store] 数据文件: ${store.filePath}`)
  console.log(`[sync]  设备 ${store.deviceId()}，${store.sync().enabled ? '已启用' : '未启用'}`)
  startPolling()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  // 用户又双击了一次图标：把已有窗口叫出来，而不是开第二个进程
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) {
      createMainWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
})

// 有托盘之后，关掉所有窗口不等于退出
app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  if (!store.prefs().closeToTray) app.quit()
})

let flushDoneOnQuit = false

app.on('before-quit', (event) => {
  quitting = true
  if (flushDoneOnQuit) return
  // 落盘是 200ms 防抖：不等它写完就退，最后一次改动和 Outbox 会一起丢
  event.preventDefault()
  const finish = (): void => {
    if (flushDoneOnQuit) return
    flushDoneOnQuit = true
    app.quit()
  }
  void store.flush().then(finish, finish)
  // 兜底：磁盘卡住也不能让用户关不掉
  setTimeout(finish, 3000).unref()
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
