// 验证：本地落盘失败时界面必须看得见，并且「重试」能恢复
// 手法：把 data 目录下的 timecard.json.tmp 预先建成"目录"，writeFile 必抛 EISDIR
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.env.TC_CDP_PORT ?? 9894)
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-savefail-'))
const TMP_BLOCKER = path.join(DATA_DIR, 'timecard.json.tmp')
// 先把 .tmp 占成目录，逼 writeFile 报 EISDIR
fs.mkdirSync(TMP_BLOCKER, { recursive: true })

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

    // 1) 启动就写失败 → 警告条应该出现
    await sleep(1200)
    const bannerText = await c.eval(
      `(() => { const el = document.querySelector('.save-error'); return el ? el.textContent : null })()`
    )
    check('落盘失败时出现警告条', typeof bannerText === 'string', bannerText || '无')
    check('警告条文案含「保存失败」', typeof bannerText === 'string' && bannerText.includes('保存失败'))
    check('警告条有重试按钮', await c.eval(`!!document.querySelector('.save-error-btn')`))

    // 2) 连内存数据都在（写盘失败不影响当前使用）
    const cardCount = await c.eval(`document.querySelectorAll('.m-list .card').length`)
    check('写盘失败不影响当前卡片渲染', typeof cardCount === 'number' && cardCount > 0, `cards=${cardCount}`)

    // 3) 解除故障，点重试 → 应恢复
    fs.rmdirSync(TMP_BLOCKER)
    await c.eval(`document.querySelector('.save-error-btn').click()`)
    await sleep(900)
    const gone = await c.eval(`!document.querySelector('.save-error')`)
    check('点重试后警告条消失', gone === true)
    const onDisk = fs.existsSync(path.join(DATA_DIR, 'timecard.json'))
    check('恢复后数据真的落盘了', onDisk)

    c.close()
  } catch (e) {
    check('测试执行', false, String(e && e.message ? e.message : e))
  } finally {
    child.kill()
    await sleep(300)
    try {
      fs.rmSync(DATA_DIR, { recursive: true, force: true })
    } catch {}
  }

  const pass = results.filter((r) => r[1]).length
  console.log(`\n共 ${results.length} 项，通过 ${pass} 项`)
  process.exit(pass === results.length ? 0 : 1)
})()
