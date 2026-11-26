// 手机端「删除确认」：只多一条提示条，不多冒一个按钮 —— 功能 + 几何 + 截图
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP_PORT = Number(process.env.TC_CDP_PORT ?? 9341)
const PREVIEW = process.env.TC_PREVIEW_URL ?? 'http://127.0.0.1:5191/'
const CHROME = process.env.TC_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = process.argv[2] // 截图输出目录
const SKIN = process.env.TC_SKIN ?? 'organic'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}
function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    const pend = new Map()
    let id = 0
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res) => {
            const i = ++id
            pend.set(i, res)
            ws.send(JSON.stringify({ id: i, method, params }))
          }),
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

async function main() {
  const now = Date.now()
  const card = (id, title, tag) => ({
    id, title, items: [], tag, color: '#71805a', anchorAt: now, order: 0,
    status: 'open', createdAt: now, updatedAt: now, deletedAt: null, rev: 1
  })
  const LONG = '一个很长很长很长的卡片标题用来验证省略号不会被撑成两行'
  const seed = {
    skin: SKIN,
    cards: [card('d1', '112', '未分类'), card('d2', LONG, '工作')],
    deviceId: 'm-del',
    cursor: 0,
    lastSyncAt: null,
    sync: { enabled: false, serverUrl: '', token: '' },
    outbox: [],
    outboxSeq: 0
  }

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-del-'))
  const chrome = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${ud}`, 'about:blank'
  ], { stdio: 'ignore' })

  let page
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      if (r.ok) {
        const all = (await r.json()).filter((t) => t.type === 'page')
        if (all[0]) { page = all[0]; break }
      }
    } catch {}
    await sleep(200)
  }
  if (!page) throw new Error('no page')
  const c = await connect(page.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: 412, height: 892, deviceScaleFactor: 2, mobile: true })
  await c.send('Page.addScriptToEvaluateOnNewDocument', {
    source: 'try{localStorage.setItem("timecard.mobile.v1", ' + JSON.stringify(JSON.stringify(seed)) + ')}catch(e){}'
  })
  await c.send('Page.navigate', { url: PREVIEW })
  await sleep(2200)

  const shot = async (name) => {
    if (!OUT) return
    fs.mkdirSync(OUT, { recursive: true })
    const r = await c.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'))
  }

  const foot = () => `(() => {
    const f = document.querySelector('.sheet-foot')
    if (!f) return null
    const r = f.getBoundingClientRect()
    return { top: +r.top.toFixed(1), height: +r.height.toFixed(1), left: +r.left.toFixed(1), width: +r.width.toFixed(1),
             buttons: f.querySelectorAll('button').length }
  })()`
  const bar = () => `(() => {
    const b = document.querySelector('.sheet-confirm')
    if (!b) return null
    const r = b.getBoundingClientRect()
    const span = b.querySelector('span')
    return { danger: b.classList.contains('danger'),
             text: (span ? span.textContent : '').trim(),
             top: +r.top.toFixed(1), bottom: +r.bottom.toFixed(1),
             spanHeight: span ? +span.getBoundingClientRect().height.toFixed(1) : null,
             buttons: [...b.querySelectorAll('button')].map((x) => x.textContent.trim()) }
  })()`

  // --- 打开「112」这张卡的编辑抽屉
  await c.eval(`document.querySelector('.card-slot .card').click()`)
  await sleep(500)
  check('点卡片打开编辑抽屉', await c.eval(`!!document.querySelector('.sheet-foot')`))
  const foot0 = await c.eval(foot())
  check('正常态底部就是 4 个按钮', foot0 && foot0.buttons === 4, `buttons=${foot0 && foot0.buttons}`)
  check('正常态没有确认条', (await c.eval(bar())) === null)
  await shot('01-normal.png')

  // --- 点「删除」
  await c.eval(`[...document.querySelector('.sheet-foot').querySelectorAll('button')].find((b) => b.textContent.trim() === '删除').click()`)
  await sleep(350)
  const b1 = await c.eval(bar())
  const foot1 = await c.eval(foot())
  check('点删除后出现确认条', b1 !== null)
  check('确认条是危险样式', !!(b1 && b1.danger))
  check('确认条写清要删哪张卡', !!(b1 && b1.text.includes('112')), `text=${b1 && b1.text}`)
  check('确认条只有「取消 / 删除」两个按钮', !!(b1 && b1.buttons.length === 2),
    `buttons=${b1 && JSON.stringify(b1.buttons)}`)
  check('底部按钮数没有变多', foot1 && foot1.buttons === 4, `before=4 after=${foot1 && foot1.buttons}`)
  check('底部按钮行一个像素都没挪',
    !!(foot0 && foot1 && Math.abs(foot1.top - foot0.top) <= 1 &&
       Math.abs(foot1.height - foot0.height) <= 1 && Math.abs(foot1.left - foot0.left) <= 1),
    `Δtop=${foot0 && foot1 ? (foot1.top - foot0.top).toFixed(1) : '?'} Δheight=${foot0 && foot1 ? (foot1.height - foot0.height).toFixed(1) : '?'}`)
  check('确认条贴在按钮行上方', !!(b1 && foot1 && b1.bottom <= foot1.top + 0.5),
    `barBottom=${b1 && b1.bottom} footTop=${foot1 && foot1.top}`)
  check('底部的「删除」亮了（和确认条对上号）',
    await c.eval(`!!document.querySelector('.sheet-foot .danger-ghost.on')`))
  check('按钮行里只有一个「取消」（不再多塞一个）',
    (await c.eval(`[...document.querySelectorAll('.sheet-foot button')].filter((b) => b.textContent.trim() === '取消').length`)) === 1)
  await shot('02-confirm.png')

  // --- 取消
  await c.eval(`[...document.querySelectorAll('.sheet-confirm button')].find((b) => b.textContent.trim() === '取消').click()`)
  await sleep(300)
  check('点取消后确认条收起', (await c.eval(bar())) === null)
  const foot2 = await c.eval(foot())
  check('取消后按钮行仍然 4 个', foot2 && foot2.buttons === 4)

  // --- 再点删除 → 真删
  await c.eval(`[...document.querySelector('.sheet-foot').querySelectorAll('button')].find((b) => b.textContent.trim() === '删除').click()`)
  await sleep(350)
  await c.eval(`[...document.querySelectorAll('.sheet-confirm button')].find((b) => b.textContent.trim() === '删除').click()`)
  await sleep(600)
  check('确认删除后抽屉关闭', (await c.eval(`!!document.querySelector('.sheet')`)) === false)
  const stillThere = await c.eval(`[...document.querySelectorAll('.card-slot .card h3, .card-slot .card')].some((n) => n.textContent.includes('112'))`)
  check('卡片从今日列表消失', stillThere === false)
  const stored = await c.eval(`(() => {
    const db = JSON.parse(localStorage.getItem('timecard.mobile.v1') || '{}')
    const k = (db.cards || []).find((x) => x.id === 'd1')
    return k ? { deletedAt: k.deletedAt } : null
  })()`)
  check('落库是软删除（deletedAt 非空）', !!(stored && stored.deletedAt), `deletedAt=${stored && stored.deletedAt}`)

  // --- 长标题不会把确认条撑成两行
  await c.eval(`document.querySelector('.card-slot .card').click()`)
  await sleep(500)
  await c.eval(`[...document.querySelector('.sheet-foot').querySelectorAll('button')].find((b) => b.textContent.trim() === '删除').click()`)
  await sleep(350)
  const bl = await c.eval(bar())
  check('长标题的确认条只有一行', !!(bl && bl.spanHeight !== null && bl.spanHeight <= 24),
    `spanHeight=${bl && bl.spanHeight}`)
  check('长标题被省略号截断（不换行）',
    await c.eval(`(() => { const s = document.querySelector('.sheet-confirm span');
      return s.scrollWidth > s.clientWidth && getComputedStyle(s).textOverflow === 'ellipsis' })()`))
  check('长标题下按钮行依旧没挪动',
    (await c.eval(foot())).buttons === 4)
  await shot('03-long-title.png')

  c.close()
  chrome.kill()
  await sleep(200)
  try { fs.rmSync(ud, { recursive: true, force: true }) } catch {}
}

main()
  .catch((e) => check('测试执行', false, String(e && e.message ? e.message : e)))
  .finally(() => {
    const pass = results.filter((r) => r[1]).length
    console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
    process.exit(pass === results.length && results.length > 0 ? 0 : 1)
  })
