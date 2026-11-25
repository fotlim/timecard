import { clockLabel, progressOf, urgencyOf, overdueDaysOf } from '@timecard/shared'
import type { Card } from '@timecard/shared'

interface HangCardProps {
  card: Card
  onToggleItem: (cardId: string, itemId: string) => void
  /** 右键：交给父组件去组菜单（菜单内容跟皮肤、场景有关，不在卡片里定） */
  onMenu?: (e: React.MouseEvent, card: Card) => void
  /** 双击打开编辑器 */
  onEdit?: (card: Card) => void
  /** 允许拖动改期（周视图用；今日视图不需要） */
  draggable?: boolean
}

export function HangCard({
  card,
  onToggleItem,
  onMenu,
  onEdit,
  draggable = false
}: HangCardProps): React.JSX.Element {
  const progress = progressOf(card)
  const urgency = urgencyOf(card)
  const overdue = overdueDaysOf(card)
  const isDone = card.status === 'done' || progress.complete
  // 只给逾期打红旗；「今天」由日期节点本身表达，不必每张卡重复一遍
  const alertText = urgency === 'overdue' ? (overdue > 0 ? `逾期 ${overdue} 天` : '逾期') : ''

  return (
    <article
      className={`card${urgency === 'overdue' ? ' alert' : ''}${isDone ? ' is-done' : ''}`}
      onContextMenu={(e) => {
        // 卡片上的右键归卡片，别冒泡到空白处的菜单
        e.preventDefault()
        e.stopPropagation()
        onMenu?.(e, card)
      }}
      onDoubleClick={() => onEdit?.(card)}
      draggable={draggable}
      onDragStart={(e) => {
        if (!draggable) return
        e.dataTransfer.setData('text/timecard-card', card.id)
        e.dataTransfer.effectAllowed = 'move'
        // 拖起来的时候稍微虚化，给人"拿起来了"的反馈
        ;(e.currentTarget as HTMLElement).classList.add('dragging')
      }}
      onDragEnd={(e) => {
        ;(e.currentTarget as HTMLElement).classList.remove('dragging')
      }}
    >
      <div className="meta-top">
        <span className="tag">{card.tag || '未分类'}</span>
        {alertText && <span className="flag">{alertText}</span>}
      </div>

      <h3>{card.title}</h3>

      {card.items.length > 0 && (
        <ul className="checks">
          {card.items.map((item) => (
            <li key={item.id}>
              <label className="check">
                <input
                  type="checkbox"
                  checked={item.done}
                  onChange={() => onToggleItem(card.id, item.id)}
                />
                <span className="box" />
                <span className="txt">{item.text}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="card-foot">
        <span className="note">
          {clockLabel(card.anchorAt)} 挂上 · {progress.total} 个待办
        </span>
        <span className="count">
          {progress.done}/{progress.total}
        </span>
      </div>
    </article>
  )
}
