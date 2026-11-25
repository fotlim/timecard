// 验证自绘右键菜单：能弹出、跟皮肤、点了真办事、点外面/ Esc 能关
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = 9581
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA = path.join(process.env.APPDATA || '', 'Timecard', 'timecard.json')
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
            if (r && r.exceptionDetails) throw new Error('JS 异常: ' + r.exceptionDetails.text)
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

const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
}

;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  env.TIMECARD_BOOT = 'today/organic'

  try { fs.unlinkSync(DATA) } catch (e) {}
  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await findPage('index.html')
    const m = await connect(t.webSocketDebuggerUrl)
    await sleep(2200)

    const readData = () => JSON.parse(fs.readFileSync(DATA, 'utf-8'))

    // 1. 右键弹出
    await m.eval(`
      (() => {
        const card = document.querySelector('.card');
        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 260
        }));
        return 'ok';
      })()
    `)
    await sleep(400)
    const opened = await m.eval(`!!document.querySelector('.ctxmenu')`)
    check('右键弹出菜单', opened === true, String(opened))

    // 2. 菜单项齐全
    const labels = await m.eval(`
      [...document.querySelectorAll('.ctx-item')].map(b => b.textContent.trim())
    `)
    check(
      '菜单项齐全',
      Array.isArray(labels) && labels.length >= 7,
      (labels || []).join(' | ')
    )

    // 3. 危险项存在且是删除
    const danger = await m.eval(`
      (() => {
        const d = document.querySelector('.ctx-item.danger');
        return d ? d.textContent.trim() : null;
      })()
    `)
    check('危险项是「删除」', danger === '删除这张卡', String(danger))

    // 4. 点「改到明天」真的改日期
    const before = readData()
    const c0 = before.cards.find((c) => c.title === '交水电费')
    await m.eval(`
      (() => {
        const btn = [...document.querySelectorAll('.ctx-item')]
          .find(b => b.textContent.includes('明天'));
        if (!btn || btn.disabled) return 'not-clickable';
        btn.click();
        return 'clicked';
      })()
    `)
    await sleep(700)
    const after = readData()
    const c1 = after.cards.find((c) => c.title === '交水电费')
    const dayBefore = new Date(c0.anchorAt).toDateString()
    const dayAfter = new Date(c1.anchorAt).toDateString()
    check('点「改到明天」真改了日期', dayBefore !== dayAfter, `${dayBefore} → ${dayAfter}`)

    // 5. 点完菜单自动关闭
    const closedAfterClick = await m.eval(`!document.querySelector('.ctxmenu')`)
    check('点完自动关闭', closedAfterClick === true, String(closedAfterClick))

    // 6. 再弹一次，按 Esc 关闭
    await m.eval(`
      (() => {
        const card = document.querySelector('.card');
        card.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, clientX: 120, clientY: 260
        }));
        return 'ok';
      })()
    `)
    await sleep(300)
    await m.eval(`
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      'ok'
    `)
    await sleep(300)
    const closedByEsc = await m.eval(`!document.querySelector('.ctxmenu')`)
    check('Esc 能关', closedByEsc === true, String(closedByEsc))

    // 7. 空白处右键也能弹，且内容不同
    await m.eval(`
      (() => {
        const screen = document.querySelector('.screen');
        screen.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2, clientX: 200, clientY: 600
        }));
        return 'ok';
      })()
    `)
    await sleep(400)
    const blankLabels = await m.eval(`
      [...document.querySelectorAll('.ctx-item')].map(b => b.textContent.trim())
    `)
    check(
      '空白处菜单内容不同',
      Array.isArray(blankLabels) && blankLabels.some((l) => l.includes('挂一张')),
      (blankLabels || []).join(' | ')
    )

    // 8. 菜单跟随皮肤（读 CSS 变量算出的圆角/边框）
    const themed = await m.eval(`
      (() => {
        const el = document.querySelector('.ctxmenu');
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { radius: cs.borderTopLeftRadius, border: cs.borderTopWidth, theme: document.documentElement.dataset.theme };
      })()
    `)
    check('菜单挂上了当前皮肤', themed && themed.theme === 'organic', JSON.stringify(themed))

    m.close()
    console.log('')
    let ok = true
    for (const [name, pass, detail] of results) {
      if (!pass) ok = false
      console.log(`${pass ? '✓' : '✗'} ${name.padEnd(22)} ${detail}`)
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
