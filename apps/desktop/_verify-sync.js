// 验证主窗口与浮窗是否共享同一份数据：
// 通过 CDP 连到两个窗口，在浮窗里点一下 → 检查主窗口 + JSON 文件是否同步变化
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')
const os = require('os')

const CHROME_PORT = 9511
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA = path.join(process.env.APPDATA || '', 'Timecard', 'timecard.json')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function listTargets() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${CHROME_PORT}/json/list`)
      if (r.ok) {
        const all = await r.json()
        const pages = all.filter((t) => t.type === 'page')
        if (pages.length >= 1) return pages
      }
    } catch (e) {}
    await sleep(250)
  }
  throw new Error('等不到两个窗口的调试目标')
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const pending = new Map()
    let id = 0
    ws.onopen = () =>
      resolve({
        eval: (expr) =>
          new Promise((res, rej) => {
            const i = ++id
            pending.set(i, { res, rej })
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
      const p = pending.get(m.id)
      if (!p) return
      pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  })
}

;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  env.TIMECARD_BOOT = 'week/organic'

  const child = spawn(
    ELECTRON,
    [BASE, `--remote-debugging-port=${CHROME_PORT}`],
    { env, stdio: 'ignore' }
  )

  try {
    // 浮窗是懒创建的：先连主窗口，唤起浮窗，再去找它
    const firstPages = await listTargets()
    const mainPage = firstPages.find((p) => p.url.includes('index.html'))
    if (!mainPage) throw new Error('没找到主窗口: ' + firstPages.map((p) => p.url).join(' | '))
    const main = await connect(mainPage.webSocketDebuggerUrl)
    await sleep(1200)
    await main.eval(`window.timecard.quick.show(); 'ok'`)
    await sleep(2000)

    const pages = await listTargets()
    const quickPage = pages.find((p) => p.url.includes('quick.html'))
    if (!quickPage) throw new Error('浮窗没出现: ' + pages.map((p) => p.url).join(' | '))
    const quick = await connect(quickPage.webSocketDebuggerUrl)
    await sleep(1500)

    // 记录点击前状态
    const before = await main.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.card')];
        return rows.map(r => (r.querySelector('h3')||{}).textContent).join('|');
      })()
    `)
    const beforeJson = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
    const targetCard = beforeJson.cards.find((c) => c.title === '买菜清单')
    const beforeDone = targetCard.items.filter((i) => i.done).length

    // 在浮窗里点「买菜清单」那一行 → 整卡打勾
    const clicked = await quick.eval(`
      (() => {
        const rows = [...document.querySelectorAll('.qrow')];
        const row = rows.find(r => (r.querySelector('.qt')||{}).textContent === '买菜清单');
        if (!row) return 'row-not-found';
        row.click();
        return 'clicked';
      })()
    `)
    console.log('浮窗点击:', clicked)

    await sleep(700)

    // 检查 JSON
    const afterJson = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
    const afterCard = afterJson.cards.find((c) => c.title === '买菜清单')
    const afterDone = afterCard.items.filter((i) => i.done).length

    // 检查浮窗自己的渲染
    const quickState = await quick.eval(`
      (() => {
        const row = [...document.querySelectorAll('.qrow')]
          .find(r => (r.querySelector('.qt')||{}).textContent === '买菜清单');
        return row ? row.className : 'missing';
      })()
    `)

    // 检查主窗口是否被广播刷新（切到今日视图看同一张卡）
    await main.eval(`document.querySelectorAll('.tb-seg button')[1].click(); 'ok'`)
    await sleep(600)
    const mainState = await main.eval(`
      (() => {
        const cards = [...document.querySelectorAll('.card')];
        const card = cards.find(c => (c.querySelector('h3')||{}).textContent === '买菜清单');
        if (!card) return 'card-missing';
        const checked = card.querySelectorAll('input[type=checkbox]:checked').length;
        const total = card.querySelectorAll('input[type=checkbox]').length;
        return checked + '/' + total;
      })()
    `)

    console.log('---')
    console.log('JSON  before done =', beforeDone, ' after done =', afterDone)
    console.log('浮窗  class =', quickState)
    console.log('主窗口 勾选 =', mainState)
    console.log('---')
    const ok = afterDone > beforeDone && quickState.includes('qdone') && mainState === '4/4'
    console.log(ok ? '✓ 两个窗口共享同一份数据，广播生效' : '✗ 同步失败')

    quick.close()
    main.close()
    child.kill()
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('FAIL', e)
    child.kill()
    process.exit(1)
  }
})()
