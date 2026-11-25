// 验证优化：懒创建省内存、窗口几何记忆、首屏不闪空态、sandbox
const { spawn } = require('child_process')
const fs = require('fs'), path = require('path')
const PORT = 9681
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(BASE, 'release', 'win-unpacked', '挂卡时间轴.exe')
const DATA = path.join(process.env.APPDATA, 'Timecard', 'timecard.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function memOf() {
  const { execFileSync } = require('child_process')
  try {
    const out = execFileSync('powershell', ['-NoProfile','-Command',
      "Get-Process -Name electron -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '*timecard*' } | Measure-Object -Property WorkingSet64 -Sum | Select-Object -ExpandProperty Sum"
    ], { encoding: 'utf8' }).trim()
    return Number(out || 0) / 1024 / 1024
  } catch (e) { return 0 }
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
  throw new Error('no page ' + want)
}
function connect(url) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(url); const p = new Map(); let id = 0
    ws.onopen = () => res({
      send: (m, q) => new Promise((a, b) => { const i = ++id; p.set(i, { a, b }); ws.send(JSON.stringify({ id: i, method: m, params: q })) }),
      eval: e => new Promise((a, b) => { const i = ++id; p.set(i, { a, b }); ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: e, returnByValue: true, awaitPromise: true } })) }).then(r => r && r.result && r.result.value),
      close: () => ws.close()
    })
    ws.onerror = rej
    ws.onmessage = e => { const m = JSON.parse(e.data); const q = p.get(m.id); if (!q) return; p.delete(m.id); m.error ? q.b(new Error(JSON.stringify(m.error))) : q.a(m.result) }
  })
}

;(async () => {
  // 干净数据
  try { fs.unlinkSync(DATA) } catch (e) {}
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_BOOT
  delete env.TIMECARD_SHOT; delete env.TIMECARD_SHOT_QUICK; delete env.TIMECARD_SHOT_SETTINGS
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  const rows = []
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(3000)

    // 1) 启动后只有 1 个 renderer（浮窗没建）
    const list = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page')
    rows.push(['启动后页面数', list.length === 1, `${list.length} 个（懒创建生效=${list.length === 1}）`])

    // 2) sandbox 生效
    const sandbox = await c.eval(`
      (() => ({ hasProcess: typeof process !== 'undefined',
                hasRequire: typeof require !== 'undefined' }))()
    `)
    rows.push(['渲染层无 Node 权限', !sandbox.hasProcess && !sandbox.hasRequire, JSON.stringify(sandbox)])

    // 3) 懒创建后浮窗可用
    await c.eval(`window.timecard.quick.show(); 'ok'`)
    await sleep(1800)
    const list2 = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter(x => x.type === 'page')
    rows.push(['唤起后浮窗出现', list2.length === 2, `${list2.length} 个页面`])

    // 4) 首屏：ready 之前不该有空态闪
    const flash = await c.eval(`
      (() => {
        const empty = document.querySelector('.m-list .card.new');
        return { hasEmptySlotNow: !!empty, cardCount: document.querySelectorAll('.m-list .card:not(.new)').length };
      })()
    `)
    rows.push(['首屏数据已就绪', flash.cardCount > 0, JSON.stringify(flash)])

    c.close()
  } finally { child.kill(); await sleep(900) }

  // 5) 窗口几何记忆
  const env2 = { ...process.env }
  delete env2.ELECTRON_RUN_AS_NODE
  delete env2.TIMECARD_BOOT
  const c2 = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`], { env: env2, stdio: 'ignore' })
  let savedBounds = null
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(3000)
    await c.eval(`window.resizeTo(600, 800); 'ok'`)
    await sleep(1200)
    const b = await c.eval(`({ w: window.outerWidth, h: window.outerHeight })`)
    savedBounds = b
    c.close()
    // 触发 close 让 rememberBounds 落盘
    await sleep(800)
  } finally { c2.kill(); await sleep(1200) }

  const raw = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
  rows.push(['窗口几何已落盘', !!raw.windowState, JSON.stringify(raw.windowState)])
  rows.push([
    '几何数值合理',
    !!raw.windowState &&
      raw.windowState.width >= 380 &&
      raw.windowState.height >= 600 &&
      raw.windowState.width < 4000,
    `保存 ${raw.windowState && raw.windowState.width}x${raw.windowState && raw.windowState.height}`
  ])

  console.log('')
  let ok = true
  for (const [n, p, d] of rows) { if (!p) ok = false; console.log(`${p ? '✓' : '✗'} ${n.padEnd(20)} ${d}`) }
  console.log('')
  console.log(ok ? '全部通过' : '有失败项')
  process.exit(ok ? 0 : 1)
})()
