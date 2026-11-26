// 并发压测：同一张卡被多端同时推，检查 LWW 不会脑裂
// 用法： node test/concurrency.js
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const SERVER = process.env.SRV
const PORT = Number(process.env.SRV_PORT ?? 8787)
const TOKEN = process.env.SRV_TOKEN
const BASE = `http://127.0.0.1:${PORT}`

const tmp = mkdtempSync(join(tmpdir(), 'timecard-conc-'))
const DB = join(tmp, 'conc.sqlite')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

function mkCard(id, title, updatedAt) {
  const now = Date.now()
  return {
    id, title, items: [], tag: '', color: '#71805a',
    anchorAt: now, createdAt: now, updatedAt,
    deletedAt: null, rev: 1, status: 'open'
  }
}

async function main() {
  const child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', TIMECARD_TOKEN: TOKEN, TIMECARD_DB: DB },
    stdio: 'ignore'
  })

  try {
    for (let i = 0; i < 100; i += 1) {
      try {
        const r = await fetch(`${BASE}/api/health`)
        if (r.ok) break
      } catch {}
      await sleep(100)
    }

    const results = []
    const check = (n, p, d = '') => {
      results.push([n, p])
      console.log(`${p ? '✓' : '✗'} ${n}${d ? '  ' + d : ''}`)
    }

    /* ---------- 1. 40 个并发写同一张卡，时间戳各不相同 ---------- */
    {
      const base = Date.now()
      const jobs = []
      for (let i = 0; i < 40; i += 1) {
        const ts = base + i * 10
        jobs.push(
          fetch(`${BASE}/api/sync/push`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              deviceId: `dev-${String(i).padStart(2, '0')}`,
              changes: [{ card: mkCard('hot', `写者 ${i}`, ts), deviceId: `dev-${String(i).padStart(2, '0')}`, op: 'create', clientAt: ts }]
            })
          }).then((r) => r.json())
        )
      }
      const all = await Promise.all(jobs)
      const acceptedCount = all.filter((x) => x.accepted.length === 1).length

      const pullRes = await fetch(`${BASE}/api/sync/pull?since=0`, { headers: auth }).then((r) => r.json())
      const hot = pullRes.changes.find((x) => x.card.id === 'hot')
      const expectWinner = '写者 39' // 时间戳最大的那个

      check('并发写只有最终赢家留在库里', hot?.card.title === expectWinner, `库里是「${hot?.card.title}」`)
      check('并发写没有产生重复记录', pullRes.changes.filter((x) => x.card.id === 'hot').length === 1)
      check('至少有一次被接受', acceptedCount >= 1, `accepted=${acceptedCount}/40`)
    }

    /* ---------- 2. 20 张不同卡并发写，游标不能重号 ---------- */
    {
      const jobs = []
      const base = Date.now()
      for (let i = 0; i < 20; i += 1) {
        jobs.push(
          fetch(`${BASE}/api/sync/push`, {
            method: 'POST',
            headers: auth,
            body: JSON.stringify({
              deviceId: 'dev-burst',
              changes: [{ card: mkCard(`burst-${i}`, `并发 ${i}`, base + i), deviceId: 'dev-burst', op: 'create', clientAt: base + i }]
            })
          }).then((r) => r.json())
        )
      }
      await Promise.all(jobs)

      const pullRes = await fetch(`${BASE}/api/sync/pull?since=0&limit=500`, { headers: auth }).then((r) => r.json())
      const burst = pullRes.changes.filter((x) => x.card.id.startsWith('burst-'))
      const seqs = burst.map((x) => x.seq)
      check('20 张并发卡全部入库', burst.length === 20, `got=${burst.length}`)
      check('游标互不重复', new Set(seqs).size === seqs.length, `unique=${new Set(seqs).size}/${seqs.length}`)
      check('游标严格递增', seqs.every((v, i) => i === 0 || v > seqs[i - 1]), `max=${Math.max(...seqs)}`)
    }

    /* ---------- 3. 两个客户端拉扯：A 推新的、B 推旧的 ---------- */
    {
      const t = Date.now() + 100000
      await fetch(`${BASE}/api/sync/push`, {
        method: 'POST', headers: auth,
        body: JSON.stringify({ deviceId: 'A', changes: [{ card: mkCard('tug', 'A 的版本', t), deviceId: 'A', op: 'create', clientAt: t }] })
      })
      // B 用更旧的时间戳推 10 次，都应该被拒
      let allRejected = true
      for (let i = 0; i < 10; i += 1) {
        const r = await fetch(`${BASE}/api/sync/push`, {
          method: 'POST', headers: auth,
          body: JSON.stringify({ deviceId: 'B', changes: [{ card: mkCard('tug', `B 想覆盖 ${i}`, t - 1000 - i), deviceId: 'B', op: 'update', clientAt: t }] })
        }).then((x) => x.json())
        if (r.accepted.length !== 0) allRejected = false
      }
      const pullRes = await fetch(`${BASE}/api/sync/pull?since=0`, { headers: auth }).then((r) => r.json())
      const tug = pullRes.changes.find((x) => x.card.id === 'tug')
      check('旧时间戳连推 10 次全部被拒', allRejected)
      check('库里仍是 A 的版本', tug?.card.title === 'A 的版本', tug?.card.title)
    }

    /* ---------- 4. 大卡片（接近体积上限）也不能崩 ---------- */
    {
      const big = mkCard('big', '大卡片', Date.now())
      big.items = Array.from({ length: 400 }, (_, i) => ({ id: `it-${i}`, text: `条目内容 ${i} `.repeat(8), done: false }))
      const body = JSON.stringify({ deviceId: 'dev-big', changes: [{ card: big, deviceId: 'dev-big', op: 'create', clientAt: Date.now() }] })
      const r = await fetch(`${BASE}/api/sync/push`, { method: 'POST', headers: auth, body }).then((x) => x.json())
      check('几十 KB 的卡片能正常入库', r.accepted.length === 1, `body=${(body.length / 1024).toFixed(0)}KB`)

      const big2 = { ...big, id: 'huge', title: '超大' }
      // 6000 × 200 字符 ≈ 1.2 MB，明确超过 1 MB 上限
      big2.items = Array.from({ length: 6000 }, (_, i) => ({ id: `x-${i}`, text: 'x'.repeat(200), done: false }))
      const body2 = JSON.stringify({ deviceId: 'dev-big', changes: [{ card: big2, deviceId: 'dev-big', op: 'create', clientAt: Date.now() }] })
      const r2 = await fetch(`${BASE}/api/sync/push`, { method: 'POST', headers: auth, body: body2 })
      check('超过 1MB 被拒 413', r2.status === 413, `status=${r2.status} body=${(body2.length / 1024 / 1024).toFixed(1)}MB`)
    }

    const pass = results.filter((r) => r[1]).length
    console.log('')
    console.log(`共 ${results.length} 项，通过 ${pass} 项`)
    process.exitCode = pass === results.length ? 0 : 1
  } finally {
    child.kill()
    await sleep(300)
    rmSync(tmp, { recursive: true, force: true })
  }
}

main().catch((e) => {
  console.error('FAIL', e)
  process.exit(1)
})
