/**
 * 挂卡时间轴 · 服务端观测层
 *
 * 只做两件事：记「最近发生了什么」和「哪台设备来过」。
 *
 * 刻意做成**纯内存**：
 *  - 服务重启就清空没关系 —— 面板看的是「现在活不活」，不是审计账本；
 *  - 不落库就不会把同步协议搞脏，也不给 SQLite 添写压力；
 *  - 环形缓冲封顶，跑上一年也不会吃光内存。
 *
 * 注意：Worker 运行时每个 isolate 各有一份，看到的只是本 isolate 的近期流量。
 * 这属于预期行为 —— 真要长期统计应该上外部日志，不该塞进这个轻量服务。
 */

/** 事件类别：推送、拉取、以及面板自己的写操作 */
export type EventKind = 'push' | 'pull' | 'admin'

export interface SyncEvent {
  /** 单调递增事件 id，给面板「只拉增量」用 */
  id: number
  /** 发生时刻（毫秒） */
  at: number
  kind: EventKind
  deviceId: string
  /**
   * 是否成功。
   *
   * 失败也会记 —— 只记成功的话面板永远是「运行正常」，
   * 有人一直推坏数据/令牌过期时反而看不出来，那是最坑的一种"假健康"。
   */
  ok: boolean
  /** 失败原因（已粗分类的机器可读串，如 invalid_json / unauthorized） */
  error?: string
  /** 以下计数按 kind 选择性填 */
  accepted?: number
  rejected?: number
  unchanged?: number
  pulled?: number
  /** 操作后的服务端游标 */
  cursor: number
  /** 处理耗时（毫秒） */
  ms: number
  /** 面板操作时：delete / restore / optimize */
  action?: string
  /** 面板操作时：涉及的卡片 id */
  cardId?: string
  /** 客户端 IP（尽量取反代真实 IP） */
  ip: string | null
  /** User-Agent 原文，面板据此猜平台 */
  ua: string | null
}

export interface DeviceStat {
  deviceId: string
  firstSeen: number
  lastSeen: number
  /** 推送次数（含失败） */
  pushes: number
  /** 拉取次数（含失败） */
  pulls: number
  /** 累计写入成功的卡片数 */
  cardsWritten: number
  /** 累计拉取到的行数 */
  rowsRead: number
  /** 面板对这台设备发起的操作数（只有面板那台会有） */
  adminOps: number
  /** 累计失败次数 */
  failures: number
  lastIp: string | null
  lastUa: string | null
}

export interface RecordInput {
  kind: EventKind
  deviceId: string
  ok?: boolean
  error?: string
  accepted?: number
  rejected?: number
  unchanged?: number
  pulled?: number
  cursor: number
  ms: number
  action?: string
  cardId?: string
  ip?: string | null
  ua?: string | null
}

/** 某段时间内的粗略活跃度，给面板的「最近一分钟」用 */
export interface ActivityWindow {
  push: number
  pull: number
  admin: number
  failed: number
}

/** 未带身份的请求统一落这个桶，别在面板里伪造一个设备 */
const ANONYMOUS = '(匿名)'

export class Telemetry {
  /** 进程启动时刻 */
  readonly startedAt = Date.now()

  private readonly capacity: number
  private readonly events: SyncEvent[] = []
  private readonly deviceMap = new Map<string, DeviceStat>()
  private nextId = 1

  constructor(capacity = 400) {
    this.capacity = Math.max(20, capacity)
  }

  /** 记一条事件，顺带更新设备画像 */
  record(input: RecordInput): SyncEvent {
    const at = Date.now()
    const event: SyncEvent = {
      id: this.nextId++,
      at,
      kind: input.kind,
      deviceId: input.deviceId || ANONYMOUS,
      ok: input.ok ?? true,
      cursor: input.cursor,
      ms: Math.max(0, Math.round(input.ms)),
      ip: input.ip ?? null,
      ua: input.ua ?? null,
      ...(input.error !== undefined ? { error: input.error } : {}),
      ...(input.accepted !== undefined ? { accepted: input.accepted } : {}),
      ...(input.rejected !== undefined ? { rejected: input.rejected } : {}),
      ...(input.unchanged !== undefined ? { unchanged: input.unchanged } : {}),
      ...(input.pulled !== undefined ? { pulled: input.pulled } : {}),
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.cardId !== undefined ? { cardId: input.cardId } : {})
    }

    this.events.push(event)
    // 超容量就从头削，保持内存恒定
    if (this.events.length > this.capacity) {
      this.events.splice(0, this.events.length - this.capacity)
    }

    this.touchDevice(event)
    return event
  }

  private touchDevice(event: SyncEvent): void {
    const id = event.deviceId
    if (!id || id === ANONYMOUS) return

    const prev = this.deviceMap.get(id)
    const stat: DeviceStat = prev ?? {
      deviceId: id,
      firstSeen: event.at,
      lastSeen: event.at,
      pushes: 0,
      pulls: 0,
      cardsWritten: 0,
      rowsRead: 0,
      adminOps: 0,
      failures: 0,
      lastIp: null,
      lastUa: null
    }

    stat.lastSeen = event.at
    stat.lastIp = event.ip ?? stat.lastIp
    stat.lastUa = event.ua ?? stat.lastUa
    if (!event.ok) stat.failures += 1
    if (event.kind === 'push') {
      stat.pushes += 1
      stat.cardsWritten += event.accepted ?? 0
    } else if (event.kind === 'pull') {
      stat.pulls += 1
      stat.rowsRead += event.pulled ?? 0
    } else {
      stat.adminOps += 1
    }

    this.deviceMap.set(id, stat)
  }

  /**
   * 最近 windowMs 内的活跃度。
   *
   * 面板的「服务健康」不该只看「刚才那个请求成没成」——
   * 一台设备每分钟都在 401，那就不是健康，只是我们没记罢了。
   */
  activity(windowMs = 60_000): ActivityWindow {
    const from = Date.now() - windowMs
    const out: ActivityWindow = { push: 0, pull: 0, admin: 0, failed: 0 }
    for (const e of this.events) {
      if (e.at < from) continue
      if (!e.ok) out.failed += 1
      if (e.kind === 'push') out.push += 1
      else if (e.kind === 'pull') out.pull += 1
      else out.admin += 1
    }
    return out
  }

  /** 事件总数（环形缓冲当前长度，不是历史总量） */
  size(): number {
    return this.events.length
  }

  /** 最新事件 id；没有事件时为 0 */
  latestId(): number {
    const last = this.events[this.events.length - 1]
    return last ? last.id : 0
  }

  /** 取 id > afterId 的最近 limit 条，按时间升序返回（便于面板 append） */
  since(afterId: number, limit = 100): SyncEvent[] {
    const cap = Math.max(1, Math.min(limit, this.capacity))
    const out: SyncEvent[] = []
    for (const e of this.events) {
      if (e.id > afterId) out.push(e)
    }
    return out.slice(Math.max(0, out.length - cap))
  }

  /** 最近 n 条（面板首屏用），时间升序 */
  recent(limit = 60): SyncEvent[] {
    const cap = Math.max(1, Math.min(limit, this.capacity))
    return this.events.slice(Math.max(0, this.events.length - cap))
  }

  /** 设备列表，最近活跃的排前面 */
  devices(): DeviceStat[] {
    return [...this.deviceMap.values()].sort((a, b) => b.lastSeen - a.lastSeen)
  }

  /** 某台设备是否登记过 */
  hasDevice(id: string): boolean {
    return this.deviceMap.has(id)
  }
}
