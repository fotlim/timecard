// 截图：右键菜单在三套皮肤下的样子
// 用法： node _shot-menu.js
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = 9591
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
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
        send: (method, params) =>
          new Promise((res, rej) => {
            const i = ++id
            pend.set(i, { res, rej })
            ws.send(JSON.stringify({ id: i, method, params }))
          }),
        eval: (expr) =>
          new Promise((res, rej) => {
            const i = ++id
            pend.set(i, { res, rej, raw: true })
            ws.send(
              JSON.stringify({
                id: i,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true, awaitPromise: true }
              })
            )
          }).then((r) => r && r.result && r.result.value),
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

async function shoot(skin) {
  const out = path.join(BASE, `_menu_${skin}.png`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  env.TIMECARD_BOOT = `today/${skin}`
  env.TIMECARD_WIDE = '1' // 宽一点，菜单不至于把卡片全遮住

  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(2200)

    // 在第一张卡上派发右键
    await c.eval(`
      (() => {
        const card = document.querySelector('.card');
        const r = card.getBoundingClientRect();
        const ev = new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(r.left + 60), clientY: Math.round(r.top + 26)
        });
        card.dispatchEvent(ev);
        return 'ok';
      })()
    `)
    await sleep(500)

    const clip = await c.eval(`
      (() => {
        const m = document.querySelector('.ctxmenu');
        if (!m) return null;
        const r = m.getBoundingClientRect();
        return { x: r.x, y: r.y, w: r.width, h: r.height };
      })()
    `)

    const shot = await c.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(out, Buffer.from(shot.data, 'base64'))
    c.close()
    console.log(`${skin}: 菜单 ${clip ? `${Math.round(clip.w)}x${Math.round(clip.h)}` : '未出现'}`)
  } finally {
    child.kill()
    await sleep(700)
  }
}

;(async () => {
  try { fs.unlinkSync(path.join(process.env.APPDATA, 'Timecard', 'timecard.json')) } catch (e) {}
  for (const s of ['organic', 'brutal', 'neo']) {
    await shoot(s)
  }
  console.log('done')
  process.exit(0)
})()
