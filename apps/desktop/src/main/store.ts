import { app } from 'electron'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { addDays, createCard, createCardItem, startOfDay } from '@timecard/shared'
import type { Card, ChangeOp, OutboxEntry, Skin } from '@timecard/shared'

const HOUR = 3_600_000

/** 应用偏好 */
export interface Prefs {
  /** 点窗口关闭按钮时：true=最小化到托盘，false=直接退出 */
  closeToTray: boolean
  /** 开机自动启动（打包版才生效） */
  openAtLogin?: boolean
}

export const DEFAULT_PREFS: Prefs = {
  closeToTray: true,
  openAtLogin: false
}

/** 同步配置。token 存在本地文件里 —— 个人桌面应用，够用了。 */
export interface SyncSettings {
  enabled: boolean
  /** 服务器基地址，例如 http://127.0.0.1:8787 */
  serverUrl: string
  /** 访问令牌 */
  token: string
}

export const DEFAULT_SYNC: SyncSettings = {
  enabled: false,
  serverUrl: '',
  token: ''
}

export interface Snapshot {
  skin: Skin
  cards: Card[]
  prefs: Prefs
  /** 最近一次落盘失败的原因；null = 一切正常（可选，老快照没有也兼容） */
  saveError?: string | null
}

/** 窗口几何。独立于 Snapshot：渲染层不关心，也不必每次广播 */
export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized?: boolean
}

/** 落盘的整体形状 */
interface Persisted extends Snapshot {
  windowState?: WindowState | null
  sync?: SyncSettings
  syncMeta?: { cursor: number; lastSyncAt: number | null; deviceId: string }
  outbox?: OutboxEntry[]
}

const FIRST_SKIN: Skin = 'organic'

/** 演示数据：按「今天」的相对位置生成，任何时候打开都有一周内容 */
function buildSeed(now = Date.now()): Card[] {
  const today = startOfDay(now)
  const at = (dayOffset: number, hour: number, minute = 0): number =>
    addDays(today, dayOffset) + hour * HOUR + minute * 60_000

  return [
    createCard(
      {
        title: '交水电费',
        tag: '交费 / BILLS',
        color: '#b3613a',
        anchorAt: at(-1, 9, 30),
        items: [createCardItem('抄电表读数'), createCardItem('App 里缴费')]
      },
      now
    ),
    createCard(
      {
        title: '备课 · 第二章',
        tag: '学习 / STUDY',
        color: '#71805a',
        anchorAt: at(-1, 20),
        status: 'done',
        items: [createCardItem('课件 12 页', true), createCardItem('习题 6 道', true)]
      },
      now
    ),
    createCard(
      {
        title: '买菜清单',
        tag: '家庭 / HOME',
        color: '#71805a',
        anchorAt: at(0, 9),
        items: [
          createCardItem('鸡蛋 ×10'),
          createCardItem('青菜 两把'),
          createCardItem('米 5kg'),
          createCardItem('顺手买姜')
        ]
      },
      now
    ),
    createCard(
      {
        title: '装修这个事',
        tag: '工作 / WORK',
        color: '#8c7440',
        anchorAt: at(0, 14),
        items: [createCardItem('买灯具'), createCardItem('施工对接'), createCardItem('预算复核')]
      },
      now
    ),
    createCard(
      {
        title: '施工进度 · 水电',
        tag: '施工 / BUILD',
        color: '#b3613a',
        anchorAt: at(1, 9),
        items: [createCardItem('水电验收'), createCardItem('木工进场'), createCardItem('油漆候场')]
      },
      now
    ),
    createCard(
      {
        title: '健身',
        tag: '生活 / LIFE',
        color: '#71805a',
        anchorAt: at(2, 19),
        items: [createCardItem('慢跑 5km'), createCardItem('拉伸 15min')]
      },
      now
    )
  ]
}

