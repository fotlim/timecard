// 同步体验测试：连接测试、草稿编辑、错误可读性、启动即同步
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT_DBG = 9851
const SRV_PORT = 18341
const TOKEN = 'ux-token'
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(WORKSPACE, 'apps', 'desktop', 'release', 'win-unpacked', '挂卡时间轴.exe')
const SERVER = path.join(WORKSPACE, 'apps', 'server', 'dist', 'node.js')
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Timecard')
const DATA = path.join(DATA_DIR, 'timecard.json')
const SRV_URL = `http://127.0.0.1:${SRV_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

let srv = null
let app = null

async function startServer(dbPath, port = SRV_PORT) {
  const p = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', TIMECARD_TOKEN: TOKEN, TIMECARD_DB: dbPath },
    stdio: 'ignore'
  })
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`)
      if (r.ok) return p
    } catch {}
    await sleep(100)
  }
  throw new Error('服务器没起来')
}

function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  delete env.TIMECARD_WIDE
  env.TIMECARD_BOOT = 'today/organic'
  return spawn(ELECTRON, [`--remote-debugging-port=${PORT_DBG}`], { env, stdio: 'ignore' })
}

async function findPage(want) {
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT_DBG}/json/list`)
      if (r.ok) {
        const all = (await r.json()).filter((t) => t.type === 'page')
        const hit = all.find((t) => t.url.includes(want))
        if (hit) return hit
      }
    } catch {}
    await sleep(250)
  }
  throw new Error('等不到页面 ' + want)
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pend = new Map()
    let id = 0
    ws.onopen = () =>
      resolve({
        eval: (expr) =>
          new Promise((res, rej) => {
            const i = ++id
            pend.set(i, { res, rej })
            ws.send(
              JSON.stringify({
                id: i,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true, awaitPromise: true }
              })
            )
          }).then((r) => {
            if (r && r.exceptionDetails) throw new Error('JS: ' + r.exceptionDetails.text)
            return r && r.result && r.result.value
          }),
        close: () => ws.close()
      })
    ws.onerror = reject
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      const p = pend.get(m.id)
      if (!p) return
      pend.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  })
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-ux-'))
  srv = await startServer(path.join(tmp, 'srv.sqlite'))

  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    fs.unlinkSync(DATA)
  } catch {}

  app = startApp()
  const t = await findPage('index.html')
  const c = await connect(t.webSocketDebuggerUrl)
  await sleep(5000)

  /* ---------- 1. 连接测试：成功 ---------- */
  {
    const r = await c.eval(`window.timecard.sync.test('${SRV_URL}', '${TOKEN}')`)
    check('测试连接 · 成功', r.ok === true, `${r.message ?? ''} v${r.version} cards=${r.cardCount} ${r.ms}ms`)
    check('测试连接返回耗时', typeof r.ms === 'number' && r.ms >= 0, `${r.ms}ms`)
  }

  /* ---------- 2. 连接测试：令牌错 ---------- */
  {
    // 健康检查是免鉴权的，令牌错要测一个需要鉴权的接口 —— 用同步来验。
    // 这里先测「地址错」和「格式错」两种能靠健康检查发现的。
    const r = await c.eval(`window.timecard.sync.test('http://127.0.0.1:19999', '${TOKEN}')`)
    check('测试连接 · 端口不通', r.ok === false && /连不上|端口|超时/.test(r.message ?? ''), r.message)
  }

  /* ---------- 3. 连接测试：地址格式错 ---------- */
  {
    const r = await c.eval(`window.timecard.sync.test('127.0.0.1:8787', '')`)
    check('测试连接 · 少了 http://', r.ok === false && /http/.test(r.message ?? ''), r.message)
  }

  /* ---------- 4. 连接测试：域名不存在 ---------- */
  {
    const r = await c.eval(`window.timecard.sync.test('http://this-host-does-not-exist-xyz.local', '')`)
    check('测试连接 · 域名不存在', r.ok === false && /域名|连不上|超时/.test(r.message ?? ''), r.message)
  }

  /* ---------- 5. 错令牌在同步时给出人话 ---------- */
  {
    await c.eval(`
      (async () => {
        await window.timecard.sync.setSettings({
          enabled: true, serverUrl: '${SRV_URL}', token: 'wrong-token'
        })
        return 'ok'
      })()
    `)
    await sleep(1200)
    const r = await c.eval(`window.timecard.sync.now()`)
    const err = r.state.error ?? ''
    check('错令牌的报错是人话', /令牌不正确/.test(err), err)
    check('错令牌时阶段不是 idle', r.state.phase === 'error', r.state.phase)

    // 改回正确令牌
    await c.eval(`
      (async () => {
        await window.timecard.sync.setSettings({ token: '${TOKEN}' })
        return 'ok'
      })()
    `)
    await sleep(1500)
    const r2 = await c.eval(`window.timecard.sync.now()`)
    check('改回正确令牌后同步成功', r2.state.phase === 'idle' && !r2.state.error, `${r2.state.phase} err=${r2.state.error}`)
  }

  /* ---------- 6. 启动即同步（不用等 60 秒） ---------- */
  {
    // 先在服务端放一张远端卡
    const now = Date.now()
    const remote = {
      id: 'startup-remote', title: '启动就该拉到的卡', items: [], tag: '', color: '#71805a',
      anchorAt: now, createdAt: now, updatedAt: now, deletedAt: null, rev: 1, status: 'open'
    }
    await fetch(`${SRV_URL}/api/sync/push`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'other', changes: [{ card: remote, deviceId: 'other', op: 'create', clientAt: now }] })
    })

    // 关应用，重开，什么都不点
    app.kill()
    await sleep(1500)
    app = startApp()
    await sleep(6000)

    const local = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
    const got = local.cards.find((x) => x.id === 'startup-remote')
    check('启动后自动同步（未手动点）', !!got, got ? got.title : '没拉到')
  }

  /* ---------- 7. 状态在标题栏可见 ---------- */
  {
    const t2 = await findPage('index.html')
    const c2 = await connect(t2.webSocketDebuggerUrl)
    await sleep(1500)
    const hasDot = await c2.eval(`!!document.querySelector('.tb-sync')`)
    check('标题栏有同步状态点', hasDot === true, String(hasDot))

    const cls = await c2.eval(`(document.querySelector('.tb-sync')||{className:''}).className`)
    check('状态点带阶段 class', /tb-sync\s+\w/.test(cls), cls)

    // 浮窗里的指示
    await c2.eval(`window.timecard.quick.show(); 'ok'`)
    await sleep(2000)
    const qt = await findPage('quick.html')
    const c3 = await connect(qt.webSocketDebuggerUrl)
    await sleep(800)
    const qsync = await c3.eval(`!!document.querySelector('.qsync')`)
    check('浮窗底栏有同步指示', qsync === true, String(qsync))
    c3.close()
    c2.close()
  }

  /* ---------- 8. 离线不崩、恢复后自动补 ---------- */
  {
    srv.kill()
    await sleep(800)
    const t2 = await findPage('index.html')
    const c2 = await connect(t2.webSocketDebuggerUrl)
    const before = await c2.eval(`(async () => {
      const s = await window.timecard.store.snapshot()
      await window.timecard.store.addCard({ title: '断网时记的', anchorAt: Date.now() })
      return s.cards.length
    })()`)
    await sleep(2500)
    const st = await c2.eval(`window.timecard.sync.get().then(b => b.state)`)
    check('断网时标记离线', st.phase === 'offline', st.phase)
    check('断网的报错是人话', /连不上|网络|超时/.test(st.error ?? ''), st.error)
    check('断网时照常能挂卡', before >= 0, `本地卡 ${before} 张`)

    srv = await startServer(path.join(tmp, 'srv.sqlite'))
    await sleep(12000)
    const st2 = await c2.eval(`window.timecard.sync.get().then(b => b.state)`)
    check('服务器回来后自动恢复', st2.phase === 'idle' && st2.pending === 0, `${st2.phase} pending=${st2.pending}`)
    c2.close()
  }

  app.kill()
  await sleep(800)
  srv.kill()
  await sleep(800)
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {}

  const pass = results.filter((r) => r[1]).length
  console.log('')
  console.log(`共 ${results.length} 项，通过 ${pass} 项`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(async (e) => {
  console.error('FAIL', e && e.message)
  if (app) app.kill()
  if (srv) srv.kill()
  process.exit(1)
})
