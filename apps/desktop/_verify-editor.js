// 卡片编辑 + 拖拽改期 测试
const { spawn } = require('child_process')
const fs = require('fs')
const path = require('path')

const PORT = Number(process.env.TC_CDP_PORT ?? 9891)
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
// 数据目录隔离：脚本只碰临时目录，绝不删用户的 %APPDATA%\Timecard
const DATA_DIR =
  process.env.TIMECARD_DATA_DIR ||
  path.join(fs.mkdtempSync(path.join(require('os').tmpdir(), 'tc-editor-')), 'userData')
const DATA = path.join(DATA_DIR, 'timecard.json')
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
      const p = pend.get(m.id)
      if (!p) return
      pend.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
    }
  })
}

const readData = () => JSON.parse(fs.readFileSync(DATA, 'utf-8'))

// 在 React 里安全地给受控 input 设值
const setInput = (sel, value) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(sel)});
    if (!el) return 'no-el';
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return 'ok';
  })()
`

;(async () => {
  try {
    fs.unlinkSync(DATA)
  } catch {}

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_SHOT_SETTINGS
  delete env.TIMECARD_WIDE
  env.TIMECARD_BOOT = 'week/organic' // 拖拽在周视图里测
  // 明确告诉应用「用这个临时目录」，别碰真人数据
  env.TIMECARD_DATA_DIR = DATA_DIR

  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  try {
    const t = await findPage('index.html')
    const c = await connect(t.webSocketDebuggerUrl)
    await sleep(3200)

    /* ---------- 1. 双击卡片打开编辑器 ---------- */
    {
      const opened = await c.eval(`
        (() => {
          const card = document.querySelector('.card:not(.new)');
          if (!card) return 'no-card';
          card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return 'ok';
        })()
      `)
      await sleep(600)
      const has = await c.eval(`!!document.querySelector('.editor-box')`)
      check('双击卡片打开编辑器', opened === 'ok' && has === true, `${opened} / editor=${has}`)
    }

    /* ---------- 2. 编辑器带出原值 ---------- */
    {
      const vals = await c.eval(`
        (() => {
          const t = document.querySelector('.editor-title');
          const g = document.querySelector('.editor-tag');
          const items = document.querySelectorAll('.editor-item').length;
          return { title: t ? t.value : null, tag: g ? g.value : null, items };
        })()
      `)
      check('编辑器带出原标题', typeof vals.title === 'string' && vals.title.length > 0, vals.title)
      check('编辑器带出原分类', typeof vals.tag === 'string', vals.tag)
      check('编辑器带出原条目', vals.items === 2 || vals.items >= 1, `${vals.items} 条`)
    }

    /* ---------- 3. 改标题 + 改分类 + 改颜色 ---------- */
    {
      await c.eval(setInput('.editor-title', '改过的标题'))
      await c.eval(setInput('.editor-tag', '改过的分类'))
      await sleep(200)

      const swatches = await c.eval(`document.querySelectorAll('.editor-color').length`)
      check('编辑器有配色圆点', swatches >= 6, `count=${swatches}`)

      // 点「陶土」（#b3613a）并保存
      await c.eval(`
        (() => {
          const b = [...document.querySelectorAll('.editor-color')]
            .find(x => (x.getAttribute('title') || '').includes('陶土'));
          if (!b) return false;
          b.click();
          return true;
        })()
      `)
      await sleep(200)

      await c.eval(`(() => { const b = [...document.querySelectorAll('.editor-btn')].find(x => x.textContent.trim() === '保存'); b && b.click(); return 'ok' })()`)
      await sleep(800)

      const local = readData()
      const card = local.cards.find((x) => x.title === '改过的标题')
      check('标题改成功', !!card, card ? card.title : '没找到')
      check('分类改成功', card?.tag === '改过的分类', card?.tag)
      check('颜色改成功', card?.color?.toLowerCase() === '#b3613a', card?.color)
      check('保存后编辑器关闭', await c.eval(`!document.querySelector('.editor-box')`))
      check('改动进了同步队列', local.outbox.length > 0, `outbox=${local.outbox.length}`)
    }

    /* ---------- 4. 加条目 / 删条目 ---------- */
    {
      const cardId = readData().cards.find((x) => x.title === '改过的标题').id
      await c.eval(`(async () => { const m = await import('./store.ts').catch(()=>null); return 'ok' })()`).catch(() => {})

      // 直接双击那张卡打开
      await c.eval(`
        (() => {
          const cards = [...document.querySelectorAll('.card:not(.new)')];
          const target = cards.find(c => (c.querySelector('h3')||{}).textContent === '改过的标题');
          if (!target) return 'no-target';
          target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return 'ok';
        })()
      `)
      await sleep(600)

      const before = await c.eval(`document.querySelectorAll('.editor-item').length`)
      await c.eval(`(() => { const b = [...document.querySelectorAll('.editor-add')][0]; b && b.click(); return 'ok' })()`)
      await sleep(400)
      const after = await c.eval(`document.querySelectorAll('.editor-item').length`)
      check('能加条目', after === before + 1, `${before} → ${after}`)

      // 给新条目填内容
      await c.eval(`
        (() => {
          const inputs = [...document.querySelectorAll('.editor-item-text')];
          const last = inputs[inputs.length - 1];
          const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          setter.call(last, '新加的条目');
          last.dispatchEvent(new Event('input', { bubbles: true }));
          return 'ok';
        })()
      `)
      await sleep(200)

      // 删掉第一个条目
      await c.eval(`(() => { const d = document.querySelector('.editor-item-del'); if (d) d.click(); return 'ok' })()`)
      await sleep(300)

      await c.eval(`(() => { const b = [...document.querySelectorAll('.editor-btn')].find(x => x.textContent.trim() === '保存'); b && b.click(); return 'ok' })()`)
      await sleep(800)

      const card = readData().cards.find((x) => x.id === cardId)
      check('新条目保存进去了', card?.items.some((i) => i.text === '新加的条目'), JSON.stringify(card?.items.map((i) => i.text)))
    }

    /* ---------- 5. 改日期（编辑器里的快选） ---------- */
    {
      const cardId = readData().cards.find((x) => x.title === '改过的标题').id
      const before = readData().cards.find((x) => x.id === cardId).anchorAt

      await c.eval(`
        (() => {
          const cards = [...document.querySelectorAll('.card:not(.new)')];
          const target = cards.find(c => (c.querySelector('h3')||{}).textContent === '改过的标题');
          if (target) target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return 'ok';
        })()
      `)
      await sleep(600)
      await c.eval(`(() => { const chip = [...document.querySelectorAll('.editor-chip')].find(x => x.textContent.trim() === '下周'); chip && chip.click(); return 'ok' })()`)
      await sleep(300)
      await c.eval(`(() => { const b = [...document.querySelectorAll('.editor-btn')].find(x => x.textContent.trim() === '保存'); b && b.click(); return 'ok' })()`)
      await sleep(800)

      const after = readData().cards.find((x) => x.id === cardId).anchorAt
      // 「下周」= 今天 + 7 天，所以要校验绝对日期，不是相对卡片原日期的位移
      // （卡可能原本不在今天，比如在昨天，位移就会是 8 天）
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)
      const expected = todayStart.getTime() + 7 * 86400000
      check(
        '编辑器里能改日期（下周=今天+7）',
        after === expected,
        `实际 ${new Date(after).toDateString()}，期望 ${new Date(expected).toDateString()}（原在 ${new Date(before).toDateString()}）`
      )
    }

    /* ---------- 6. 右键菜单里有「编辑这张卡…」 ---------- */
    {
      const labels = await c.eval(`
        (() => {
          const card = document.querySelector('.card:not(.new)');
          const r = card.getBoundingClientRect();
          card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2,
            clientX: Math.round(r.left + 30), clientY: Math.round(r.top + 16) }));
          return new Promise(res => setTimeout(() => {
            res([...document.querySelectorAll('.ctx-item')].map(b => b.textContent.trim()));
          }, 300));
        })()
      `)
      check('右键菜单有编辑项', labels.includes('编辑这张卡…'), labels.join(' | '))
      await c.eval(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok' })()`)
      await sleep(300)
    }

    /* ---------- 7. 空标题不能保存 ---------- */
    {
      await c.eval(`
        (() => {
          const card = document.querySelector('.card:not(.new)');
          card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return 'ok';
        })()
      `)
      await sleep(500)
      await c.eval(setInput('.editor-title', ''))
      await sleep(300)
      const disabled = await c.eval(`
        (() => {
          const b = [...document.querySelectorAll('.editor-btn')].find(x => x.textContent.trim() === '保存');
          return b ? b.disabled : null;
        })()
      `)
      check('空标题时保存按钮禁用', disabled === true, String(disabled))
      await c.eval(`(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return 'ok' })()`)
      await sleep(300)
      check('Esc 能关编辑器', await c.eval(`!document.querySelector('.editor-box')`))
    }

    /* ---------- 8. 拖拽改期 ---------- */
    {
      const before = readData().cards.filter((c) => c.deletedAt === null)
      const info = await c.eval(`
        (() => {
          const days = [...document.querySelectorAll('.day')];
          const card = document.querySelector('.card:not(.new)');
          if (!days.length || !card) return { ok: false };
          const from = card.closest('.day');
          const fromIdx = days.indexOf(from);
          // 拖到今天之后的第二天（找一个不同的 day）
          const toIdx = fromIdx === 1 ? 0 : 1;
          const target = days[toIdx];
          const dt = new DataTransfer();
          card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }));
          target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
          target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
          card.dispatchEvent(new DragEvent('dragend', { bubbles: true, cancelable: true, dataTransfer: dt }));
          return { ok: true, fromIdx, toIdx, cardId: null, hadPayload: dt.types.length };
        })()
      `)
      await sleep(900)
      check('拖拽事件能触发', info.ok === true, `from day ${info.fromIdx} → day ${info.toIdx}`)

      // 校验：有卡片换了天
      const after = readData().cards.filter((c) => c.deletedAt === null)
      const moved = after.filter((c) => {
        const b = before.find((x) => x.id === c.id)
        return b && b.anchorAt !== c.anchorAt
      })
      check('拖拽真的改了日期', moved.length > 0, `${moved.length} 张换了天`)
      check('拖拽也进了同步队列', readData().outbox.length > 0, `outbox=${readData().outbox.length}`)
    }

    c.close()
  } finally {
    child.kill()
    await sleep(500)
  }

  const pass = results.filter((r) => r[1]).length
  console.log('')
  console.log(`共 ${results.length} 项，通过 ${pass} 项`)
  process.exit(pass === results.length ? 0 : 1)
})().catch((e) => {
  console.error('FAIL', e && e.message)
  process.exit(1)
})
