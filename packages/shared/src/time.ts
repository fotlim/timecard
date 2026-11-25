/**
 * 挂卡时间轴 · 时间轴纯函数
 *
 * 全部是纯函数，不碰 DOM、不碰状态，三端共用、可直接单测。
 * 约定：一周从**周一**开始；所有函数接受毫秒时间戳，返回毫秒时间戳或字符串。
 */

const DAY_MS = 86_400_000

/** 当天零点 */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** 加 N 天（自动跨月跨年） */
export function addDays(ts: number, days: number): number {
  const d = new Date(ts)
  d.setDate(d.getDate() + days)
  return d.getTime()
}

/** 本周一零点（周一为一周起点） */
export function startOfWeek(ts: number): number {
  const day = startOfDay(ts)
  const weekday = (new Date(day).getDay() + 6) % 7 // 周一=0 … 周日=6
  return addDays(day, -weekday)
}

/** 下周一零点（本周的右开边界） */
export function endOfWeek(ts: number): number {
  return addDays(startOfWeek(ts), 7)
}

/** 是否同一天 */
export function isSameDay(a: number, b: number): boolean {
  return startOfDay(a) === startOfDay(b)
}

/** 两个时刻相差几天（按自然日取整，向下取） */
export function daysBetween(from: number, to: number): number {
  return Math.floor((startOfDay(to) - startOfDay(from)) / DAY_MS)
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/** `2026-11-21` */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/**
 * ISO 8601 周号：`2026-W47`
 *
 * 规则：含 1 月 4 日的那一周为第 1 周。跨年周会正确归属到上一年或下一年。
 */
export function weekKey(ts: number): string {
  const monday = new Date(startOfWeek(ts))
  // 该周的周四决定它属于哪一年
  const thursday = new Date(addDays(monday.getTime(), 3))
  const year = thursday.getFullYear()

  // 当年 1 月 4 日所在周的周一，作为第 1 周的起点
  const jan4 = new Date(year, 0, 4)
  const jan4Weekday = (jan4.getDay() + 6) % 7
  const firstMonday = addDays(startOfDay(jan4.getTime()), -jan4Weekday)

  const week = Math.round((monday.getTime() - firstMonday) / (7 * DAY_MS)) + 1
  return `${year}-W${pad2(week)}`
}

/** `09:30` */
export function clockLabel(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** `11/17` */
export function shortDay(ts: number): string {
  const d = new Date(ts)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

/** 周一…周日 */
export const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'] as const

/** 短版：一…日 */
export const WEEKDAY_SHORT = ['一', '二', '三', '四', '五', '六', '日'] as const

/** 取某个时刻是本周第几天（周一=0 … 周日=6） */
export function weekdayIndex(ts: number): number {
  return (new Date(ts).getDay() + 6) % 7
}

/** 周范围文案：`11/17 – 11/23`；跨月自动带月份 */
export function rangeLabel(start: number, end: number): string {
  const s = new Date(start)
  const e = new Date(end)
  return s.getMonth() === e.getMonth()
    ? `${s.getMonth() + 1}/${s.getDate()} – ${e.getDate()}`
    : `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`
}

/** 把一天切成 `slots` 个时刻（用于时间轴刻度），返回毫秒数组 */
export function timeSlots(dayStart: number, slots: number): number[] {
  const step = DAY_MS / slots
  return Array.from({ length: slots }, (_, i) => dayStart + Math.round(i * step))
}
