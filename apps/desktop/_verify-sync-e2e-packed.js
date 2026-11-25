// 桌面端 ⇄ 服务端 同步端到端测试
// 起一个真服务器，开一个真 Electron 客户端，全部走真 HTTP。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT_DBG = 9821
const SRV_PORT = 18331
const TOKEN = 'sync-e2e-token'
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(WORKSPACE, 'apps', 'desktop', 'release', 'win-unpacked', '挂卡时间轴.exe')
const SERVER = path.join(WORKSPACE, 'apps', 'server', 'dist', 'node.js')
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Timecard')
const DATA = path.join(DATA_DIR, 'timecard.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

let srv = null
let app = null

async function startServer(dbPath) {
  srv = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(SRV_PORT),
      HOST: '127.0.0.1',
      TIMECARD_TOKEN: TOKEN,
      TIMECARD_DB: dbPath
    },
    stdio: 'ignore'
  })
  for (let i = 0; i < 120; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${SRV_PORT}/api/health`)
      if (r.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('服务器没起来')
}

function startApp() {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_BOOT
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

const readData = () => JSON.parse(fs.readFileSync(DATA, 'utf-8'))

async function srvPull(since = 0) {
  const r = await fetch(`http://127.0.0.1:${SRV_PORT}/api/sync/pull?since=${since}`, {
    headers: { Authorization: `Bearer ${TOKEN}` }
  })
  return r.json()
}