class Store {
  private file = ''
  private data: Snapshot = { skin: FIRST_SKIN, cards: [], prefs: { ...DEFAULT_PREFS } }
  private windowState: WindowState | null = null
  private syncSettings: SyncSettings = { ...DEFAULT_SYNC }
  private syncMeta = { cursor: 0, lastSyncAt: null as number | null, deviceId: '' }
  private outbox: OutboxEntry[] = []
  private outboxSeq = 0
  private loaded = false
  private saveTimer: NodeJS.Timeout | null = null
  /** 写盘串行队列：同一时刻只允许一个 flush 动 .tmp */
  private flushChain: Promise<void> = Promise.resolve()
  private retryTimer: NodeJS.Timeout | null = null
  /** 最近一次落盘失败原因（null = 正常），渲染层据此提示用户 */
  private saveError: string | null = null
  private lastSavedAt: number | null = null
  private saveStateCb: (() => void) | null = null

  get dataDir(): string {
    return app.getPath('userData')
  }

  async init(): Promise<void> {
    if (this.loaded) return
    this.file = join(this.dataDir, 'timecard.json')
    try {
      const raw = await readFile(this.file, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<Persisted>
      this.data = {
        skin: parsed.skin ?? FIRST_SKIN,
        cards: Array.isArray(parsed.cards) ? parsed.cards : buildSeed(),
        prefs: { ...DEFAULT_PREFS, ...(parsed.prefs ?? {}) }
      }
      this.windowState = parsed.windowState ?? null
      this.syncSettings = { ...DEFAULT_SYNC, ...(parsed.sync ?? {}) }
      this.outbox = Array.isArray(parsed.outbox) ? parsed.outbox : []
      this.syncMeta = {
        cursor: parsed.syncMeta?.cursor ?? 0,
        lastSyncAt: parsed.syncMeta?.lastSyncAt ?? null,
        // 每台设备一个稳定 id，参与 LWW 决胜
        deviceId: parsed.syncMeta?.deviceId || randomUUID()
      }
      this.outboxSeq = this.outbox.reduce((m, e) => Math.max(m, e.id), 0)
    } catch {
      // 首次启动 / 文件损坏 → 重建演示数据
      this.data = { skin: FIRST_SKIN, cards: buildSeed(), prefs: { ...DEFAULT_PREFS } }
      this.syncMeta = { cursor: 0, lastSyncAt: null, deviceId: randomUUID() }
      await this.flush()
    }
    if (!this.syncMeta.deviceId) this.syncMeta.deviceId = randomUUID()
    this.loaded = true
  }

  /* ============================================================
   * 读
   * ========================================================== */

  snapshot(): Snapshot {
    return {
      skin: this.data.skin,
      cards: this.data.cards,
      prefs: { ...this.data.prefs },
      saveError: this.saveError
    }
  }

  /** 落盘状态变化时回调（只在"出错↔恢复"切换时触发，不会每 200ms 刷一次） */
  onSaveStateChange(cb: () => void): void {
    this.saveStateCb = cb
  }

  /** 供设置页展示：是否保存异常 / 上次成功保存时间 */
  saveState(): { error: string | null; lastSavedAt: number | null } {
    return { error: this.saveError, lastSavedAt: this.lastSavedAt }
  }

  /** 手动重试一次落盘（用户点「重试」） */
  async retrySave(): Promise<void> {
    await this.flush()
  }

  prefs(): Prefs {
    return { ...this.data.prefs }
  }

  sync(): SyncSettings {
    return { ...this.syncSettings }
  }

  deviceId(): string {
    return this.syncMeta.deviceId
  }

  cursor(): number {
    return this.syncMeta.cursor
  }

  lastSyncAt(): number | null {
    return this.syncMeta.lastSyncAt
  }

  pending(): number {
    return this.outbox.length
  }

  /** 取一批待推送（FIFO） */
  takeOutbox(limit: number): OutboxEntry[] {
    return this.outbox.slice(0, limit)
  }

  getWindowState(): WindowState | null {
    return this.windowState
  }

  cardById(id: string): Card | null {
    return this.data.cards.find((c) => c.id === id) ?? null
  }

  /* ============================================================
   * 写：本地 + 入队
   * ========================================================== */

  private putCard(next: Card, op: ChangeOp): void {
    const exists = this.data.cards.some((c) => c.id === next.id)
    this.data = {
      ...this.data,
      cards: exists
        ? this.data.cards.map((c) => (c.id === next.id ? next : c))
        : [...this.data.cards, next]
    }
    this.enqueue(next, op)
    this.scheduleSave()
  }

  /** 判断一条卡片变更该记成哪种 op */
  private opFor(next: Card, prev: Card | null): ChangeOp {
    if (!prev) return 'create'
    if (next.deletedAt !== null && prev.deletedAt === null) return 'delete'
    if (next.deletedAt === null && prev.deletedAt !== null) return 'restore'
    return 'update'
  }

  private enqueue(card: Card, op: ChangeOp): void {
    // 同一张卡在队列里只留一条「最新快照」：推送本来就是整卡覆盖，
    // 连写十次标题没必要排十条队（每条还存一份完整卡），队列会白白变长。
    const existing = this.outbox.find((e) => e.cardId === card.id)
    if (existing) {
      existing.card = { ...card }
      existing.op = op
      existing.enqueuedAt = Date.now()
      existing.lastError = null
      existing.attempts = 0
      return
    }
    this.outboxSeq += 1
    this.outbox.push({
      id: this.outboxSeq,
      cardId: card.id,
      op,
      card: { ...card },
      attempts: 0,
      enqueuedAt: Date.now(),
      lastError: null
    })
  }

  /* ============================================================
   * 同步引擎用的接口
   * ========================================================== */

  /** 推送成功后把对应条目从 Outbox 移走 */
  ackOutbox(ids: number[]): void {
    if (ids.length === 0) return
    const drop = new Set(ids)
    this.outbox = this.outbox.filter((e) => !drop.has(e.id))
    this.scheduleSave()
  }

  /** 记一次失败，方便下次退避 */
  markOutboxFailure(ids: number[], message: string): void {
    this.outbox = this.outbox.map((e) =>
      ids.includes(e.id) ? { ...e, attempts: e.attempts + 1, lastError: message } : e
    )
    this.scheduleSave()
  }

  /**
   * 服务端版本覆盖本地（拉取到更新的，或推送被拒）。
   * **不**入队 —— 这是从服务端来的，再推回去就是死循环。
   */
  applyServerCard(card: Card): boolean {
    const prev = this.cardById(card.id)
    if (!prev) {
      this.data = { ...this.data, cards: [...this.data.cards, card] }
      this.scheduleSave()
      return true
    }
    const changed =
      prev.updatedAt !== card.updatedAt ||
      prev.rev !== card.rev ||
      JSON.stringify(prev) !== JSON.stringify(card)
    if (changed) {
      this.data = {
        ...this.data,
        cards: this.data.cards.map((c) => (c.id === card.id ? card : c))
      }
      this.scheduleSave()
    }
    return changed
  }

  setCursor(cursor: number): void {
    this.syncMeta = { ...this.syncMeta, cursor }
    this.scheduleSave()
  }

  markSynced(): void {
    this.syncMeta = { ...this.syncMeta, lastSyncAt: Date.now() }
    this.scheduleSave()
  }

  async setSyncSettings(patch: Partial<SyncSettings>): Promise<SyncSettings> {
    const wasEnabled = this.syncSettings.enabled
    const prevUrl = this.syncSettings.serverUrl.trim().replace(/\/+$/, '')

    // 换服务器 = 换一个库。旧游标在新库上没有意义（新库的 seq 可能比它小），
    // 不清零的话 `since=大数` 会把对方已有的卡全部漏掉，而且用户没有任何提示。
    if (patch.serverUrl !== undefined) {
      const nextUrl = patch.serverUrl.trim().replace(/\/+$/, '')
      if (nextUrl !== prevUrl) {
        this.syncMeta = { cursor: 0, lastSyncAt: null, deviceId: this.syncMeta.deviceId }
        // 同时把本地已有的卡排进队列，让新服务器也拿到一份
        for (const card of this.data.cards) {
          if (card.deletedAt === null) this.enqueue(card, 'create')
        }
      }
    }

    this.syncSettings = { ...this.syncSettings, ...patch }
    this.scheduleSave()

    // 第一次启用同步时，把「同步功能上线之前就存在」的本地卡片补进 Outbox。
    // 不做这一步的话，用户已有的卡永远到不了服务器 —— 只有新改动才会同步。
    //
    // 条件收得很紧：之前没启用 + 队列是空的 + 游标还是 0（从没同步过），
    // 这样反复开关sync 也不会把全部卡片重推一遍。
    if (
      !wasEnabled &&
      this.syncSettings.enabled &&
      this.outbox.length === 0 &&
      this.syncMeta.cursor === 0
    ) {
      for (const card of this.data.cards) {
        if (card.deletedAt === null) this.enqueue(card, 'create')
      }
      this.scheduleSave()
    }

    return this.sync()
  }

  /** 手动把当前所有活跃卡片排进 Outbox（换服务器时用） */
  enqueueAllLocal(): number {
    let n = 0
    for (const card of this.data.cards) {
      if (card.deletedAt === null) {
        this.enqueue(card, 'create')
        n += 1
      }
    }
    this.scheduleSave()
    return n
  }

  /** 清空待推送队列（换服务器 / 重装时用） */
  clearOutbox(): void {
    this.outbox = []
    this.scheduleSave()
  }

  /* ============================================================
   * 其余写操作
   * ========================================================== */

  setWindowState(state: WindowState): void {
    this.windowState = state
    this.scheduleSave()
  }

  async setPrefs(patch: Partial<Prefs>): Promise<Snapshot> {
    this.data = { ...this.data, prefs: { ...this.data.prefs, ...patch } }
    this.scheduleSave()
    return this.snapshot()
  }

  async setSkin(skin: Skin): Promise<Snapshot> {
    this.data = { ...this.data, skin }
    this.scheduleSave()
    return this.snapshot()
  }

  async toggleItem(cardId: string, itemId: string): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()
    const items = prev.items.map((item) =>
      item.id === itemId ? { ...item, done: !item.done } : item
    )
    const allDone = items.length > 0 && items.every((i) => i.done)
    const status: Card['status'] =
      prev.status === 'archived' ? 'archived' : allDone ? 'done' : 'open'
    this.putCard(
      { ...prev, items, status, updatedAt: Date.now(), rev: prev.rev + 1 },
      this.opFor({ ...prev, items }, prev)
    )
    return this.snapshot()
  }

