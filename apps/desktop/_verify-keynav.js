// 验证：桌面今日视图的键盘切天（← / → / Home）
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.env.TC_CDP_PORT ?? 9865)
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-keynav-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

async function findPage(want) {
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
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
      if (m.id && pend.has(m.id)) {
        const { res, rej } = pend.get(m.id)
        pend.delete(m.id)
        if (m.error) rej(new Error(m.error.message))
        else res(m.result)
      }
    }
  })
}

;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  delete env.TIMECARD_WIDE
  env.TIMECARD_BOOT = 'today/organic'
  env.TIMECARD_DATA_DIR = DATA_DIR
  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(1000)

    const dayNum = () => c.eval(`document.querySelector('.m-date .big')?.textContent ?? ''`)
    const rightIsBack = () => c.eval(`!!document.querySelector('.m-date .m-back')`)
    const press = (key) =>
      c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })), 'ok'`)

    const d0 = await dayNum()
    check('初始在「今天」，右侧显示计数而非回今天', !(await rightIsBack()), `day=${d0}`)

    await press('ArrowRight')
    await sleep(250)
    const d1 = await dayNum()
    check('→ 前进一天', d1 !== d0, `${d0} -> ${d1}`)
    check('离开今天后右侧出现「回今天」', await rightIsBack())

    await press('ArrowLeft')
    await sleep(200)
    const d2 = await dayNum()
    check('← 退回一天（回到初始日）', d2 === d0, `${d1} -> ${d2}`)

    await press('ArrowLeft')
    await press('ArrowLeft')
    await sleep(250)
    const d3 = await dayNum()
    check('连按两次 ← 退回两天', d3 !== d0, `day=${d3}`)

    await press('Home')
    await sleep(250)
    check('Home 回到今天', (await dayNum()) === d0, `day=${await dayNum()}`)

    // 输入框聚焦时不该抢键：造一个 input 聚焦后按 →
    const guarded = await c.eval(`(() => {
      const i = document.createElement('input'); document.body.appendChild(i); i.focus();
      const before = document.querySelector('.m-date .big').textContent;
      i.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      const after = document.querySelector('.m-date .big').textContent;
      i.blur(); i.remove();
      return before === after;
    })()`)
    check('输入框聚焦时 → 不切天', guarded === true)

    c.close()
  } catch (e) {
    check('测试执行', false, String(e && e.message ? e.message : e))
  } finally {
    child.kill()
    await sleep(250)
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {}
  }
  const pass = results.filter((r) => r[1]).length
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
  process.exit(pass === results.length ? 0 : 1)
})()
