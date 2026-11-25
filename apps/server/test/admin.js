// 管理面板 / 管理 API 的端到端测试：起真进程、打真 HTTP
// 用法： node test/admin.js
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SERVER = join(HERE, '..', 'dist', 'node.js')
const PORT = Number(process.env.TC_TEST_PORT ?? 18331)
const TOKEN = 'admin-token-xyz9'
const BASE = `http://127.0.0.1:${PORT}`

const tmp = mkdtempSync(join(tmpdir(), 'timecard-admin-'))
const DB = join(tmp, 'test.sqlite')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

let child = null
async function startServer() {
  child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      TIMECARD_TOKEN: TOKEN,
      TIMECARD_DB: DB
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`)
      if (r.ok) return
    } catch {}
    await sleep(100)
  }
  throw new Error('服务没起来')
}
async function stopServer() {
  if (!child) return
  child.kill()
  await sleep(400)
  child = null
}

const results = []
function check(name, pass, detail = '') {
  results.push([name, pass, detail])
  console.log(`${pass ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`)
}

function card(id, title, updatedAt, extra = {}) {
  const now = Date.now()
  return {
    id,
    title,
    items: [],
    tag: '',
    color: '#71805a',
    anchorAt: now,
    createdAt: now,
    updatedAt,
    deletedAt: null,
    rev: 1,
    status: 'open',
    ...extra
  }
}

async function push(deviceId, changes) {
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ deviceId, changes })
  })
  return { status: r.status, body: await r.json() }
}
async function pull(since = 0, deviceId) {
  const headers = deviceId ? { ...auth, 'X-Device-Id': deviceId } : auth
  const r = await fetch(`${BASE}/api/sync/pull?since=${since}`, { headers })
  return { status: r.status, body: await r.json() }
}
async function adminGet(path, withAuth = true) {
  const r = await fetch(`${BASE}${path}`, { headers: withAuth ? auth : {} })
  const text = await r.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: r.status, body }
}
async function adminPost(path) {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: auth })
  return { status: r.status, body: await r.json() }
}

async function main() {
  await startServer()
  const t0 = Date.now()

  /* ---------- 面板静态页 ---------- */
  {
    const r = await fetch(`${BASE}/`)
    const html = await r.text()
    check('根路径返回 HTML', r.status === 200 && /text\/html/.test(r.headers.get('content-type') || ''), String(r.status))
    check('HTML 含应用挂载点', html.includes('id="app"') && html.includes('挂卡时间轴'))
    check('HTML 含控制台关键字', html.includes('同步服务控制台') || html.includes('同步控制台'))

    const r2 = await fetch(`${BASE}/admin`)
    check('/admin 同样返回面板', r2.status === 200 && (await r2.text()).includes('id="app"'))

    const r3 = await fetch(`${BASE}/favicon.ico`)
    check('favicon 返回 204', r3.status === 204, String(r3.status))
  }

  /* ---------- 鉴权 ---------- */
  {
    const noAuth = await adminGet('/api/admin/overview', false)
    check('概览无令牌被拒 401', noAuth.status === 401, String(noAuth.status))

    const badTok = await fetch(`${BASE}/api/admin/overview`, {
      headers: { Authorization: 'Bearer nope' }
    })
    check('概览错令牌被拒 401', badTok.status === 401, String(badTok.status))
  }

  /* ---------- 造数据 ---------- */
  {
    const now = Date.now()
    const r = await push('dev-A', [
      { card: card('a1', '买菜清单', now), deviceId: 'dev-A', op: 'create', clientAt: now },
      {
        card: card('a2', '装修', now + 1, {
          status: 'done',
          items: [
            { id: 'i1', text: '找师傅', done: true },
            { id: 'i2', text: '定方案', done: false }
          ],
          tag: '工作'
        }),
        deviceId: 'dev-A',
        op: 'create',
        clientAt: now
      },
      { card: card('a3', '读书', now + 2, { status: 'archived' }), deviceId: 'dev-A', op: 'create', clientAt: now }
    ])
    check('预置 3 张卡', r.body.accepted.length === 3, `accepted=${r.body.accepted.length}`)
    // 拉一次并带上设备头，好让设备面板认出来
    await pull(0, 'dev-A')
  }

  /* ---------- 概览 ---------- */
  {
    const r = await adminGet('/api/admin/overview')
    const b = r.body
    check('概览 200', r.status === 200)
    check('概览带版本号', typeof b.version === 'string' && b.version.length > 0, b.version)
    check('概览带 uptime', typeof b.uptimeMs === 'number' && b.uptimeMs >= 0, String(b.uptimeMs))
    check('概览 stats.total = 3', b.stats && b.stats.total === 3, String(b.stats && b.stats.total))
    check('概览 stats.open = 1', b.stats && b.stats.open === 1, String(b.stats && b.stats.open))
    check('概览 stats.done = 1', b.stats && b.stats.done === 1, String(b.stats && b.stats.done))
    check('概览 stats.archived = 1', b.stats && b.stats.archived === 1, String(b.stats && b.stats.archived))
    check('概览 stats.maxSeq >= 3', b.stats && b.stats.maxSeq >= 3, String(b.stats && b.stats.maxSeq))
    check('概览 runtime.kind=node', b.runtime && b.runtime.kind === 'node')
    check('概览带内存数字', typeof b.runtime.memoryBytes === 'number' && b.runtime.memoryBytes > 0)
    check('设备面板认出 dev-A', Array.isArray(b.devices) && b.devices.some((d) => d.deviceId === 'dev-A'))
    const devA = (b.devices || []).find((d) => d.deviceId === 'dev-A')
    check('dev-A 有推送与拉取记录', !!devA && devA.pushes >= 1 && devA.pulls >= 1, devA ? `push=${devA.pushes} pull=${devA.pulls}` : 'none')
    check('概览带事件缓冲计数', b.activity && typeof b.activity.buffered === 'number', String(b.activity && b.activity.buffered))
  }

  /* ---------- 卡片列表 ---------- */
  {
    const all = await adminGet('/api/admin/cards?status=all&limit=50')
    check('卡片列表 200 且 3 条', all.status === 200 && all.body.rows.length === 3, `rows=${all.body.rows.length}`)
    check('列表 total 正确', all.body.total === 3, String(all.body.total))

    const done = await adminGet('/api/admin/cards?status=done')
    check('按状态过滤 done=1', done.body.rows.length === 1 && done.body.rows[0].card.id === 'a2', `n=${done.body.rows.length}`)

    const search = await adminGet('/api/admin/cards?q=' + encodeURIComponent('装修'))
    check('标题搜索命中', search.body.rows.length === 1 && search.body.rows[0].card.id === 'a2', `n=${search.body.rows.length}`)

    const searchMiss = await adminGet('/api/admin/cards?q=' + encodeURIComponent('不存在的词'))
    check('搜索无命中返回 0', searchMiss.body.rows.length === 0)

    const paged = await adminGet('/api/admin/cards?status=all&limit=2&offset=0')
    check('分页 limit 生效', paged.body.rows.length === 2 && paged.body.total === 3, `rows=${paged.body.rows.length}`)

    const badStatus = await adminGet('/api/admin/cards?status=bogus')
    check('非法状态退化为 all', badStatus.status === 200 && badStatus.body.rows.length === 3)
  }

  /* ---------- 单张详情 ---------- */
  {
    const r = await adminGet('/api/admin/cards/a2')
    check('单张详情 200', r.status === 200)
    check('详情带 items', Array.isArray(r.body.card.items) && r.body.card.items.length === 2)
    check('详情带 seq', typeof r.body.seq === 'number')

    const miss = await adminGet('/api/admin/cards/nope')
    check('不存在的卡 404', miss.status === 404, String(miss.status))
  }

  /* ---------- 软删除 / 恢复 ---------- */
  {
    const before = await adminGet('/api/admin/overview')
    const seqBefore = before.body.stats.maxSeq

    const del = await adminPost('/api/admin/cards/a1/delete')
    check('软删除 200', del.status === 200 && del.body.ok === true, JSON.stringify(del.body))
    check('软删除推进了游标', typeof del.body.seq === 'number' && del.body.seq > seqBefore, `seq=${del.body.seq}`)

    const detail = await adminGet('/api/admin/cards/a1')
    check('删除后 deletedAt 非空', detail.body.card.deletedAt !== null && typeof detail.body.card.deletedAt === 'number')

    const ov = await adminGet('/api/admin/overview')
    check('概览 deleted 计数 +1', ov.body.stats.deleted === 1, String(ov.body.stats.deleted))
    check('概览 open 计数归零', ov.body.stats.open === 0, String(ov.body.stats.open))

    const pulled = await pull(0)
    const tomb = pulled.body.changes.find((c) => c.card.id === 'a1')
    check('墓碑能同步给客户端', !!tomb && tomb.card.deletedAt !== null)

    const delAgain = await adminPost('/api/admin/cards/a1/delete')
    check('重复删除幂等', delAgain.status === 200 && delAgain.body.alreadyDeleted === true)

    const restore = await adminPost('/api/admin/cards/a1/restore')
    check('恢复 200', restore.status === 200 && restore.body.ok === true, JSON.stringify(restore.body))
    const detail2 = await adminGet('/api/admin/cards/a1')
    check('恢复后 deletedAt 为空', detail2.body.card.deletedAt === null)

    const ov2 = await adminGet('/api/admin/overview')
    check('恢复后 deleted 归零', ov2.body.stats.deleted === 0, String(ov2.body.stats.deleted))
    check('恢复后 open 回到 1', ov2.body.stats.open === 1, String(ov2.body.stats.open))
  }

  /* ---------- 事件流 ---------- */
  {
    const r = await adminGet('/api/admin/events?since=0&limit=100')
    check('事件流 200', r.status === 200 && Array.isArray(r.body.events))
    const kinds = new Set(r.body.events.map((e) => e.kind))
    check('事件里有 push', kinds.has('push'))
    check('事件里有 pull', kinds.has('pull'))
    check('事件里有 admin', kinds.has('admin'))
    check('事件带 latestId', typeof r.body.latestId === 'number' && r.body.latestId > 0)

    const latest = r.body.latestId
    const inc = await adminGet('/api/admin/events?since=' + latest + '&limit=100')
    check('增量事件（since=latest）为空', inc.body.events.length === 0, `n=${inc.body.events.length}`)
  }

  /* ---------- 导出 ---------- */
  {
    const r = await fetch(`${BASE}/api/admin/export`, { headers: auth })
    const ct = r.headers.get('content-type') || ''
    const dispo = r.headers.get('content-disposition') || ''
    const body = await r.json()
    check('导出 200 且 JSON', r.status === 200 && /json/.test(ct))
    check('导出带附件名', /attachment/.test(dispo) && /\.json/.test(dispo), dispo)
    check('导出含 3 张卡', body.count === 3 && Array.isArray(body.cards) && body.cards.length === 3, `count=${body.count}`)
  }

  /* ---------- 整理 ---------- */
  {
    const r = await adminPost('/api/admin/optimize')
    check('整理数据库 200', r.status === 200 && r.body.ok === true, JSON.stringify(r.body))
    check('整理返回耗时', typeof r.body.ms === 'number')
  }

  /* ---------- 失败事件也要记账（别做成"假健康"） ---------- */
  {
    // 1) 令牌错的拉取
    await fetch(`${BASE}/api/sync/pull?since=0`, { headers: { Authorization: 'Bearer wrong' } })
    // 2) 非法 JSON 的推送
    await fetch(`${BASE}/api/sync/push`, { method: 'POST', headers: auth, body: '{oops' })
    // 3) 超过 50 条的批量推送
    const tooMany = []
    for (let i = 0; i < 51; i += 1) {
      tooMany.push({ card: card(`z${i}`, `批量 ${i}`, Date.now()), deviceId: 'dev-A', op: 'create', clientAt: 1 })
    }
    await fetch(`${BASE}/api/sync/push`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ deviceId: 'dev-A', changes: tooMany })
    })

    const r = await adminGet('/api/admin/events?since=0&limit=200')
    const failed = r.body.events.filter((e) => e.ok === false)
    check('失败事件被记录', failed.length >= 3, `failed=${failed.length}`)
    check('401 记为 unauthorized', failed.some((e) => e.error === 'unauthorized'))
    check('非法 JSON 记为 invalid_json', failed.some((e) => e.error === 'invalid_json'))
    check('超批量记为 batch_too_large', failed.some((e) => e.error === 'batch_too_large'))
    check('失败事件带动耗时', failed.every((e) => typeof e.ms === 'number'))

    const ov = await adminGet('/api/admin/overview')
    const lm = ov.body.activity.lastMinute
    check('概览带近一分钟流量', !!lm && typeof lm.failed === 'number', JSON.stringify(lm))
    check('近一分钟数得到失败', lm.failed >= 3, String(lm.failed))

    const panel = (ov.body.devices || []).find((d) => String(d.deviceId).indexOf('panel@') === 0)
    check('面板设备记录操作次数', !!panel && panel.adminOps >= 2, panel ? `adminOps=${panel.adminOps}` : 'none')
    check('面板设备有失败计数字段', !!panel && typeof panel.failures === 'number')

    const devA = (ov.body.devices || []).find((d) => d.deviceId === 'dev-A')
    check('普通设备记到失败数', !!devA && devA.failures >= 1, devA ? `failures=${devA.failures}` : 'none')
    // 认不出身份的失败（令牌错、JSON 坏）不该在设备列表里伪造一台设备
    check('匿名失败不进设备列表', !(ov.body.devices || []).some((d) => d.deviceId === '(匿名)'))
  }

  /* ---------- 重启后统计仍正确 ---------- */
  {
    await stopServer()
    await startServer()
    const ov = await adminGet('/api/admin/overview')
    check('重启后总数仍为 3', ov.body.stats.total === 3, String(ov.body.stats.total))
    check('重启后面板仍可打开', (await fetch(`${BASE}/`)).status === 200)
  }

  await stopServer()
  const pass = results.filter((r) => r[1]).length
  console.log('')
  console.log(`共 ${results.length} 项，通过 ${pass} 项，用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
  rmSync(tmp, { recursive: true, force: true })
  process.exit(pass === results.length ? 0 : 1)
}

main().catch(async (e) => {
  console.error('FAIL', e)
  await stopServer()
  rmSync(tmp, { recursive: true, force: true })
  process.exit(1)
})