  /** 整卡打勾：全勾完就清空，否则全勾上 */
  async toggleCardDone(cardId: string): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()
    // 0 条目的卡片（Composer 建出来的就是这种）没有 "every" 可用，
    // 只能看 status。否则 allDone 永远是 false → status 永远是 done → 取消不了。
    const allDone = prev.items.length > 0 ? prev.items.every((i) => i.done) : prev.status === 'done'
    const items = prev.items.map((item) => ({ ...item, done: !allDone }))
    const status: Card['status'] = allDone ? 'open' : 'done'
    const next: Card = { ...prev, items, status, updatedAt: Date.now(), rev: prev.rev + 1 }
    this.putCard(next, this.opFor(next, prev))
    return this.snapshot()
  }

  async addCard(input: { title: string; anchorAt: number; tag?: string }): Promise<Snapshot> {
    const title = input.title.trim()
    if (!title) return this.snapshot()
    const card = createCard({
      title,
      anchorAt: input.anchorAt,
      tag: input.tag?.trim() ?? '',
      color: '#71805a',
      items: []
    })
    this.putCard(card, 'create')
    return this.snapshot()
  }

  /**
   * 改卡片的标题 / 分类 / 条目。
   * 条目不单独提供增删改接口 —— 编辑器里改完整个数组一次性提交，
   * 少一堆 IPC，也不会出现"改一半"的中间态。
   */
  async patchCard(
    cardId: string,
    patch: { title?: string; tag?: string; items?: Array<{ id: string; text: string; done: boolean }> }
  ): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()

    const title = patch.title !== undefined ? patch.title.trim() : prev.title
    if (!title) return this.snapshot() // 空标题不接受

    const items = patch.items ?? prev.items
    const allDone = items.length > 0 && items.every((i) => i.done)
    // 空条目的卡没有「全部勾完」这回事，沿用原状态 ——
    // 不这样做的话，浮窗里打过勾的空卡一进编辑器改标题就被打回 open。
    const status: Card['status'] =
      prev.status === 'archived'
        ? 'archived'
        : items.length === 0
          ? prev.status === 'done'
            ? 'done'
            : 'open'
          : allDone
            ? 'done'
            : 'open'

    const next: Card = {
      ...prev,
      title,
      tag: patch.tag !== undefined ? patch.tag.trim() : prev.tag,
      items,
      status,
      updatedAt: Date.now(),
      rev: prev.rev + 1
    }
    this.putCard(next, this.opFor(next, prev))
    return this.snapshot()
  }

  async moveCard(cardId: string, anchorAt: number): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()
    const next: Card = { ...prev, anchorAt, updatedAt: Date.now(), rev: prev.rev + 1 }
    this.putCard(next, this.opFor(next, prev))
    return this.snapshot()
  }

  /** 软删除：留墓碑，为同步预留 */
  /** 归档 / 取消归档（归档 = 从时间轴摘下，但搜索里仍能找到） */
  async setArchived(cardId: string, archived: boolean): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()
    const items = prev.items
    const allDone = items.length > 0 && items.every((i) => i.done)
    const status: Card['status'] = archived
      ? 'archived'
      : items.length === 0
        ? 'open'
        : allDone
          ? 'done'
          : 'open'
    if (prev.status === status) return this.snapshot()
    const next: Card = { ...prev, status, updatedAt: Date.now(), rev: prev.rev + 1 }
    this.putCard(next, this.opFor(next, prev))
    return this.snapshot()
  }

  async removeCard(cardId: string): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()
    const next: Card = { ...prev, deletedAt: Date.now(), updatedAt: Date.now(), rev: prev.rev + 1 }
    this.putCard(next, 'delete')
    return this.snapshot()
  }

  /** 撤销删除：把墓碑清掉 */
  async restoreCard(cardId: string): Promise<Snapshot> {
    const prev = this.cardById(cardId)
    if (!prev) return this.snapshot()
    const next: Card = { ...prev, deletedAt: null, updatedAt: Date.now(), rev: prev.rev + 1 }
    this.putCard(next, 'restore')
    return this.snapshot()
  }

  async reset(): Promise<Snapshot> {
    for (const card of this.data.cards) {
      if (card.deletedAt === null) {
        this.putCard({ ...card, deletedAt: Date.now(), updatedAt: Date.now(), rev: card.rev + 1 }, 'delete')
      }
    }
    for (const card of buildSeed()) this.putCard(card, 'create')
    await this.flush()
    return this.snapshot()
  }

  /** 清空全部卡片（演示用，真删） */
  async clearAll(): Promise<Snapshot> {
    for (const card of this.data.cards) {
      if (card.deletedAt === null) {
        this.putCard({ ...card, deletedAt: Date.now(), updatedAt: Date.now(), rev: card.rev + 1 }, 'delete')
      }
    }
    await this.flush()
    return this.snapshot()
  }

  get filePath(): string {
    return this.file
  }

  /* ============================================================
   * 落盘
   * ========================================================== */

  /** 合并 200ms 内的多次写入 */
  private scheduleSave(): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.flush()
    }, 200)
  }

  async flush(): Promise<void> {
    if (!this.file) return
    // 串行化：两个 flush 同时跑会抢同一个 .tmp 文件，可能写出半份内容。
    this.flushChain = this.flushChain.then(() => this.writeOnce())
    return this.flushChain
  }

  private async writeOnce(): Promise<void> {
    const file = this.file
    if (!file) return
    const tmp = `${file}.tmp`
    try {
      const payload: Persisted = {
        ...this.data,
        windowState: this.windowState,
        sync: this.syncSettings,
        syncMeta: this.syncMeta,
        outbox: this.outbox
      }
      await writeFile(tmp, JSON.stringify(payload, null, 2), 'utf-8')
      await rename(tmp, file)
      this.lastSavedAt = Date.now()
      // 从"失败"恢复到"成功"要通知一次，好让界面把警告条收掉
      if (this.saveError !== null) {
        this.saveError = null
        this.saveStateCb?.()
      }
    } catch (error) {
      console.error('[store] 保存失败', error)
      // 让界面知道"没存上"，而不是只在控制台悄悄报错
      const msg = error instanceof Error ? error.message : String(error)
      if (this.saveError !== msg) {
        this.saveError = msg
        this.saveStateCb?.()
      }
      // 磁盘忙/被杀毒软件占用这类一次性失败不该永久丢数据，2 秒后再来一次
      if (!this.retryTimer) {
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          void this.flush()
        }, 2000)
      }
    }
  }
}

export const store = new Store()
