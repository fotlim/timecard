const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const PORT = 9601
const BASE = __dirname
const ELECTRON = path.join(__dirname, '..', '..', 'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe')
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
async function findPage(want) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const all = (await r.json()).filter(t => t.type === 'page')
        const hit = all.find(t => t.url.includes(want))
        if (hit) return hit
      }
    } catch (e) {}
    await sleep(250)
  }
  throw new Error('no page ' + want)
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pend = new Map(); let id = 0
    ws.onopen = () => resolve({
      send: (method, params) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })) }),
      eval: (expr) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } })) }).then(r => r && r.result && r.result.value),
      close: () => ws.close()
    })
    ws.onerror = reject
    ws.onmessage = (e) => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
  })
}
;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT; delete env.TIMECARD_SHOT_QUICK; delete env.TIMECARD_SHOT_SETTINGS
  env.TIMECARD_BOOT = 'quick/brutal'
  try { fs.unlinkSync(path.join(process.env.APPDATA, 'Timecard', 'timecard.json')) } catch (e) {}
  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await findPage('quick.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(2500)
    // 先把浮窗叫出来
    await c.eval(`window.timecard.quick.show(); 'ok'`)
    await sleep(900)
    await c.eval(`
      (() => {
        const row = document.querySelector('.qrow');
        if (!row) return 'no-row';
        const r = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: Math.round(r.left + 40), clientY: Math.round(r.top + 18) }));
        return 'ok';
      })()
    `)
    await sleep(500)
    const info = await c.eval(`
      (() => {
        const m = document.querySelector('.ctxmenu');
        if (!m) return null;
        return { items: [...m.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()), h: Math.round(m.getBoundingClientRect().height) };
      })()
    `)
    console.log('浮窗菜单:', info ? JSON.stringify(info) : '未出现')
    const shot = await c.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(BASE, '_menu_float.png'), Buffer.from(shot.data, 'base64'))
    c.close()
  } finally { child.kill(); await sleep(600) }
  process.exit(0)
})()
