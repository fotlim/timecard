/**
 * 挂卡时间轴 · 核心数据模型
 *
 * 一张「卡」= 一份挂在时间轴上的清单。
 * 时间轴负责回答「什么时候要做什么」，卡片负责回答「这件事还剩几步」。
 */

/* ============================================================
 * 卡片
 * ========================================================== */

/** 卡片里的一个勾选条目 */
export interface CardItem {
  /** 条目 id（uuid v4，客户端生成，离线也不冲突） */
  id: string
  text: string
  done: boolean
}

/**
 * 卡片状态。
 *
 * - `open`     进行中
 * - `done`     已完成（全部条目勾完，或手动标记）
 * - `archived` 已归档（从时间轴上摘下，但还能搜到）
 */
export type CardStatus = 'open' | 'done' | 'archived'

/** 一张挂在时间轴上的清单卡 */
export interface Card {
  /** 卡片 id（uuid v4） */
  id: string
  /** 标题，如「装修这个事」 */
  title: string
  /** 卡片内的勾选条目，按用户顺序排列 */
  items: CardItem[]
  /** 分类标签，如「生活」「工作」「家庭」；空串 = 未分类 */
  tag: string
  /** 卡片主色（CSS 颜色值，如 `#3f6b4e`） */
  color: string

  /* --- 挂载位置 --- */

  /** 挂载时刻：这张卡在时间轴上的绝对时间戳（毫秒） */
  anchorAt: number
  /** 同一时刻内的手动排序，越小越靠上 */
  order: number

  /* --- 状态 --- */

  status: CardStatus

  /* --- 同步元数据（三端共用，务必别漏） --- */

  /** 创建时刻 */
  createdAt: number
  /** 最后修改时刻（本机时钟） */
  updatedAt: number
  /** 软删除时刻；非 null 表示已删除。**永远不要物理删除**，否则同步会把卡复活 */
  deletedAt: number | null
  /** 单调递增的修订号，每次本地修改 +1，用于 LWW 决胜 */
  rev: number
}

/* ============================================================
 * 派生状态（只读计算，不落库）
 * ========================================================== */

/** 卡片完成度 */
export interface CardProgress {
  /** 已完成条目数 */
  done: number
  /** 条目总数 */
  total: number
  /** 完成比例 0–1；没有条目时为 0 */
  ratio: number
  /** 是否已全部完成（无条目时视为未完成） */
  complete: boolean
}

/**
 * 卡片紧急度。
 *
 * - `done`     已完成
 * - `archived` 已归档
 * - `overdue`  已逾期（挂载时刻早于今天零点）
 * - `today`    今天到期
 * - `upcoming` 未来到期
 */
export type CardUrgency = 'done' | 'archived' | 'overdue' | 'today' | 'upcoming'

/* ============================================================
 * 皮肤
 * ========================================================== */

/** 三套视觉风格 */
export type Skin = 'organic' | 'brutal' | 'neo'

/** 全部皮肤，按展示顺序 */
export const SKINS = ['organic', 'brutal', 'neo'] as const satisfies readonly Skin[]

/** 皮肤中文名 */
export const SKIN_LABELS: Record<Skin, string> = {
  organic: '自然有机',
  brutal: '野兽派',
  neo: '新拟物质',
}

/** 皮肤一句话性格（用于设置页说明） */
export const SKIN_TAGLINES: Record<Skin, string> = {
  organic: '米纸底、森林绿、宋体标题，像从便签本上撕下来的一张纸。',
  brutal: '黑线、黄底、零圆角、硬投影，像把卡片拍在桌上。',
  neo: '同色系里做双向阴影，凹是陷进去，凸是浮起来。',
}

/** 默认皮肤 */
export const DEFAULT_SKIN: Skin = 'brutal'

/* ============================================================
 * 设备 / 账号
 * ========================================================== */

/** 客户端设备标识，用于同步时区分来源 */
export interface DeviceInfo {
  /** 设备 id（uuid v4，首次启动生成并存本地） */
  id: string
  /** 人类可读名字，如「客厅的 Surface」 */
  name: string
  /** 平台 */
  platform: 'desktop' | 'mobile' | 'web'
}

/* ============================================================
 * 工厂
 * ========================================================== */

/** 最小 crypto 接口（不依赖 DOM / Node 的类型声明，三端通用） */
interface RandomUuidSource {
  randomUUID?: () => string
}

/** 生成 uuid v4（优先用 crypto.randomUUID，退化到 Math.random） */
export function newId(): string {
  const source = (globalThis as { crypto?: RandomUuidSource }).crypto
  if (typeof source?.randomUUID === 'function') return source.randomUUID()
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0
    const v = ch === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

/** 新建一张卡片（默认挂在 now） */
export function createCard(partial: Partial<Card> = {}, now = Date.now()): Card {
  return {
    id: newId(),
    title: '',
    items: [],
    tag: '',
    color: '#3f6b4e',
    anchorAt: now,
    order: 0,
    status: 'open',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    rev: 1,
    ...partial,
  }
}

/** 新建一个条目 */
export function createCardItem(text: string, done = false): CardItem {
  return { id: newId(), text, done }
}
