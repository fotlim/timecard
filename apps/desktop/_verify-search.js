// 验证：桌面端全库搜索（Ctrl+F / 标题栏放大镜 → 结果 → 开编辑器）
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.env.TC_CDP_PORT ?? 9866)
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dsearch-'))
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
            pend.set(i, (r) => {
              if (r && r.exceptionDetails) rej(new Error(r.exceptionDetails.text))
              else res(r && r.result && r.result.value)
            })
            ws.send(
              JSON.stringify({
                id: i,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true, awaitPromise: true }
              })
            )
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

    check('标题栏有搜索按钮', await c.eval(`!!document.querySelector('.tb-icon[aria-label="搜索卡片"]')`))

    await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })), 'ok'`)
    await sleep(300)
    check('Ctrl+F 打开搜索浮层', await c.eval(`!!document.querySelector('.tsearch')`))
    check('初始提示「输入关键词」', await c.eval(`(document.querySelector('.tsearch-hint')?.textContent||'').includes('输入关键词')`))

    const typeQuery = (q) => c.eval(`(() => {
      const el = document.querySelector('.tsearch input');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
      setter.call(el, ${JSON.stringify(q)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true
    })()`)

    await typeQuery('电费')
    await sleep(300)
    const n = await c.eval(`document.querySelectorAll('.tsearch-row').length`)
    check('搜「电费」有结果', n >= 1, `rows=${n}`)
    check('命中含「交水电费」', await c.eval(`[...document.querySelectorAll('.tsearch-row-title')].some(e => e.textContent.includes('交水电费'))`))

    // 条目内容也要能搜到（"抄电表读数" 只在条目的 text 里）
    await typeQuery('抄电表')
    await sleep(300)
    const nItem = await c.eval(`document.querySelectorAll('.tsearch-row').length`)
    check('条目内容也能搜到', nItem >= 1, `rows=${nItem}`)
    check(
      '结果里标出命中的条目',
      await c.eval(`(document.querySelector('.tsearch-row-hit')?.textContent || '').includes('抄电表')`)
    )

    await typeQuery('电费')
    await sleep(300)

    await c.eval(`document.querySelector('.tsearch-row').click()`)
    await sleep(500)
    check('点结果打开编辑器', await c.eval(`!!document.querySelector('.editor')`))
    check('搜索浮层已关闭', await c.eval(`!document.querySelector('.tsearch')`))

    // 关掉编辑器后，重开搜索并用 Esc 关闭
    await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 'ok'`)
    await sleep(300)
    await c.eval(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true })), 'ok'`)
    await sleep(300)
    const opened = await c.eval(`!!document.querySelector('.tsearch')`)
    await c.eval(`document.querySelector('.tsearch input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })), 'ok'`)
    await sleep(300)
    check('重开搜索成功', opened)
    check('Esc 关闭搜索浮层', await c.eval(`!document.querySelector('.tsearch')`))

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
