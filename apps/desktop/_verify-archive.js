// 验证：卡片归档 / 取消归档（时间轴移除，搜索仍可见）
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.env.TC_CDP_PORT ?? 9869)
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-archive-'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const check = (n, p, d = '') => {
  results.push([n, p, d])
  console.log(`${p ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`)
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
            pend.set(i, (r) => {
              if (r && r.exceptionDetails) rej(new Error(r.exceptionDetails.text))
              else res(r && r.result && r.result.value)
            })
            ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }))
          }),
        close: () => ws.close()
      })
    ws.onerror = reject
    ws.onmessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id && pend.has(m.id)) {
        pend.get(m.id)(m.result)
        pend.delete(m.id)
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

    const openSearch = async (q) => {
      await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true})),'ok'`)
      await sleep(250)
      await c.eval(`(() => { const el=document.querySelector('.tsearch input'); const s=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set; s.call(el, ${JSON.stringify(q)}); el.dispatchEvent(new Event('input',{bubbles:true})); return true })()`)
      await sleep(300)
    }
    const clickEditorBtn = (text) =>
      c.eval(`(() => { const b=[...document.querySelectorAll('.editor-foot .editor-btn')].find(x=>x.textContent.trim()===${JSON.stringify(text)}); if(!b) return false; b.click(); return true })()`)
    const metaText = () => c.eval(`document.querySelector('.tsearch-row-meta')?.textContent || ''`)

    await openSearch('电费')
    check('搜索「电费」有结果', (await c.eval(`document.querySelectorAll('.tsearch-row').length`)) >= 1)
    await c.eval(`document.querySelector('.tsearch-row').click()`)
    await sleep(400)
    check('点结果打开编辑器', await c.eval(`!!document.querySelector('.editor')`))
    check('编辑器有「归档」按钮', await clickEditorBtn('归档'))
    await sleep(400)
    check('归档后编辑器关闭', await c.eval(`!document.querySelector('.editor')`))

    await openSearch('电费')
    const meta1 = await metaText()
    check('归档后搜索仍能找到，且标「已归档」', meta1.includes('已归档'), meta1)
    await c.eval(`document.querySelector('.tsearch-row').click()`)
    await sleep(400)
    check('再打开编辑器 ', await c.eval(`!!document.querySelector('.editor')`))
    check('已归档卡显示「取消归档」按钮', await clickEditorBtn('取消归档'))
    await sleep(400)

    await openSearch('电费')
    const meta2 = await metaText()
    check('取消归档后不再标「已归档」', !meta2.includes('已归档'), meta2)

    // 右键菜单里也应能归档（← 到昨天，交水电费在那儿）
    await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})),'ok'`)
    await sleep(200)
    await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',bubbles:true})),'ok'`)
    await sleep(400)
    const hasCard = await c.eval(`!!document.querySelector('.m-list .card')`)
    if (hasCard) {
      await c.eval(
        `(() => { const el=document.querySelector('.m-list .card'); el.dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,clientX:60,clientY:120})); return true })()`
      )
      await sleep(300)
      const labels = await c.eval(
        `[...document.querySelectorAll('.ctx-item')].map(b=>b.textContent.trim())`
      )
      check('右键菜单含归档项', Array.isArray(labels) && labels.some((l) => l.includes('归档')), (labels || []).join(' | '))
    } else {
      check('右键菜单含归档项', false, '当天无卡片可右键')
    }

    c.close()
  } catch (e) {
    check('测试执行', false, String(e && e.message ? e.message : e))
  } finally {
    child.kill()
    await sleep(250)
    try { fs.rmSync(DATA_DIR, { recursive: true, force: true }) } catch {}
  }
  const pass = results.filter((r) => r[1]).length
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
  process.exit(pass === results.length && results.length > 0 ? 0 : 1)
})()
