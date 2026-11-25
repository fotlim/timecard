/**
 * 冒烟测试：验证时间轴纯函数的边界（周一为周起点、跨年周、逾期天数）。
 * 运行：node --experimental-strip-types packages/shared/src/__smoke.ts
 */

import {
  addDays,
  clockLabel,
  createCard,
  createCardItem,
  dayKey,
  daysBetween,
  isNewer,
  mergeCards,
  progressLabel,
  progressOf,
  rangeLabel,
  startOfDay,
  startOfWeek,
  urgencyLabel,
  urgencyOf,
  weekKey,
  weekdayIndex,
} from './index.js'

let failed = 0
function eq(actual: unknown, expected: unknown, label: string): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  if (!ok) {
    failed += 1
    console.error(`  ✗ ${label}\n    期望 ${JSON.stringify(expected)}\n    实际 ${JSON.stringify(actual)}`)
  } else {
    console.log(`  ✓ ${label}`)
  }
}

// 2026-11-23 是周一
const MON = new Date(2026, 10, 23, 9, 30).getTime()
const WED = new Date(2026, 10, 25, 14, 5).getTime()
const SUN = new Date(2026, 10, 29, 23, 59).getTime()

console.log('时间轴：')
eq(dayKey(MON), '2026-11-23', 'dayKey')
eq(clockLabel(MON), '09:30', 'clockLabel')
eq(weekdayIndex(MON), 0, '周一是 0')
eq(weekdayIndex(WED), 2, '周三是 2')
eq(weekdayIndex(SUN), 6, '周日是 6')
eq(startOfWeek(SUN) === startOfDay(MON), true, '周日归到本周一')
eq(weekKey(MON), '2026-W48', 'weekKey 周一')
eq(weekKey(SUN), '2026-W48', 'weekKey 同一周')
eq(weekKey(addDays(MON, 7)), '2026-W49', 'weekKey 下一周')
eq(rangeLabel(MON, addDays(MON, 6)), '11/23 – 29', 'rangeLabel 同月')
eq(daysBetween(MON, addDays(MON, 3)), 3, 'daysBetween')

console.log('跨年周（ISO 8601）：')
eq(weekKey(new Date(2027, 0, 1).getTime()), '2026-W53', '2027-01-01 属于 2026 第 53 周')
eq(weekKey(new Date(2026, 11, 31).getTime()), '2026-W53', '2026-12-31 同周')

console.log('进度与紧急度：')
const card = createCard({ title: '装修这个事', anchorAt: MON })
card.items = [createCardItem('买灯具'), createCardItem('施工对接'), createCardItem('预算复核', true)]
const p = progressOf(card)
eq([p.done, p.total], [1, 3], '进度 1/3')
eq(progressLabel(p), '1/3', '进度文案')

const oneLeft = { ...card, items: [createCardItem('a', true), createCardItem('b')] }
eq(progressLabel(progressOf(oneLeft)), '还差一步', '还差一步')

eq(urgencyOf(card, MON), 'today', '今天到期')
eq(urgencyLabel('overdue', 2), '逾期 2 天', '逾期文案')
eq(urgencyOf(card, addDays(MON, 2)), 'overdue', '两天后算逾期')
eq(urgencyOf(card, addDays(MON, -30)), 'upcoming', '未来')

console.log('LWW 决胜：')
eq(isNewer({ updatedAt: 200, deviceId: 'a' }, { updatedAt: 100, deviceId: 'z' }), true, '时间戳大的赢')
eq(isNewer({ updatedAt: 100, deviceId: 'b' }, { updatedAt: 100, deviceId: 'a' }), true, '同时刻按 id 字典序')
eq(isNewer({ updatedAt: 100, deviceId: 'a' }, { updatedAt: 100, deviceId: 'a' }), false, '完全相同不覆盖')

const older = { card: createCard({ title: '旧', updatedAt: 100 }), deviceId: 'a' }
const newer = { card: createCard({ title: '新', updatedAt: 200 }), deviceId: 'b' }
eq(mergeCards(older, newer).card.title, '新', 'merge 取新的')
eq(mergeCards(newer, older).card.title, '新', 'merge 对称')

console.log('')
if (failed > 0) {
  console.error(`✗ ${failed} 条失败`)
  process.exit(1)
}
console.log('✓ 全部通过')
