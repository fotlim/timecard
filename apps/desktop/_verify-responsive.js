// 验证宽度自适应：窄 → 今日(竖屏) / 宽 → 周视图
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = 9521
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function target() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const p = (await r.json()).find((t) => t.type === 'page' && t.url.includes('index.html'))
        if (p) return p
      }
    } catch (e) {}
    await sleep(250)
  }
  throw new Error('等不到主窗口')
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
          }).then((r) => r.result && r.result.value),
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
  delete env.TIMECARD_BOOT

  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await target()
    const main = await connect(t.webSocketDebuggerUrl)
    await sleep(1800)

    const narrow = await main.eval(`
      ({
        w: window.innerWidth,
        screen: !!document.querySelector('.screen'),
        appframe: !!document.querySelector('.appframe'),
        mode: document.querySelector('.shell').className
      })
    `)
    console.log('窄窗口:', JSON.stringify(narrow))

    // 拉宽到 1000 → 应自动切周视图
    await main.eval(`window.resizeTo(1000, 760); 'ok'`)
    await sleep(1000)

    const wide = await main.eval(`
      ({
        w: window.innerWidth,
        screen: !!document.querySelector('.screen'),
        appframe: !!document.querySelector('.appframe')
      })
    `)
    console.log('拉宽后:', JSON.stringify(wide))

    const ok = narrow.screen && !narrow.appframe && narrow.w < 720 && wide.appframe && !wide.screen
    console.log(ok ? '✓ 窄=今日(竖屏)，宽=周视图，自动切换生效' : '✗ 自适应失败')

    main.close()
    child.kill()
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('FAIL', e)
    child.kill()
    process.exit(1)
  }
})()
