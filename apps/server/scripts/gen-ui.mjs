/**
 * 把 src/admin-ui.html 内联成 src/admin-ui.generated.ts 里的一段字符串。
 *
 * 为什么要这一步：
 *   - tsc 只吃 .ts，不吃 .html；直接 import html 会编译失败；
 *   - Worker 打包也必须把页面塞进 bundle，不能依赖运行时读文件；
 *   - 用 JSON.stringify 转义，页面里的反引号 / ${} / 引号全都不用操心。
 *
 * 改完 admin-ui.html 记得跑一次（build / bundle 已自动带上）。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const srcPath = join(here, '..', 'src', 'admin-ui.html')
const outPath = join(here, '..', 'src', 'admin-ui.generated.ts')

const html = readFileSync(srcPath, 'utf8')

// 基本自检：防止把写了一半的页面打包出去（历史上真踩过这种坑）
if (html.indexOf('<div id="app"') < 0 || html.indexOf('</html>') < 0) {
  throw new Error('[gen-ui] admin-ui.html 看起来不完整，拒绝生成')
}

// JSON.stringify 不转义 U+2028/2029，而它们在旧解析器里算换行 —— 手动补上
const json = JSON.stringify(html).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')

const banner =
  '/* 自动生成，请勿手改 —— 源文件是 src/admin-ui.html，改完跑 node scripts/gen-ui.mjs */\n'
const out = `${banner}export const ADMIN_HTML: string = ${json}\n`

writeFileSync(outPath, out, 'utf8')
console.log(`[gen-ui] ${html.length} chars -> src/admin-ui.generated.ts`)
