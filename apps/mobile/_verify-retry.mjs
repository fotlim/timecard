// 手机端同步「失败 → 退避重试 → 恢复」端到端验证
// 组成：一个可控探针服务器（down 时 503 / up 时 200）+ Chrome 预览 + CDP 注入同步配置
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const PROBE_PORT = Number(process.env.TC_PROBE_PORT ?? 3714)
const CDP_PORT = Number(process.env.TC_CDP_PORT ?? 9337)
const PREVIEW = process.env.TC_PREVIEW_URL ?? 'http://127.0.0.1:5191/'
const PREVIEW_ORIGIN = new URL(PREVIEW).origin
const CHROME = process.env.TC_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const hits = []
let mode = 'down' // 'down' -> 503, 'up' -> 200

const server = http.createServer((req, res) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'authorization,content-type,accept,x-device-id'
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return
  }
  const url = req.url || ''
  hits.push({ t: Date.now(), method: req.method, url, mode })
  const send = (code, obj) => {
    res.writeHead(code, { ...cors, 'Content-Type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (mode === 'down') {
    send(503, { error: 'probe_down' })
    return
  }
  if (url.startsWith('/api/sync/pull')) {
    send(200, { changes: [], cursor: 0, hasMore: false, serverTime: Date.now() })
    return
  }
  if (url.startsWith('/api/sync/push')) {
    // 读掉请求体再回
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () =>
      send(200, { accepted: [], rejected: [], cursor: 0, serverTime: Date.now() })
    )
    return
  }
  send(404, { error: 'nope' })
})

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pend = new Map()
    let id = 0
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res) => {
            const i = ++id
            pend.set(i, res)
            ws.send(JSON.stringify({ id: i, method, params }))
          }),
        eval: (expr) =>
          new Promise((res, rej) => {
            const i = ++id
            pend.set(i, (r) => {
              if (r && r.exceptionDetails) rej(new Error(r.exceptionDetails.text))
              else res(r && r.result && r.result.value)
            })
            ws.send(
              JSON.stringify({
                id: i,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true, awaitPromise: true }
              })
            )
          }),
        close: () => ws.close()
      })
    ws.onerror = reject
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)(m.result)
        pend.delete(m.id)
      }
    }
  })
}

function waitFor(pred, timeoutMs, stepMs = 400) {
  const t0 = Date.now()
  return new Promise((resolve) => {
    const tick = () => {
      if (pred()) return resolve(true)
      if (Date.now() - t0 > timeoutMs) return resolve(false)
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

async function main() {
  await new Promise((r) => server.listen(PROBE_PORT, '127.0.0.1', r))
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-retry-'))
  const chrome = spawn(
    CHROME,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--hide-scrollbars',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${ud}`,
      'about:blank'
    ],
    { stdio: 'ignore' }
  )

  let page
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      if (r.ok) {
        const all = (await r.json()).filter((t) => t.type === 'page')
        if (all[0]) {
          page = all[0]
          break
        }
      }
    } catch {}
    await sleep(200)
  }
  if (!page) throw new Error('CDP 页面没起来')

  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Emulation.setDeviceMetricsOverride', {
    width: 412,
    height: 892,
    deviceScaleFactor: 2,
    mobile: true
  })
  // 在页面脚本执行前注入同步配置（指向探针）
  const seed = {
    skin: 'organic',
    cards: [],
    deviceId: 'm-retry-test',
    cursor: 0,
    lastSyncAt: null,
    sync: { enabled: true, serverUrl: `http://127.0.0.1:${PROBE_PORT}`, token: 't' },
    outbox: [],
    outboxSeq: 0
  }
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source:
      'try{localStorage.setItem("timecard.mobile.v1", ' +
      JSON.stringify(JSON.stringify(seed)) +
      ')}catch(e){}'
  })
  await c.send('Page.navigate', { url: PREVIEW })
  await sleep(2500) // 让 App 挂载并触发首次 syncIfStale

  check('应用已加载', await c.eval(`!!document.querySelector('.screen')`))
  check('首次同步请求已发出（此刻服务器是 down）', hits.length >= 1, `hits=${hits.length}`)

  // 等退避重试：应在几秒内再打一次
  const retried = await waitFor(() => hits.length >= 2, 8000)
  check('失败后自动退避重试（未手动操作）', retried, `hits=${hits.length}`)

  // 切到 up，等下一次重试成功
  mode = 'up'
  const okHit = await waitFor(() => hits.some((h) => h.mode === 'up'), 15000)
  check('服务器恢复后自动重试成功（探测到 up 命中）', okHit, `hits=${hits.length}`)

  // 成功之后 lastSyncAt 应被写入本地
  const syncedOk = await waitFor(
    () =>
      c.eval(`(() => { try { const s = JSON.parse(localStorage.getItem('timecard.mobile.v1')); return !!(s && s.lastSyncAt) } catch(e){ return false } })()`).then(
        (v) => v === true
      ),
    5000
  )
  check('恢复后 lastSyncAt 已落盘', syncedOk)

  const state = await c.eval(
    `(() => { try { const s = JSON.parse(localStorage.getItem('timecard.mobile.v1')); return { outbox: (s.outbox||[]).length, lastSyncAt: s.lastSyncAt||0 } } catch(e){ return { err: String(e) } } })()`
  )
  check('Outbox 未被异常塞满', state && state.outbox === 0, JSON.stringify(state))

  c.close()
  chrome.kill()
  await sleep(200)
  try {
    fs.rmSync(ud, { recursive: true, force: true })
  } catch {}
}

main()
  .catch((e) => check('测试执行', false, String(e && e.message ? e.message : e)))
  .finally(async () => {
    try {
      server.close()
    } catch {}
    const pass = results.filter((r) => r[1]).length
    console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
    process.exit(pass === results.length && results.length > 0 ? 0 : 1)
  })
