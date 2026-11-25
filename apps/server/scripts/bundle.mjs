/**
 * 打成单文件 dist/server.mjs（94 KB）
 *
 * 为什么：部署到别人的 Linux 主机时，不该要求对方装依赖。
 * 单文件 = 一个 scp + 一条 node 命令就能跑。
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['src/node.ts'],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: 'dist/server.mjs',
  // node:sqlite 是内置模块，不能被捆进去
  external: ['node:sqlite'],
  logLevel: 'info',
  banner: { js: '// 挂卡时间轴同步服务器 · 单文件打包（含 hono 与 shared）' }
})

console.log('bundled -> dist/server.mjs')