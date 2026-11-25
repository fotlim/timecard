import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

const sharedAlias = {
  '@timecard/shared': resolve('../../packages/shared/src/index.ts')
}

export default defineConfig({
  main: {
    // 共享层是 workspace 里的 TS 源码，必须打进来，不能当外部依赖
    plugins: [externalizeDepsPlugin({ exclude: ['@timecard/shared'] })],
    resolve: { alias: sharedAlias }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: sharedAlias }
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        ...sharedAlias
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          quick: resolve('src/renderer/quick.html'),
          settings: resolve('src/renderer/settings.html')
        }
      }
    }
  }
})