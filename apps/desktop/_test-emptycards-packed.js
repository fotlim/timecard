// 专项测试：0 条目卡片的打勾/取消（Composer 建出来的卡就是 0 条目）
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = 9621
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(BASE, 'release', 'win-unpacked', '挂卡时间轴.exe')
const DATA = path.join(process.env.APPDATA || '', 'Timecard', 'timecard.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage(want) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const all = (await r.json()).filter((t) => t.type === 'page')
        const hit = all.find((t) => t.url.includes(want))
        if (hit) return hit
      }
    } catch (e) {}
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

;(async () => {
  // 一张「有 2 个条目」的卡 + 一张「0 条目」的卡
  const now = Date.now()
  fs.mkdirSync(path.dirname(DATA), { recursive: true })
  fs.writeFileSync(
    DATA,
    JSON.stringify(
      {
        skin: 'organic',
        prefs: { closeToTray: true },
        cards: [
          {
            id: 'with-items',
            title: '有条目的卡',
            items: [
              { id: 'a', text: '条目 A', done: false },
              { id: 'b', text: '条目 B', done: false }
            ],
            tag: '测试',
            color: '#71805a',
            anchorAt: now,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            rev: 1,
            status: 'open'
          },
          {
            id: 'no-items',
            title: '没条目的卡',
            items: [],
            tag: '测试',
            color: '#71805a',
            anchorAt: now,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            rev: 1,
            status: 'open'
          }
        ]
      },
      null,
      2
    ),
    'utf-8'
  )

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_BOOT
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })

  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(5000)

    const st = async (id) =>
      c.eval(`
        (async () => {
          const s = await window.timecard.store.snapshot();
          const card = s.cards.find(x => x.id === '${id}');
          return { status: card.status, items: card.items.map(i => i.done) };
        })()
      `)

    const results = []

    // 有条目的卡：点一下 → 全勾，再点一下 → 全不勾
    const a0 = await st('with-items')
    await c.eval(`window.timecard.store.toggleCardDone('with-items')`)
    await sleep(400)
    const a1 = await st('with-items')
    await c.eval(`window.timecard.store.toggleCardDone('with-items')`)
    await sleep(400)
    const a2 = await st('with-items')
    results.push([
      '有条目的卡能来回切换',
      a2.items.every((d) => d === false) && a2.status === 'open',
      `${a0.status} → ${a1.status}[${a1.items}] → ${a2.status}[${a2.items}]`
    ])

    // 0 条目的卡：点一下 → done，再点一下 → 应该回到 open
    const b0 = await st('no-items')
    await c.eval(`window.timecard.store.toggleCardDone('no-items')`)
    await sleep(400)
    const b1 = await st('no-items')
    await c.eval(`window.timecard.store.toggleCardDone('no-items')`)
    await sleep(400)
    const b2 = await st('no-items')

    results.push([
      '空卡片能标记完成',
      b1.status === 'done',
      `${b0.status} → ${b1.status}`
    ])
    results.push([
      '空卡片能取消完成',
      b2.status === 'open',
      `${b1.status} → ${b2.status}（期望 open）`
    ])

    console.log('')
    let ok = true
    for (const [name, pass, detail] of results) {
      if (!pass) ok = false
      console.log(`${pass ? '✓' : '✗'} ${name.padEnd(20)} ${detail}`)
    }
    c.close()
    console.log('')
    console.log(ok ? '全部通过' : '有失败项')
    child.kill()
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('FAIL', e && e.message)
    child.kill()
    process.exit(1)
  }
})()
