import type { CapacitorConfig } from '@capacitor/cli'

/**
 * Capacitor 7 · Android
 * webDir 指向 vite 的产物，`npx cap sync android` 会把它拷进 android/app/src/main/assets/public
 */
const config: CapacitorConfig = {
  appId: 'com.timecard.mobile',
  appName: '挂卡时间轴',
  webDir: 'dist',
  android: {
    // 主题色跟皮肤走由前端控制，这里只保证启动时不出现白闪
    backgroundColor: '#f1ebdf'
  },
  server: {
    // 只在调试时用：让真机/模拟器直接连 vite dev server
    // androidScheme: 'https'
  }
}

export default config