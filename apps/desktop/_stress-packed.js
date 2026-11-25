// 压力 / 边界测试：找出真实缺陷
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = 9611
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(BASE, 'release', 'win-unpacked', '挂卡时间轴.exe')
const DATA = path.join(process.env.APPDATA || '', 'Timecard', 'timecard.json')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function findPage(want, port = PORT) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/list`)
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
        send: (method, params) =>
          new Promise((res, rej) => {
            const i = ++id
            pend.set(i, { res, rej })
            ws.send(JSON.stringify({ id: i, method, params }))
          }),
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

const findings = []
function report(area, level, detail) {
  findings.push({ area, level, detail })
  const mark = level === 'BUG' ? '✗' : level === 'WARN' ? '!' : '✓'
  console.log(`${mark} [${area}] ${detail}`)
}

function startApp(port = PORT, boot = 'today/organic') {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  delete env.TIMECARD_WIDE
  env.TIMECARD_BOOT = boot
  return spawn(ELECTRON, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' })
}

;(async () => {
  // 构造一个「一天 8 张卡 + 一张超长标题」的数据
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const seed = {
    skin: 'organic',
    prefs: { closeToTray: true },
    cards: []
  }
  for (let i = 0; i < 8; i++) {
    seed.cards.push({
      id: `stress-${i}`,
      title: i === 0 ? '这是一个特别特别长的卡片标题用来测试文字溢出和换行是否会把布局搞坏' : `压力卡 ${i + 1}`,
      items: [
        { id: `it-${i}-a`, text: `条目 ${i}-1`, done: false },
        { id: `it-${i}-b`, text: `条目 ${i}-2`, done: i % 2 === 0 }
      ],
      tag: i === 0 ? '一个非常长的分类名称用来测试溢出' : `分类 ${i + 1}`,
      color: '#71805a',
      anchorAt: today.getTime() + 9 * 3600000 + i * 600000,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      deletedAt: null,
      rev: 1,
      status: 'open'
    })
  }
  fs.mkdirSync(path.dirname(DATA), { recursive: true })
  fs.writeFileSync(DATA, JSON.stringify(seed, null, 2), 'utf-8')

  const child = startApp()
  try {
    const mainT = await findPage('index.html')
    const main = await connect(mainT.webSocketDebuggerUrl)
    await sleep(4500)

    /* ---------- 1. 主窗口：8 张卡是否都可滚动看到 ---------- */
    const mainInfo = await main.eval(`
      (() => {
        const list = document.querySelector('.m-list');
        const cards = document.querySelectorAll('.m-list .card:not(.new)');
        return {
          count: cards.length,
          scrollable: list ? list.scrollHeight > list.clientHeight : null,
          scrollH: list ? list.scrollHeight : 0,
          clientH: list ? list.clientHeight : 0
        };
      })()
    `)
    report(
      '主窗口',
      mainInfo.count === 8 ? 'OK' : 'BUG',
      `渲染 ${mainInfo.count}/8 张卡，列表可滚动=${mainInfo.scrollable} (${mainInfo.scrollH}/${mainInfo.clientH})`
    )

    /* ---------- 2. 长标题是否溢出 ---------- */
    const overflow = await main.eval(`
      (() => {
        const h3 = document.querySelector('.m-list .card h3');
        if (!h3) return null;
        const card = h3.closest('.card');
        return {
          titleW: Math.round(h3.scrollWidth),
          titleBoxW: Math.round(h3.clientWidth),
          overflowsCard: h3.scrollWidth > card.clientWidth,
          docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth
        };
      })()
    `)
    report(
      '长标题',
      overflow && !overflow.docOverflowX ? 'OK' : 'BUG',
      `标题 ${overflow?.titleW}/${overflow?.titleBoxW}，横向溢出整页=${overflow?.docOverflowX}`
    )

    /* ---------- 3. 浮窗：8 张卡只显示 4 张？ ---------- */
    await main.eval(`window.timecard.quick.show(); 'ok'`)
    await sleep(1000)
    const quickT = await findPage('quick.html')
    const quick = await connect(quickT.webSocketDebuggerUrl)
    await sleep(800)

    const quickInfo = await quick.eval(`
      (() => {
        const rows = document.querySelectorAll('.qrow');
        const list = document.querySelector('.qlist');
        const shell = document.querySelector('.quick-shell');
        const more = document.querySelector('.qmore');
        return {
          rows: rows.length,
          hasMoreHint: !!more,
          listScroll: list ? list.scrollHeight > list.clientHeight : null,
          shellH: shell ? Math.round(shell.getBoundingClientRect().height) : 0
        };
      })()
    `)
    report(
      '浮窗截断',
      quickInfo.rows >= 4 && quickInfo.hasMoreHint ? 'OK' : 'BUG',
      `当天 8 张卡，浮窗只渲染 ${quickInfo.rows} 行；有没有「还有 N 张」提示=${quickInfo.hasMoreHint}`
    )

    /* ---------- 4. 浮窗高度上限 720：内容更高会不会被裁 ---------- */
    const clipCheck = await quick.eval(`
      (() => {
        const shell = document.querySelector('.quick-shell');
        const b = shell.getBoundingClientRect();
        return { contentH: Math.round(b.height), winH: window.innerHeight,
                 clipped: b.height > window.innerHeight + 1 };
      })()
    `)
    report(
      '浮窗高度',
      !clipCheck.clipped ? 'OK' : 'BUG',
      `内容高 ${clipCheck.contentH}，窗口高 ${clipCheck.winH}，被裁=${clipCheck.clipped}`
    )

    quick.close()

    /* ---------- 5. 清空全部 → 空态是否正常 ---------- */
    await main.eval(`window.timecard.store.clearAll(); 'ok'`)
    await sleep(800)
    const empty = await main.eval(`
      (() => {
        const cards = document.querySelectorAll('.m-list .card:not(.new)');
        const newSlot = document.querySelector('.m-list .card.new');
        return { cards: cards.length, hasNewSlot: !!newSlot };
      })()
    `)
    report(
      '空态',
      empty.cards === 0 && empty.hasNewSlot ? 'OK' : 'BUG',
      `清空后卡片 ${empty.cards} 张，有「挂一张」空槽=${empty.hasNewSlot}`
    )

    /* ---------- 6. 极端窄窗口 ---------- */
    await main.eval(`window.resizeTo(380, 620); 'ok'`)
    await sleep(900)
    const narrow = await main.eval(`
      (() => {
        return {
          w: window.innerWidth,
          docOverflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
          bottomBarVisible: (() => {
            const b = document.querySelector('.m-bar');
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return r.bottom <= window.innerHeight + 1 && r.width > 100;
          })()
        };
      })()
    `)
    report(
      '最窄窗口',
      !narrow.docOverflowX && narrow.bottomBarVisible !== false ? 'OK' : 'BUG',
      `宽 ${narrow.w}，横向溢出=${narrow.docOverflowX}，底栏完整=${narrow.bottomBarVisible}`
    )

    /* ---------- 7. 快速连切皮肤 10 次，位置是否稳定 ---------- */
    const b0 = await main.eval(`window.timecard.quick.bounds()`)
    for (let i = 0; i < 10; i++) {
      await main.eval(`window.timecard.store.setSkin('${['organic', 'brutal', 'neo'][i % 3]}')`)
      await sleep(120)
    }
    await sleep(800)
    const b1 = await main.eval(`window.timecard.quick.bounds()`)
    report(
      '快速切皮肤',
      b0 && b1 && b0.x === b1.x && b0.width === b1.width,
      `x ${b0?.x}→${b1?.x}，w ${b0?.width}→${b1?.width}`
    )

    main.close()
  } finally {
    child.kill()
    await sleep(800)
  }

  /* ---------- 8. 重启后数据是否还在 ---------- */
  fs.writeFileSync(
    DATA,
    JSON.stringify(
      {
        skin: 'neo',
        prefs: { closeToTray: false },
        cards: [
          {
            id: 'persist-1',
            title: '重启也要在',
            items: [{ id: 'p1', text: '条目', done: true }],
            tag: '测试',
            color: '#71805a',
            anchorAt: Date.now(),
            createdAt: Date.now(),
            updatedAt: Date.now(),
            deletedAt: null,
            rev: 3,
            status: 'done'
          }
        ]
      },
      null,
      2
    ),
    'utf-8'
  )

  const child2 = startApp(9612, 'today/organic')
  try {
    const t = await findPage('index.html', 9612)
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(4500)
    const persisted = await c.eval(`
      (async () => {
        const s = await window.timecard.store.snapshot();
        return {
          cards: s.cards.length,
          title: s.cards[0] && s.cards[0].title,
          skin: s.skin,
          closeToTray: s.prefs.closeToTray,
          theme: document.documentElement.dataset.theme
        };
      })()
    `)
    report(
      '重启持久化',
      persisted.cards === 1 && persisted.title === '重启也要在' && persisted.skin === 'neo',
      `卡片 ${persisted.cards} 张「${persisted.title}」，皮肤 ${persisted.skin}，theme=${persisted.theme}`
    )
    report(
      '偏好持久化',
      persisted.closeToTray === false,
      `closeToTray 从 false 读回 = ${persisted.closeToTray}`
    )
    c.close()
  } finally {
    child2.kill()
    await sleep(500)
  }

  console.log('')
  const bugs = findings.filter((f) => f.level === 'BUG')
  console.log(`共 ${findings.length} 项检查，${bugs.length} 个问题`)
  process.exit(bugs.length > 0 ? 1 : 0)
})()
