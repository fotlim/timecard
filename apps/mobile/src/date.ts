/**
 * 移动端日期小工具（纯函数，能单测）
 *
 * 单独拎出来，是因为这几个判断最容易出「跨零点」「时间被归零」这类
 * 只有真机/长时间挂机才会暴露的 bug —— 放在 App.tsx 里就只能靠肉眼盯。
 */

import { progressOf, startOfDay } from '@timecard/shared'
import type { Card } from '@timecard/shared'

/** 卡是否算「做完」：手动标了 done，或者条目全勾完 */
export function isCardDone(card: Card): boolean {
  return card.status === 'done' || progressOf(card).complete
}

/**
 * 把 `like` 的时:分:秒搬到 `dayStart` 那一天。
 *
 * 换日期只该换「日」，不该把 09:30 抹成 00:00 —— 之前所有日期 chip 都写零点，
 * 每张新卡都显示「00:00 挂上」，编辑时点一下 chip 还会把原时刻冲掉。
 */
export function atOnDay(dayStart: number, like: number): number {
  const src = new Date(like)
  const target = new Date(dayStart)
  target.setHours(src.getHours(), src.getMinutes(), src.getSeconds(), 0)
  return target.getTime()
}

/**
 * 逾期：挂载日早于今天。
 *
 * **故意不看 status**：之前用 urgencyOf() 判断（done 直接返回 'done'），
 * 勾掉逾期卡的最后一项后，它会被逾期区排掉、当天区又只认当天，
 * 卡片就当场从屏幕上凭空消失了，还找不到任何往期入口。
 */
export function isOverdueCard(card: Card, today: number): boolean {
  return card.status !== 'archived' && startOfDay(card.anchorAt) < today
}
