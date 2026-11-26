// 桌面端 ⇄ 远程 Linux 主机 真实同步测试
// 通过 SSH 隧道（127.0.0.1:8787）连到 REMOTE 上跑的服务端，桌面端不启动本地服务器。
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const PORT_DBG = 9871
const REMOTE = process.env.REMOTE_URL || 'http://127.0.0.1:8787'
const TOKEN = process.env.REMOTE_TOKEN || ''
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA_DIR = path.join(os.homedir(), 'AppData', 'Roaming', 'Timecard')
const DATA = path.join(DATA_DIR, 'timecard.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function remoteHealth() {
  const r = await fetch(`${REMOTE}/api/health`)
  return r.json()
}
async function remotePull(since = 0) {
  const r = await fetch(`${REMOTE}/api/sync/pull?since=${since}`, { headers: auth })
  return r.json()
}
async function remotePush(body) {
  const r = await fetch(`${REMOTE}/api/sync/push`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body)
  })
  return r.json()
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

/**
 * 等同步把队列清空。
 * 别用固定 sleep —— 公网走 Cloudflare 隧道时单次往返就要 1.4s，
 * 一轮 push+pull 3-5s 很正常，写死 3.2s 会假报失败。
 */
async function waitDrained(c, timeoutMs = 20000) {
  const started = Date.now()
  let last = null
  while (Date.now() - started < timeoutMs) {
    last = await c.eval(`(async () => {
      const b = await window.timecard.sync.get()
      return { pending: b.state.pending, phase: b.state.phase }
    })()`)
    if (last.pending === 0 && last.phase === 'idle') return last
    await sleep(500)
  }
  return last
}

