/**
 * 标题栏用的小图标（内联 SVG）。
 * 之前用字符 `▤` 和 `⚙`，在 12px 下糊成一团，而且 `▤` 完全看不出是「浮窗」。
 */

export function FloatIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      {/* 后面那块 = 底层，前面那块 = 浮在上面的面板 */}
      <rect
        x="1.6"
        y="1.6"
        width="9.2"
        height="7.2"
        rx="1.8"
        stroke="currentColor"
        strokeWidth="1.3"
      />
      <rect
        x="4.4"
        y="6.4"
        width="10"
        height="8"
        rx="1.8"
        fill="var(--surface)"
        stroke="currentColor"
        strokeWidth="1.3"
      />
    </svg>
  )
}

/**
 * 设置图标用「两条滑杆」而不是齿轮：
 * 齿轮在 14px 下，8 根齿会糊成一颗太阳，滑杆永远看得清。
 */
export function SettingsIcon(): React.JSX.Element {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M2 5.2h12M2 10.8h12"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
      <circle cx="6" cy="5.2" r="1.9" fill="var(--surface)" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="10.4" cy="10.8" r="1.9" fill="var(--surface)" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}
