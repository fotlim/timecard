import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@timecard/shared': resolve('../../packages/shared/src/index.ts')
    }
  },
  build: {
    outDir: 'dist',
    // Capacitor 会把 dist 原样打进 APK，别留 sourcemap 占体积
    sourcemap: false,
    target: 'es2020'
  },
  server: {
    port: 5180,
    host: true
  }
})