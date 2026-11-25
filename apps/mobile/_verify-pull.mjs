// 验证：手机端下拉刷新（真实触摸事件 → 触发一次同步）
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROBE_PORT = Number(process.env.TC_PROBE_PORT ?? 3715)
const CDP_PORT = Number(process.env.TC_CDP_PORT ?? 9340)
const PREVIEW = process.env.TC_PREVIEW_URL ?? 'http://127.0.0.1:5188/'
const CHROME = process.env.TC_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const hits = []
const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,accept,x-device-id'
  }
  if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return }
  hits.push(req.url || '')
  const send = (code, obj) => { res.writeHead(code, { ...cors, 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)) }
  const url = req.url || ''
  if (url.startsWith('/api/sync/pull')) { send(200, { changes: [], cursor: 0, hasMore: false, serverTime: Date.now() }); return }
  if (url.startsWith('/api/sync/push')) {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => send(200, { accepted: [], rejected: [], cursor: 0, serverTime: Date.now() }))
    return
  }
  send(404, { error: 'nope' })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, p, d = '') => { results.push([n, p, d]); console.log(`${p ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`) }

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pend = new Map()
    let id = 0
    ws.onopen = () => resolve({
      send: (method, params = {}) => new Promise((res) => { const i = ++id; pend.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) }),
      eval: (expr) => new Promise((res, rej) => {
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
  await new Promise((r) => server.listen(PROBE_PORT, '127.0.0.1', r))
  const now = Date.now()
  const mk = (id, title) => ({
    id, title, items: [], tag: '', color: '#71805a', anchorAt: now, order: 0,
    status: 'open', createdAt: now, updatedAt: now, deletedAt: null, rev: 1
  })
  const seed = {
    skin: 'organic',
    cards: [mk('p1', '下拉测试卡'), mk('p2', '第二张')],
    deviceId: 'm-pull',
    cursor: 0,
    lastSyncAt: null,
    sync: { enabled: true, serverUrl: `http://127.0.0.1:${PROBE_PORT}`, token: 't' },
    outbox: [],
    outboxSeq: 0
  }

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pull-'))
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
  if (!page) throw new Error('CDP 页面没起来')

  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 892, deviceScaleFactor: 2, mobile: true })
  await c.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 })
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'try{localStorage.setItem("timecard.mobile.v1", ' + JSON.stringify(JSON.stringify(seed)) + ')}catch(e){}'
  })
  await c.send('Page.navigate', { url: PREVIEW })
  await sleep(3000)

  check('列表渲染出来了', await c.eval(`!!document.querySelector('.m-list')`))
  const before = hits.length
  check('启动阶段已有同步请求', before >= 1, `hits=${before}`)
  // 让 lastSyncAt 变旧，否则拉取会被 syncIfStale 的节流挡住（这里直接发同步，不判新旧）
  const baseline = hits.length

  // 真实触摸：从顶部往下拽 140px（阻尼后 ~70px，超过 56 的触发阈值）
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 206, y: 400 }] })
  await sleep(60)
  await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 206, y: 470 }] })
  await sleep(60)
  await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 206, y: 540 }] })
  await sleep(60)
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(1200)

  const after = hits.length
  check('下拉后触发了同步请求', after > baseline, `hits ${baseline} -> ${after}`)

  // 轻微下拉（不到阈值）不应该触发
  const baseline2 = hits.length
  await c.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 206, y: 400 }] })
  await sleep(60)
  await c.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 206, y: 430 }] })
  await sleep(60)
  await c.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await sleep(900)
  check('没拉够距离不触发同步', hits.length === baseline2, `hits ${baseline2} -> ${hits.length}`)

  c.close()
  chrome.kill()
  await sleep(200)
  try { fs.rmSync(ud, { recursive: true, force: true }) } catch {}
}

main()
  .catch((e) => check('测试执行', false, String(e && e.message ? e.message : e)))
  .finally(() => {
    try { server.close() } catch {}
    const pass = results.filter((r) => r[1]).length
    console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
    process.exit(pass === results.length && results.length > 0 ? 0 : 1)
  })
