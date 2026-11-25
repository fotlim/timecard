// 服务端端到端测试：起真进程、打真 HTTP
// 用法： node test/e2e.js
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SERVER = process.env.SRV
const PORT = Number(process.env.SRV_PORT ?? 3701)
const TOKEN = process.env.SRV_TOKEN
const BASE = `http://127.0.0.1:${PORT}`

const tmp = mkdtempSync(join(tmpdir(), 'timecard-srv-'))
const DB = join(tmp, 'test.sqlite')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

async function push(body) {
  const r = await fetch(`${BASE}/api/sync/push`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify(body)
  })
  return { status: r.status, body: await r.json() }
}

async function pull(since = 0, limit) {
  const q = new URLSearchParams({ since: String(since) })
  if (limit !== undefined) q.set('limit', String(limit))
  const r = await fetch(`${BASE}/api/sync/pull?${q}`, { headers: auth })
  return { status: r.status, body: await r.json() }
}

async function main() {
  await startServer()
  const t0 = Date.now()

  /* ---------- 健康检查 ---------- */
  {
    const r = await fetch(`${BASE}/api/health`)
    const b = await r.json()
    check('健康检查免鉴权', r.status === 200 && b.ok === true, `cardCount=${b.cardCount}`)
    check('健康检查带版本号', typeof b.version === 'string' && b.version.length > 0, b.version)
  }

  /* ---------- 鉴权 ---------- */
  {
    const r1 = await fetch(`${BASE}/api/sync/pull?since=0`)
    check('无 token 被拒 401', r1.status === 401, String(r1.status))

    const r2 = await fetch(`${BASE}/api/sync/pull?since=0`, {
      headers: { Authorization: 'Bearer wrong-token' }
    })
    check('错 token 被拒 401', r2.status === 401, String(r2.status))

    const r3 = await fetch(`${BASE}/api/sync/pull?since=0`, {
      headers: { Authorization: 'Basic abc' }
    })
    check('非 Bearer 方案被拒', r3.status === 401, String(r3.status))
  }

  /* ---------- 首次推送 ---------- */
  {
    const now = Date.now()
    const r = await push({
      deviceId: 'dev-A',
      changes: [
        { card: card('c1', '第一张', now), deviceId: 'dev-A', op: 'create', clientAt: now },
        { card: card('c2', '第二张', now + 1), deviceId: 'dev-A', op: 'create', clientAt: now }
      ]
    })
    check(
      '首次推送全部接受',
      r.status === 200 && r.body.accepted.length === 2 && r.body.rejected.length === 0,
      `accepted=${r.body.accepted.length}`
    )
    check('响应带游标', typeof r.body.cursor === 'number' && r.body.cursor >= 2, `cursor=${r.body.cursor}`)
  }

  /* ---------- 全量拉取 ---------- */
  {
    const r = await pull(0)
    check(
      '从 0 拉取拿到 2 张',
      r.body.changes.length === 2,
      `got=${r.body.changes.length}`
    )
    check(
      '拉取结果按 seq 升序',
      r.body.changes[0].seq < r.body.changes[1].seq,
      `${r.body.changes[0].seq} < ${r.body.changes[1].seq}`
    )
    check('lastDeviceId 正确回填', r.body.changes[0].lastDeviceId === 'dev-A')
  }

  /* ---------- 增量拉取 ---------- */
  {
    const cursor = (await pull(0)).body.cursor
    const r = await pull(cursor)
    check('用最新游标拉取应为空', r.body.changes.length === 0, `got=${r.body.changes.length}`)
    check('空拉取 hasMore=false', r.body.hasMore === false)
  }

  /* ---------- LWW：旧版本被拒 ---------- */
  {
    const old = card('c1', '第一张（旧标题）', 1)
    const r = await push({
      deviceId: 'dev-B',
      changes: [{ card: old, deviceId: 'dev-B', op: 'update', clientAt: Date.now() }]
    })
    check(
      '旧时间戳被拒绝',
      r.body.accepted.length === 0 && r.body.rejected.length === 1,
      `rejected=${r.body.rejected.length}`
    )
    check(
      '拒绝时回服务端最新版本',
      r.body.rejected[0]?.serverCard?.title === '第一张',
      r.body.rejected[0]?.serverCard?.title ?? 'null'
    )
  }

  /* ---------- LWW：新版本被接受 ---------- */
  {
    const newer = card('c1', '第一张（新标题）', Date.now() + 10000)
    const r = await push({
      deviceId: 'dev-B',
      changes: [{ card: newer, deviceId: 'dev-B', op: 'update', clientAt: Date.now() }]
    })
    check('新时间戳被接受', r.body.accepted.length === 1, `accepted=${r.body.accepted.length}`)

    const after = await pull(0)
    const c1 = after.body.changes.find((x) => x.card.id === 'c1')
    check('服务端已更新为新标题', c1?.card.title === '第一张（新标题）', c1?.card.title)
    check('lastDeviceId 变成 dev-B', c1?.lastDeviceId === 'dev-B', c1?.lastDeviceId)
  }

  /* ---------- LWW：同一时间戳靠 deviceId 字典序 ---------- */
  {
    const ts = Date.now() + 20000
    // 先让 dev-Z 写
    await push({
      deviceId: 'dev-Z',
      changes: [{ card: card('c3', 'Z 写的', ts), deviceId: 'dev-Z', op: 'create', clientAt: ts }]
    })
    // dev-A 用同样的时间戳推，字典序 A < Z，应该被拒
    const r = await push({
      deviceId: 'dev-A',
      changes: [{ card: card('c3', 'A 写的', ts), deviceId: 'dev-A', op: 'update', clientAt: ts }]
    })
    check('同时间戳时字典序小的被拒', r.body.accepted.length === 0, `accepted=${r.body.accepted.length}`)

    const after = await pull(0)
    const c3 = after.body.changes.find((x) => x.card.id === 'c3')
    check('胜者仍是 dev-Z', c3?.card.title === 'Z 写的', c3?.card.title)
  }

  /* ---------- 同一条重复推送（幂等） ---------- */
  {
    const ts = Date.now() + 30000
    const body = {
      deviceId: 'dev-M',
      changes: [{ card: card('c4', '幂等测试', ts), deviceId: 'dev-M', op: 'create', clientAt: ts }]
    }
    const r1 = await push(body)
    const r2 = await push(body)
    check('首次推送接受', r1.body.accepted.length === 1)
    check(
      '重复推送不重复接受',
      r2.body.accepted.length === 0 && r2.body.rejected.length === 0,
      `accepted=${r2.body.accepted.length} rejected=${r2.body.rejected.length}`
    )
  }

  /* ---------- 软删除同步 ---------- */
  {
    const del = card('c2', '第二张', Date.now() + 40000, { deletedAt: Date.now() + 40000 })
    await push({
      deviceId: 'dev-A',
      changes: [{ card: del, deviceId: 'dev-A', op: 'delete', clientAt: Date.now() }]
    })
    const after = await pull(0)
    const c2 = after.body.changes.find((x) => x.card.id === 'c2')
    check('软删除会同步下去（墓碑）', c2?.card.deletedAt !== null, String(c2?.card.deletedAt))

    const health = await (await fetch(`${BASE}/api/health`)).json()
    check('健康检查的卡片数含软删除', health.cardCount === 4, `cardCount=${health.cardCount}`)
  }

  /* ---------- 分页 ---------- */
  {
    const many = []
    for (let i = 0; i < 10; i += 1) {
      many.push({
        card: card(`p${i}`, `分页 ${i}`, Date.now() + 50000 + i),
        deviceId: 'dev-P',
        op: 'create',
        clientAt: Date.now()
      })
    }
    await push({ deviceId: 'dev-P', changes: many })

    const page1 = await pull(0, 3)
    check('limit 生效', page1.body.changes.length === 3, `got=${page1.body.changes.length}`)
    check('还有更多时 hasMore=true', page1.body.hasMore === true)

    let cursor = page1.body.cursor
    let total = page1.body.changes.length
    let guard = 0
    while (guard < 20) {
      const p = await pull(cursor, 3)
      total += p.body.changes.length
      cursor = p.body.cursor
      if (!p.body.hasMore) break
      guard += 1
    }
    check('翻页能取全', total === 14, `total=${total}（期望 14）`)
  }

  /* ---------- 校验 ---------- */
  {
    const r1 = await push({ deviceId: 'dev-A', changes: 'not-an-array' })
    check('changes 非数组被拒 400', r1.status === 400, String(r1.status))

    const r2 = await push({ changes: [] })
    check('缺 deviceId 被拒 400', r2.status === 400, String(r2.status))

    const r3 = await push({
      deviceId: 'dev-A',
      changes: [{ card: { id: 'x' }, deviceId: 'dev-A', op: 'create', clientAt: 1 }]
    })
    check('卡片字段不全被拒 400', r3.status === 400, JSON.stringify(r3.body.details?.[0]?.errors ?? []).slice(0, 80))

    const r4 = await push({
      deviceId: 'dev-A',
      changes: [{ card: card('y', 'Y', 1, { status: 'bogus' }), deviceId: 'dev-A', op: 'create', clientAt: 1 }]
    })
    check('非法 status 被拒', r4.status === 400, String(r4.status))

    const bad = await fetch(`${BASE}/api/sync/pull?since=abc`, { headers: auth })
    check('非法游标被拒 400', bad.status === 400, String(bad.status))

    const notfound = await fetch(`${BASE}/api/nope`, { headers: auth })
    check('未知路径 404', notfound.status === 404, String(notfound.status))
  }

  /* ---------- 超批量 ---------- */
  {
    const tooMany = []
    for (let i = 0; i < 51; i += 1) {
      tooMany.push({ card: card(`b${i}`, `批量 ${i}`, Date.now()), deviceId: 'dev-A', op: 'create', clientAt: 1 })
    }
    const r = await push({ deviceId: 'dev-A', changes: tooMany })
    check('超过 50 条被拒 400', r.status === 400, `status=${r.status}`)
  }

  /* ---------- 重启后数据还在 ---------- */
  {
    await stopServer()
    await startServer()
    const after = await pull(0)
    check('重启后数据仍在', after.body.changes.length === 14, `got=${after.body.changes.length}`)
    const c1 = after.body.changes.find((x) => x.card.id === 'c1')
    check('重启后内容正确', c1?.card.title === '第一张（新标题）', c1?.card.title)
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