async function main() {
  const t0 = Date.now()
  console.log(`远程服务器: ${REMOTE}`)
  const health = await remoteHealth()
  console.log(`远端状态: cardCount=${health.cardCount} v${health.version}`)
  console.log('')

  fs.mkdirSync(DATA_DIR, { recursive: true })
  try {
    fs.unlinkSync(DATA)
  } catch {}

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  delete env.TIMECARD_WIDE
  env.TIMECARD_BOOT = 'today/organic'
  const app = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT_DBG}`], {
    env,
    stdio: 'ignore'
  })

  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(3200)

    const syncState = () =>
      c.eval(`(async () => {
        const b = await window.timecard.sync.get()
        return { phase: b.state.phase, pending: b.state.pending, cursor: b.state.cursor,
                 enabled: b.settings.enabled, last: b.state.lastSyncAt, error: b.state.error }
      })()`)

    /* ---------- 1. 测试连接打到真实远程 ---------- */
    {
      const r = await c.eval(`window.timecard.sync.test('${REMOTE}', '${TOKEN}')`)
      check('测试连接 · 真实远程', r.ok === true, `${r.ms}ms v${r.version} cards=${r.cardCount}`)
    }

    /* ---------- 2. 配置并首次同步 ---------- */
    {
      await c.eval(`
        (async () => {
          await window.timecard.sync.setSettings({
            enabled: true, serverUrl: '${REMOTE}', token: '${TOKEN}'
          })
          return 'ok'
        })()
      `)
      await sleep(4000)
      await c.eval(`window.timecard.sync.now()`)
      await sleep(1500)

      const st = await syncState()
      check('首次同步完成', st.pending === 0 && st.phase === 'idle', `pending=${st.pending} ${st.phase}`)

      const remote = await remoteHealth()
      check(
        '本地 6 张卡真的传到了 Linux 主机',
        remote.cardCount >= 6,
        `远端 cardCount=${remote.cardCount}`
      )
    }

    /* ---------- 3. 桌面端新建 → 推到远端 ---------- */
    {
      const before = readData().cards.length
      await c.eval(`
        (async () => {
          await window.timecard.store.addCard({ title: '从 Windows 桌面推过去的卡', anchorAt: Date.now() })
          return 'ok'
        })()
      `)
      const drained = await waitDrained(c)
      check('自动推送后队列清空', drained.pending === 0, `pending=${drained.pending}`)

      const pulled = await remotePull(0)
      const found = pulled.changes.find((x) => x.card.title === '从 Windows 桌面推过去的卡')
      check('远端收到桌面端新建的卡', !!found, found ? `seq=${found.seq}` : '没找到')
      check('本地卡片数 +1', readData().cards.length === before + 1)
    }

    /* ---------- 4. 远端建卡 → 桌面端拉下来 ---------- */
    {
      const now = Date.now()
      const remoteCard = {
        id: 'from-linux-host',
        title: 'Linux 主机上建的卡',
        items: [],
        tag: 'REMOTE',
        color: '#71805a',
        anchorAt: now,
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
        rev: 1,
        status: 'open'
      }
      await remotePush({
        deviceId: 'remote-host',
        changes: [{ card: remoteCard, deviceId: 'remote-host', op: 'create', clientAt: now }]
      })

      await c.eval(`window.timecard.sync.now()`)
      await sleep(1500)

      const local = readData()
      const got = local.cards.find((x) => x.id === 'from-linux-host')
      check('桌面端拉到 Linux 主机建的卡', !!got, got ? got.title : '没拉到')
      check('拉下来的内容一致', got?.title === 'Linux 主机上建的卡' && got?.tag === 'REMOTE')
    }

    /* ---------- 5. 冲突：远端更晚 → 桌面端被覆盖 ---------- */
    {
      const localCard = readData().cards.find((x) => x.title === '从 Windows 桌面推过去的卡')
      const newer = Date.now() + 90000
      await remotePush({
        deviceId: 'remote-host',
        changes: [
          {
            card: { ...localCard, title: 'Linux 主机改名了', updatedAt: newer, rev: localCard.rev + 1 },
            deviceId: 'remote-host',
            op: 'update',
            clientAt: newer
          }
        ]
      })
      await c.eval(`window.timecard.sync.now()`)
      await sleep(1500)

      const after = readData().cards.find((x) => x.id === localCard.id)
      check('远端更晚时桌面端被覆盖', after?.title === 'Linux 主机改名了', after?.title)
    }

    /* ---------- 6. 桌面端更晚 → 赢回来 ---------- */
    {
      const target = readData().cards.find((x) => x.id === 'from-linux-host')
      const newer = Date.now() + 200000
      await c.eval(`(async () => { await window.timecard.store.moveCard('from-linux-host', ${newer}); return 'ok' })()`)
      await waitDrained(c)
      const pulled = await remotePull(0)
      const remote = pulled.changes.find((x) => x.card.id === 'from-linux-host')
      check(
        '桌面端更晚时改动推到了远端',
        remote?.card.anchorAt === newer,
        `${remote?.card.anchorAt} vs ${newer}`
      )
      check('远端 lastDeviceId 是这台 Windows', remote?.lastDeviceId === readData().syncMeta.deviceId, remote?.lastDeviceId)
    }

    /* ---------- 7. 改错地址 → offline，且本机照常能干�� ---------- */
    {
      await c.eval(`
        (async () => {
          await window.timecard.sync.setSettings({ serverUrl: 'http://127.0.0.1:39999' })
          return 'ok'
        })()
      `)
      await sleep(1200)
      await c.eval(`window.timecard.sync.now()`)
      await sleep(1200)
      const st = await syncState()
      check('连不上时标记 offline', st.phase === 'offline', st.phase)
      check('错误是人话', /连不上|端口/.test(st.error ?? ''), st.error)

      await c.eval(`(async () => { await window.timecard.store.addCard({ title: '断网时记的', anchorAt: Date.now() }); return 'ok' })()`)
      await sleep(2500)
      const st2 = await syncState()
      check('离线时改动留在队列', st2.pending > 0, `pending=${st2.pending}`)
      check('离线照常能挂卡', readData().cards.some((x) => x.title === '断网时记的'))

      // 改回远程地址，应该自动补推
      await c.eval(`
        (async () => {
          await window.timecard.sync.setSettings({ serverUrl: '${REMOTE}' })
          return 'ok'
        })()
      `)
      const st3 = await waitDrained(c, 30000)
      check('改回地址后自动补推', st3.pending === 0 && st3.phase === 'idle', `${st3.phase} pending=${st3.pending}`)

      const pulled = await remotePull(0)
      const found = pulled.changes.find((x) => x.card.title === '断网时记的')
      check('补推的卡到了 Linux 主机', !!found, found ? `seq=${found.seq}` : '没找到')
    }

    c.close()
  } finally {
    app.kill()
  }

  const pass = results.filter((r) => r[1]).length
  console.log('')
  console.log(`共 ${results.length} 项，通过 ${pass} 项，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  process.exit(pass === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('FAIL', e && e.message)
  process.exit(1)
})
