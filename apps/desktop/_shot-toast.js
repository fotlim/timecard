const { spawn } = require('child_process')
const fs = require('fs'), path = require('path')
const PORT = 9651
const BASE = __dirname
const ELECTRON = path.join(BASE, '..', '..', 'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe')
const DATA = path.join(process.env.APPDATA, 'Timecard', 'timecard.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function seed(skin) {
  const t = new Date(); t.setHours(0,0,0,0)
  const cards = [
    { id:'c1', title:'交水电费', items:[{id:'a',text:'抄电表读数',done:false},{id:'b',text:'App 里缴费',done:false}], tag:'交费 / BILLS', color:'#b3613a', anchorAt:t.getTime()+9*3600000, createdAt:Date.now(), updatedAt:Date.now(), deletedAt:null, rev:1, status:'open' },
    { id:'c2', title:'买菜清单', items:[{id:'c',text:'鸡蛋 ×10',done:false}], tag:'家庭 / HOME', color:'#71805a', anchorAt:t.getTime()+10*3600000, createdAt:Date.now(), updatedAt:Date.now(), deletedAt:null, rev:1, status:'open' }
  ]
  fs.mkdirSync(path.dirname(DATA), { recursive: true })
  fs.writeFileSync(DATA, JSON.stringify({ skin, prefs:{closeToTray:true}, cards }, null, 2))
}
async function findPage(want) {
  for (let i = 0; i < 200; i++) {
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
  throw new Error('no page')
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url); const pend = new Map(); let id = 0
    ws.onopen = () => resolve({
      send: (m, p) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })) }),
      eval: e => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } })) }).then(r => r && r.result && r.result.value),
      close: () => ws.close()
    })
    ws.onerror = reject
    ws.onmessage = e => { const m = JSON.parse(e.data); const p = pend.get(m.id); if (!p) return; pend.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result) }
  })
}
async function shoot(skin) {
  seed(skin)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT; delete env.TIMECARD_SHOT_QUICK; delete env.TIMECARD_SHOT_SETTINGS
  delete env.TIMECARD_BOOT
  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(2600)
    await c.eval(`window.timecard.store.setSkin('${skin}'); 'ok'`)
    await sleep(500)
    // 右键第一张卡 → 点删除
    await c.eval(`
      (() => {
        const card = document.querySelector('.m-list .card:not(.new)');
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', { bubbles:true, cancelable:true, button:2,
          clientX: Math.round(r.left+40), clientY: Math.round(r.top+20) }));
        return 'ok';
      })()
    `)
    await sleep(400)
    await c.eval(`
      (() => {
        const b = [...document.querySelectorAll('.ctx-item')].find(x => x.textContent.includes('删除'));
        if (b) b.click();
        return 'ok';
      })()
    `)
    await sleep(600)
    const has = await c.eval(`!!document.querySelector('.toast')`)
    const shot = await c.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(BASE, `_toast_${skin}.png`), Buffer.from(shot.data, 'base64'))
    c.close()
    return has
  } finally { child.kill(); await sleep(800) }
}
;(async () => {
  for (const skin of ['organic','brutal','neo']) {
    const has = await shoot(skin)
    console.log(skin, 'toast =', has)
  }
  process.exit(0)
})()
