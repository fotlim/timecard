// 验证：桌面端导出 / 导入备份（含"清空后从备份恢复"），以及导出文件不含令牌
const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')

const PORT = Number(process.env.TC_CDP_PORT ?? 9902)
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-backup-'))
const BACKUP = path.join(DATA_DIR, 'backup.json')
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
const readData = () => JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'timecard.json'), 'utf-8'))
const liveCount = () => readData().cards.filter((c) => c.deletedAt === null).length

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
    await sleep(1200)

    const before = liveCount()
    check('启动有示例卡片', before > 0, `live=${before}`)

    // 1) 导出
    const exp = await c.eval(`window.timecard.data.exportTo(${JSON.stringify(BACKUP)})`)
    check('导出成功', exp && exp.ok === true, JSON.stringify(exp))
    check('备份文件已生成', fs.existsSync(BACKUP))

    const raw = fs.readFileSync(BACKUP, 'utf-8')
    const parsed = JSON.parse(raw)
    check('备份含全部卡片', Array.isArray(parsed.cards) && parsed.cards.length >= before, `cards=${parsed.cards?.length}`)
    check('备份不含同步令牌', !raw.includes('"token"') && !raw.includes('token'), 'no token field')
    check('备份带格式标记', parsed.format === 'timecard-backup', String(parsed.format))

    // 2) 清空全部 → 活着的是 0
    await c.eval(`window.timecard.store.clearAll()`)
    await sleep(600)
    check('清空后活跃卡片为 0', liveCount() === 0, `live=${liveCount()}`)

    // 3) 从备份导入 → 恢复
    const imp = await c.eval(`window.timecard.data.importFrom(${JSON.stringify(BACKUP)})`)
    check('导入成功', imp && imp.ok === true, JSON.stringify(imp))
    await sleep(600)
    check('清空后能从备份恢复', liveCount() === before, `live=${liveCount()} / 期望 ${before}`)

    // 4) 再导入一次：幂等，不重复添加
    const imp2 = await c.eval(`window.timecard.data.importFrom(${JSON.stringify(BACKUP)})`)
    await sleep(500)
    check('重复导入不重复添加', imp2 && imp2.added === 0, JSON.stringify(imp2))
    check('重复导入后卡片数不变', liveCount() === before, `live=${liveCount()}`)

    // 5) 坏文件要给出人话错误
    const badPath = path.join(DATA_DIR, 'bad.json')
    fs.writeFileSync(badPath, '{ not json', 'utf-8')
    const bad = await c.eval(`window.timecard.data.importFrom(${JSON.stringify(badPath)})`)
    check('坏备份被拒绝且有原因', bad && bad.ok === false && typeof bad.error === 'string', JSON.stringify(bad))

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
  process.exit(pass === results.length && results.length > 0 ? 0 : 1)
})()
