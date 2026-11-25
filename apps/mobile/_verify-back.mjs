// 验证：安卓返回键的 Web 端钩子 window.__tcBack()（先关抽屉/筛选，否则 false）
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP_PORT = Number(process.env.TC_CDP_PORT ?? 9339)
const PREVIEW = process.env.TC_PREVIEW_URL ?? 'http://127.0.0.1:5189/'
const CHROME = process.env.TC_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, p, d = '') => {
  results.push([n, p, d])
  console.log(`${p ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`)
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pend = new Map()
    let id = 0
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }),
        eval: (expr) =>
          new Promise((res, rej) => {
            const i = ++id
            pend.set(i, (r) => { if (r && r.exceptionDetails) rej(new Error(r.exceptionDetails.text)); else res(r && r.result && r.result.value) })
            ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
          }),
        close: () => ws.close()
      })
    ws.onerror = reject
    ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m.result); pend.delete(m.id) } }
  })
}

async function main() {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-back-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ud}`, 'about:blank'
  ], { stdio: 'ignore' })
  let page
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      if (r.ok) { const all = (await r.json()).filter((t) => t.type === 'page'); if (all[0]) { page = all[0]; break } }
    } catch {}
    await sleep(200)
  }
  if (!page) throw new Error('no page')
  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 892, deviceScaleFactor: 2, mobile: true })
  await c.send('Page.navigate', { url: PREVIEW })
  await sleep(2200)

  check('__tcBack 钩子已注册', await c.eval(`typeof window.__tcBack === 'function'`))
  check('无抽屉/筛选时返回 false', (await c.eval(`window.__tcBack()`)) === 'false')

  await c.eval(`document.querySelector('.m-add').click()`)
  await sleep(400)
  check('打开新建抽屉', await c.eval(`!!document.querySelector('.sheet')`))
  const r1 = await c.eval(`window.__tcBack()`)
  await sleep(300)
  check('返回键先关抽屉并返回 true', r1 === 'true' && !(await c.eval(`!!document.querySelector('.sheet')`)), `ret=${r1}`)

  await c.eval(`document.querySelector('.m-filter').click()`)
  await sleep(300)
  check('打开筛选条', await c.eval(`!!document.querySelector('.m-filterbar')`))
  const r2 = await c.eval(`window.__tcBack()`)
  await sleep(300)
  check('返回键再关筛选并返回 true', r2 === 'true' && !(await c.eval(`!!document.querySelector('.m-filterbar')`)), `ret=${r2}`)

  check('都关完后返回 false', (await c.eval(`window.__tcBack()`)) === 'false')

  c.close(); chrome.kill(); await sleep(200)
  try { fs.rmSync(ud, { recursive: true, force: true }) } catch {}
}

main()
  .catch((e) => check('测试执行', false, String(e && e.message ? e.message : e)))
  .finally(() => {
    const pass = results.filter((r) => r[1]).length
    console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
    process.exit(pass === results.length && results.length > 0 ? 0 : 1)
  })
