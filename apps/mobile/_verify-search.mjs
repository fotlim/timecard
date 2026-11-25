// 手机端全库搜索：功能 + 截图
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CDP_PORT = Number(process.env.TC_CDP_PORT ?? 9338)
const PREVIEW = process.env.TC_PREVIEW_URL ?? 'http://127.0.0.1:5190/'
const CHROME = process.env.TC_CHROME ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const OUT = process.argv[2]

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
  const DAY = 86400000
  const card = (id, title, tag, anchorAt, items = []) => ({
    id, title, items, tag, color: '#71805a', anchorAt, order: 0,
    status: 'open', createdAt: now, updatedAt: now, deletedAt: null, rev: 1
  })
  const seed = {
    skin: 'organic',
    cards: [
      card('s1', '买菜清单', '生活', now, [{ id: 'i1', text: '关键条目词', done: false }]),
      card('s2', '装修这个事', '工作', now - DAY),
      card('s3', '独一无二的演讲稿', '工作', now + DAY)
    ],
    deviceId: 'm-search',
    cursor: 0,
    lastSyncAt: null,
    sync: { enabled: false, serverUrl: '', token: '' },
    outbox: [],
    outboxSeq: 0
  }

  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-search-'))
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

  check('搜索入口存在', await c.eval(`!!document.querySelector('.m-search')`))
  await c.eval(`document.querySelector('.m-search').click()`)
  await sleep(500)
  check('点搜索打开抽屉', await c.eval(`!!document.querySelector('.search-list')`))
  check('初始提示「输入关键词」', await c.eval(`(document.querySelector('.search-hint')?.textContent||'').includes('输入关键词')`))

  const typeQuery = (q) => c.eval(`(() => {
    const el = document.querySelector('.sheet input');
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set;
    setter.call(el, ${JSON.stringify(q)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true
  })()`)

  await typeQuery('演讲稿')
  await sleep(300)
  const rows1 = await c.eval(`document.querySelectorAll('.search-row').length`)
  check('搜「演讲稿」命中 1 条', rows1 === 1, `rows=${rows1}`)
  check('结果标题正确', await c.eval(`(document.querySelector('.search-row-title')?.textContent||'').includes('演讲稿')`))

  // 截图（结果态）
  if (OUT) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true })
    const r = await c.send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(OUT, Buffer.from(r.data, 'base64'))
  }

  await typeQuery('搜不存在的词xyz')
  await sleep(300)
  check('无结果时显示提示', await c.eval(`(document.querySelector('.search-hint')?.textContent||'').includes('没有匹配')`))

  await typeQuery('买菜')
  await sleep(300)
  check('搜「买菜」命中 1 条', (await c.eval(`document.querySelectorAll('.search-row').length`)) === 1)

  // 条目内容也能搜到（"独一无二"之类不出现在标题里，这里用注入的条目词）
  await typeQuery('关键条目词')
  await sleep(300)
  const itemRows = await c.eval(`document.querySelectorAll('.search-row').length`)
  check('条目内容也能搜到', itemRows === 1, `rows=${itemRows}`)
  check(
    '结果里标出命中的条目',
    await c.eval(`(document.querySelector('.search-row-hit')?.textContent || '').includes('关键条目词')`)
  )

  // 点结果 → 打开该卡编辑抽屉
  await c.eval(`document.querySelector('.search-row').click()`)
  await sleep(500)
  const editTitle = await c.eval(`document.querySelector('.sheet input')?.value ?? ''`)
  check('点结果切到编辑抽屉并带出标题', editTitle === '买菜清单', `value=${editTitle}`)
  check('搜索列表已关闭', (await c.eval(`document.querySelectorAll('.search-row').length`)) === 0)

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