async function srvPush(body) {
  const r = await fetch(`http://127.0.0.1:${SRV_PORT}/api/sync/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  return r.json()
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-sync-'))
  const serverDb = path.join(tmp, 'srv.sqlite')
  await startServer(serverDb)

  // 干净的客户端数据
  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    fs.unlinkSync(DATA)
  } catch {}

  app = startApp()
  const t = await findPage('index.html')
  const c = await connect(t.webSocketDebuggerUrl)
  await sleep(5000)

  const syncState = () =>
    c.eval(`(async () => {
      const b = await window.timecard.sync.get()
      return { phase: b.state.phase, pending: b.state.pending, cursor: b.state.cursor,
               enabled: b.settings.enabled, url: b.settings.serverUrl, last: b.state.lastSyncAt }
    })()`)

  /* ---------- 1. 初始：未启用 ---------- */
  {
    const st = await syncState()
    check('初始未启用同步', st.enabled === false, JSON.stringify(st))
  }

  /* ---------- 2. 配置服务器 ---------- */
  {
    await c.eval(`
      (async () => {
        await window.timecard.sync.setSettings({
          enabled: true, serverUrl: 'http://127.0.0.1:${SRV_PORT}', token: '${TOKEN}'
        })
        return 'ok'
      })()
    `)
    const st = await syncState()
    check('配置生效', st.enabled === true && st.url.includes(String(SRV_PORT)), st.url)
  }

  /* ---------- 3. 首次同步：本地 seed 卡推上去 ---------- */
  {
    // 等自动同步（防抖 1.2s + 网络）
    await sleep(5000)
    // 没推完就手动来一次
    await c.eval(`window.timecard.sync.now()`)
    await sleep(1500)

    const st = await syncState()
    check('首次同步后待推送清零', st.pending === 0, `pending=${st.pending}`)

    const srvData = await srvPull(0)
    check('服务端收到本地卡片', srvData.changes.length >= 3, `server cards=${srvData.changes.length}`)

    const local = readData()
    check('本地也有卡片', local.cards.length >= 3, `local=${local.cards.length}`)
  }

  /* ---------- 4. 本地新建一张 → 自动推到服务器 ---------- */
  {
    const before = readData().cards.length
    await c.eval(`
      (async () => {
        const s = await window.timecard.store.snapshot()
        await window.timecard.store.addCard({ title: '同步测试卡', anchorAt: Date.now() })
        return 'ok'
      })()
    `)
    await sleep(600)
    const stMid = await syncState()
    check('本地改动进了 Outbox', stMid.pending > 0, `pending=${stMid.pending}`)

    await sleep(2500)
    const st = await syncState()
    check('自动推送后队列清空', st.pending === 0, `pending=${st.pending}`)

    const srvData = await srvPull(0)
    const found = srvData.changes.find((x) => x.card.title === '同步测试卡')
    check('服务端有了新建的卡', !!found, found ? `seq=${found.seq}` : '没找到')
    check('本地卡片数增加', readData().cards.length === before + 1, `${before} → ${readData().cards.length}`)
  }

  /* ---------- 5. 服务端新建 → 客户端拉下来 ---------- */
  {
    const now = Date.now()
    const remoteCard = {
      id: 'remote-1',
      title: '服务器那边建的卡',
      items: [],
      tag: '来自远端',
      color: '#71805a',
      anchorAt: now,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      rev: 1,
      status: 'open'
    }
    await srvPush({
      deviceId: 'other-device',
      changes: [{ card: remoteCard, deviceId: 'other-device', op: 'create', clientAt: now }]
    })

    await c.eval(`window.timecard.sync.now()`)
    await sleep(1500)

    const local = readData()
    const got = local.cards.find((x) => x.id === 'remote-1')
    check('客户端拉到了服务器新建的卡', !!got, got ? got.title : '没拉到')
    check('拉下来的卡片内容正确', got?.title === '服务器那边建的卡')

    const st = await syncState()
    check('游标前进了', st.cursor > 0, `cursor=${st.cursor}`)
  }

  /* ---------- 6. 冲突：服务端版本更新 → 本地被覆盖 ---------- */
  {
    const localCard = readData().cards.find((x) => x.title === '同步测试卡')
    const newer = Date.now() + 60000
    await srvPush({
      deviceId: 'other-device',
      changes: [
        {
          card: { ...localCard, title: '被服务器改名了', updatedAt: newer, rev: localCard.rev + 1 },
          deviceId: 'other-device',
          op: 'update',
          clientAt: newer
        }
      ]
    })

    const r = await c.eval(`window.timecard.sync.now()`)
    await sleep(1200)

    const local = readData()
    const after = local.cards.find((x) => x.id === localCard.id)
    check('本地被服务器版本覆盖', after?.title === '被服务器改名了', after?.title)
  }

  /* ---------- 7. 本地更新（更新）打赢回复 ---------- */
  {
    const localCard = readData().cards.find((x) => x.id === 'remote-1')
    const newer = Date.now() + 120000
    await c.eval(`
      (async () => {
        const s = await window.timecard.store.snapshot()
        const card = s.cards.find(c => c.id === 'remote-1')
        // 用 moveCard 造一次更新的本地变更
        await window.timecard.store.moveCard('remote-1', ${newer})
        return 'ok'
      })()
    `)
    await sleep(2800)
    const srvData = await srvPull(0)
    const remote = srvData.changes.find((x) => x.card.id === 'remote-1')
    check(
      '本地更新成功推上服务器',
      remote?.card.anchorAt === newer,
      `${remote?.card.anchorAt} vs ${newer}`
    )
  }

  /* ---------- 8. 离线：服务器关掉也不崩 ---------- */
  {
    srv.kill()
    await sleep(600)

    await c.eval(`
      (async () => {
        const s = await window.timecard.store.snapshot()
        await window.timecard.store.addCard({ title: '离线时挂的卡', anchorAt: Date.now() })
        return 'ok'
      })()
    `)
    await sleep(2600)

    const st = await syncState()
    check('离线时标记 offline', st.phase === 'offline', `phase=${st.phase}`)
    check('离线改动留在 Outbox', st.pending > 0, `pending=${st.pending}`)

    const local = readData()
    check('离线也能正常挂卡', local.cards.some((x) => x.title === '离线时挂的卡'))

    // 重启服务器，应该自动补推
    await startServer(serverDb)
    // 退避首轮 3s，给到 12s 容错
    await sleep(12000)
    const st2 = await syncState()
    check('恢复联网后自动补推', st2.pending === 0, `pending=${st2.pending} phase=${st2.phase}`)

    const srvData = await srvPull(0)
    const found = srvData.changes.find((x) => x.card.title === '离线时挂的卡')
    check('补推的卡到了服务器', !!found, found ? `seq=${found.seq}` : '没找到')
  }

  /* ---------- 9. 软删除也同步 ---------- */
  {
    const target = readData().cards.find((x) => x.title === '离线时挂的卡')
    await c.eval(`
      (async () => {
        await window.timecard.store.removeCard('${target.id}')
        return 'ok'
      })()
    `)
    await sleep(2600)
    const srvData = await srvPull(0)
    const gone = srvData.changes.find((x) => x.card.id === target.id)
    check('软删除同步成墓碑', gone?.card.deletedAt !== null, String(gone?.card.deletedAt))
  }

  c.close()
  app.kill()
  await sleep(500)
  srv.kill()
  await sleep(1000)
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  } catch {
    /* Windows 上 sqlite 句柄可能还没释放，临时目录留着无所谓 */
  }

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
