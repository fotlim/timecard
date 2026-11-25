// 验证删除 → 撤销链路
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = 9631
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(BASE, 'release', 'win-unpacked', '挂卡时间轴.exe')
const DATA = path.join(process.env.APPDATA || '', 'Timecard', 'timecard.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage(want) {
  for (let i = 0; i < 200; i++) {
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
            if (r && r.exceptionDetails) throw new Error('JS: ' + r.exceptionDetails.text)
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
  const now = Date.now()
  fs.mkdirSync(path.dirname(DATA), { recursive: true })
  fs.writeFileSync(
    DATA,
    JSON.stringify(
      {
        skin: 'organic',
        prefs: { closeToTray: true },
        cards: [
          {
            id: 'keep',
            title: '别删我',
            items: [],
            tag: '测试',
            color: '#71805a',
            anchorAt: now,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            rev: 1,
            status: 'open'
          },
          {
            id: 'doomed',
            title: '要被删的',
            items: [],
            tag: '测试',
            color: '#71805a',
            anchorAt: now,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            rev: 1,
            status: 'open'
          }
        ]
      },
      null,
      2
    ),
    'utf-8'
  )

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_BOOT
  const child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  const results = []
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(4500)

    const titles = () =>
      c.eval(`
        (async () => {
          const s = await window.timecard.store.snapshot();
          return s.cards.filter(x => x.deletedAt === null).map(x => x.title);
        })()
      `)

    // 1. 右键「要被删的」→ 点删除
    await c.eval(`
      (() => {
        const cards = [...document.querySelectorAll('.m-list .card')];
        const card = cards.find(c => (c.querySelector('h3')||{}).textContent === '要被删的');
        const r = card.getBoundingClientRect();
        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(r.left+40), clientY: Math.round(r.top+20)
        }));
        return 'ok';
      })()
    `)
    await sleep(400)
    await c.eval(`
      (() => {
        const btn = [...document.querySelectorAll('.ctx-item')]
          .find(b => b.textContent.includes('删除'));
        if (!btn) return 'no-btn';
        btn.click();
        return 'clicked';
      })()
    `)
    await sleep(700)

    const afterDelete = await titles()
    results.push([
      '删除后卡片消失',
      afterDelete.length === 1 && afterDelete[0] === '别删我',
      JSON.stringify(afterDelete)
    ])

    // 2. 撤销条是否出现
    const toastVisible = await c.eval(`
      (() => {
        const el = document.querySelector('.toast');
        if (!el) return null;
        return { text: el.querySelector('.toast-text').textContent,
                 action: el.querySelector('.toast-action').textContent };
      })()
    `)
    results.push([
      '出现撤销条',
      toastVisible && toastVisible.action === '撤销',
      JSON.stringify(toastVisible)
    ])

    // 3. 点撤销 → 卡片回来
    await c.eval(`
      (() => {
        const btn = document.querySelector('.toast-action');
        if (!btn) return 'no-btn';
        btn.click();
        return 'clicked';
      })()
    `)
    await sleep(800)
    const afterUndo = await titles()
    results.push([
      '撤销后卡片恢复',
      afterUndo.includes('要被删的') && afterUndo.length === 2,
      JSON.stringify(afterUndo)
    ])

    // 4. 撤销条消失
    const toastGone = await c.eval(`!document.querySelector('.toast')`)
    results.push(['撤销条自动消失', toastGone === true, String(toastGone)])

    // 5. 撤销后数据文件里 deletedAt 也清了
    const raw = JSON.parse(fs.readFileSync(DATA, 'utf-8'))
    const restored = raw.cards.find((x) => x.id === 'doomed')
    results.push(['墓碑被清掉', restored && restored.deletedAt === null, String(restored && restored.deletedAt)])

    c.close()
    console.log('')
    let ok = true
    for (const [name, pass, detail] of results) {
      if (!pass) ok = false
      console.log(`${pass ? '✓' : '✗'} ${name.padEnd(18)} ${detail}`)
    }
    console.log('')
    console.log(ok ? '全部通过' : '有失败项')
    child.kill()
    process.exit(ok ? 0 : 1)
  } catch (e) {
    console.error('FAIL', e && e.message)
    child.kill()
    process.exit(1)
  }
})()
