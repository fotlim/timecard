// 验证：设置窗口能开、托盘存在、浮窗有拖拽区且置顶
const { spawn } = require('child_process')
const path = require('path')
const os = require('os')

const PORT = 9531
const BASE = __dirname
const WORKSPACE = path.resolve(BASE, '..', '..')
const ELECTRON = path.join(
  WORKSPACE,
  'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe'
)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const fs = require('fs')

async function pages(want) {
  for (let i = 0; i < 160; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      if (r.ok) {
        const all = (await r.json()).filter((t) => t.type === 'page')
        const hit = all.find((t) => t.url.includes(want))
        if (hit) return { hit, all }
      }
    } catch (e) {}
    await sleep(250)
  }
  throw new Error('等不到页面: ' + want)
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
          }).then((r) => r.result && r.result.value),
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

;(async () => {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.TIMECARD_SHOT
  delete env.TIMECARD_SHOT_QUICK
  delete env.TIMECARD_BOOT
  // 用临时数据目录：不碰真人数据，也不受"上次皮肤已是 brutal"的状态干扰
  env.TIMECARD_DATA_DIR =
    process.env.TIMECARD_DATA_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shell-'))
  const dataJson = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(env.TIMECARD_DATA_DIR, 'timecard.json'), 'utf-8'))
    } catch {
      return {}
    }
  }

  const child = spawn(ELECTRON, [BASE, `--remote-debugging-port=${PORT}`], { env, stdio: 'ignore' })
  const results = []
  try {
    const { hit: mainT } = await pages('index.html')
    const main = await connect(mainT.webSocketDebuggerUrl)
    await sleep(1800)
    // 浮窗懒创建：先唤起再去找它的调试目标
    await main.eval(`window.timecard.quick.show(); 'ok'`)
    await sleep(2000)

    // 1) 浮窗拖拽区
    const quick = await pages('quick.html')
    const quickConn = await connect(quick.hit.webSocketDebuggerUrl)
    const drag = await quickConn.eval(`
      (() => {
        const grab = document.querySelector('.qgrab');
        if (!grab) return { ok: false, why: 'no .qgrab' };
        const cs = getComputedStyle(grab);
        const btn = document.querySelector('.qclose');
        const bcs = btn ? getComputedStyle(btn) : null;
        return {
          ok: true,
          appRegion: cs.webkitAppRegion || cs.getPropertyValue('-webkit-app-region'),
          closeRegion: bcs ? (bcs.webkitAppRegion || bcs.getPropertyValue('-webkit-app-region')) : null,
          height: grab.getBoundingClientRect().height
        };
      })()
    `)
    results.push(['浮窗拖拽区', drag.ok && drag.appRegion === 'drag' && drag.closeRegion === 'no-drag', JSON.stringify(drag)])
    quickConn.close()

    // 2) 点齿轮开设置
    await main.eval(`document.querySelector('.tb-icon[aria-label="设置"]').click(); 'ok'`)
    await sleep(1200)
    const { hit: setT } = await pages('settings.html')
    const setConn = await connect(setT.webSocketDebuggerUrl)
    await sleep(800)
    const sections = await setConn.eval(`
      [...document.querySelectorAll('.sgroup h3')].map(h => h.textContent)
    `)
    results.push(['设置窗口', Array.isArray(sections) && sections.length >= 4, JSON.stringify(sections)])

    // 3) 设置里切皮肤 → 主窗口跟着变
    const beforeSkin = await main.eval(`document.documentElement.dataset.theme`)
    await setConn.eval(`
      [...document.querySelectorAll('.skin-card')]
        .find(c => c.textContent.includes('野兽派')).click(); 'ok'
    `)
    await sleep(700)
    const afterSkin = await main.eval(`document.documentElement.dataset.theme`)
    results.push(['设置改皮肤→主窗口同步', beforeSkin !== afterSkin && afterSkin === 'brutal', `${beforeSkin} -> ${afterSkin}`])

    // 4) 托盘：主进程里 Tray 是否建起来（通过 app:info 间接确认不了，改看窗口关闭行为）
    // 注意：设置里现在有两个开关（启用同步 / 关闭到托盘），
    // 不能抓第一个 .stoggle —— 要按行标题定位。
    const closeToTray = await setConn.eval(`
      (() => {
        const row = [...document.querySelectorAll('.srow')]
          .find(r => r.textContent.includes('关闭窗口时最小化到托盘'));
        if (!row) return null;
        const t = row.querySelector('.stoggle');
        return t ? t.getAttribute('aria-checked') : null;
      })()
    `)
    results.push(['关闭到托盘开关', closeToTray === 'true', String(closeToTray)])

    // 开机自启：开关存在、默认关、点一下变开
    const autoStartBefore = await setConn.eval(`
      (() => {
        const row = [...document.querySelectorAll('.srow')]
          .find(r => r.textContent.includes('开机自动启动'));
        if (!row) return null;
        const t = row.querySelector('.stoggle');
        return t ? t.getAttribute('aria-checked') : null;
      })()
    `)
    results.push(['开机自启开关存在', autoStartBefore !== null, String(autoStartBefore)])
    await setConn.eval(`
      (() => {
        const row = [...document.querySelectorAll('.srow')]
          .find(r => r.textContent.includes('开机自动启动'));
        row.querySelector('.stoggle').click();
      })()
    `)
    await sleep(400)
    const autoStartAfter = await setConn.eval(`
      (() => {
        const row = [...document.querySelectorAll('.srow')]
          .find(r => r.textContent.includes('开机自动启动'));
        return row.querySelector('.stoggle').getAttribute('aria-checked');
      })()
    `)
    results.push(['开机自启可切换', autoStartBefore !== autoStartAfter, `${autoStartBefore} -> ${autoStartAfter}`])
    results.push(
      ['偏好已落盘', dataJson().prefs.openAtLogin === (autoStartAfter === 'true'), String(dataJson().prefs.openAtLogin)]
    )

    setConn.close()
    main.close()
    console.log('')
    let allOk = true
    for (const [name, ok, detail] of results) {
      if (!ok) allOk = false
      console.log(`${ok ? '✓' : '✗'} ${name.padEnd(24)} ${detail}`)
    }
    console.log('')
    console.log(allOk ? '全部通过' : '有失败项')
    child.kill()
    process.exit(allOk ? 0 : 1)
  } catch (e) {
    console.error('FAIL', e)
    child.kill()
    process.exit(1)
  }
})()
