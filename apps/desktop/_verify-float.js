// 复现 / 验证：浮窗在切皮肤后会不会消失 / 乱飞
// 用法： node _verify-float.js
const { spawn } = require('child_process')
const path = require('path')

const PORT = 9551
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
// VERIFY_BIN 可以让同一个脚本去测打包版
const PACKED = process.env.VERIFY_BIN || ''
const ELECTRON = PACKED || path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage(want) {
  for (let i = 0; i < 160; i++) {
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
            if (r && r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails))
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
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  env.TIMECARD_BOOT = 'today/organic'

  const args = PACKED ? [`--remote-debugging-port=${PORT}`] : [BASE, `--remote-debugging-port=${PORT}`]
  const child = spawn(ELECTRON, args, { env, stdio: 'ignore' })
  const rows = []
  try {
    const mainT = await findPage('index.html')
    const main = await connect(mainT.webSocketDebuggerUrl)
    await sleep(2000)

    const bounds = () => main.eval('window.timecard.quick.bounds()')
    const show = () => main.eval('window.timecard.quick.show()')
    const skin = (s) => main.eval(`window.timecard.store.setSkin('${s}')`)

    // 1. 显示浮窗
    await show()
    await sleep(900)
    const b0 = await bounds()
    rows.push(['显示后', b0])

    // 2. 依次切皮肤，每次读几何
    for (const s of ['brutal', 'neo', 'organic', 'brutal']) {
      await skin(s)
      await sleep(900)
      const b = await bounds()
      rows.push([`切到 ${s}`, b])
    }

    // 3. 收起再唤起（这是用户最常做的动作）
    await main.eval('window.timecard.quick.hide()')
    await sleep(400)
    await show()
    await sleep(900)
    rows.push(['收起再唤起', await bounds()])

    // 4. 隐藏状态下切皮肤，再唤起
    await main.eval('window.timecard.quick.hide()')
    await sleep(400)
    await skin('neo')
    await sleep(700)
    await show()
    await sleep(900)
    rows.push(['隐藏时切皮肤后唤起', await bounds()])

    console.log('')
    console.log('步骤'.padEnd(22), 'x'.padStart(6), 'y'.padStart(7), 'w'.padStart(6), 'h'.padStart(6))
    for (const [name, b] of rows) {
      if (!b) {
        console.log(name.padEnd(22), '  <null> 窗口不存在或被销毁')
        continue
      }
      console.log(
        name.padEnd(22),
        String(b.x).padStart(6),
        String(b.y).padStart(7),
        String(b.width).padStart(6),
        String(b.height).padStart(6)
      )
    }

    // 判定
    console.log('')
    const valid = rows.filter(([, b]) => b)
    const xs = valid.map(([, b]) => b.x)
    const ws = valid.map(([, b]) => b.width)
    const stableX = xs.every((v) => v === xs[0])
    const stableW = ws.every((v) => v === ws[0])
    const anyNull = valid.length !== rows.length
    console.log(`${stableX ? '✓' : '✗'} x 稳定在 ${xs[0]}（实测 ${[...new Set(xs)].join(', ')}）`)
    console.log(`${stableW ? '✓' : '✗'} 宽度稳定在 ${ws[0]}（实测 ${[...new Set(ws)].join(', ')}）`)
    console.log(`${anyNull ? '✗' : '✓'} 每一步窗口都存在`)

    main.close()
    child.kill()
    process.exit(stableX && stableW && !anyNull ? 0 : 1)
  } catch (e) {
    console.error('FAIL', e && e.message)
    child.kill()
    process.exit(1)
  }
})()
