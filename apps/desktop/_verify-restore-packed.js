// 几何恢复：改大小 → 退出 → 重启 → 应该还原
const { spawn } = require('child_process')
const fs = require('fs'), path = require('path')
const PORT = 9691
const BASE = __dirname
const ELECTRON = path.join(BASE, 'release', 'win-unpacked', '挂卡时间轴.exe')
const DATA = path.join(process.env.APPDATA, 'Timecard', 'timecard.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function findPage(w) {
  for (let i=0;i<200;i++){ try{ const r=await fetch(`http://127.0.0.1:${PORT}/json/list`); if(r.ok){ const all=(await r.json()).filter(t=>t.type==='page'); const h=all.find(t=>t.url.includes(w)); if(h) return h } }catch(e){} await sleep(250) }
  throw new Error('no page')
}
function connect(url){return new Promise((res,rej)=>{const ws=new WebSocket(url);const p=new Map();let id=0
 ws.onopen=()=>res({eval:e=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true}}))}).then(r=>r&&r.result&&r.result.value),close:()=>ws.close()})
 ws.onerror=rej; ws.onmessage=e=>{const m=JSON.parse(e.data);const q=p.get(m.id);if(!q)return;p.delete(m.id);m.error?q.b(new Error(JSON.stringify(m.error))):q.a(m.result)}})}
function env(){ const e={...process.env}; delete e.ELECTRON_RUN_AS_NODE; delete e.TIMECARD_BOOT
  delete e.TIMECARD_SHOT; delete e.TIMECARD_SHOT_QUICK; delete e.TIMECARD_SHOT_SETTINGS; return e }
;(async () => {
  try { fs.unlinkSync(DATA) } catch (e) {}
  const rows = []
  // 第一次：改成 640x820
  let child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`], { env: env(), stdio: 'ignore' })
  try {
    const t = await findPage('index.html'); const c = await connect(t.webSocketDebuggerUrl); await sleep(4500)
    await c.eval(`window.resizeTo(640, 820); 'ok'`)
    await sleep(1500)
    c.close()
  } finally { child.kill(); await sleep(2000) }
  const saved = JSON.parse(fs.readFileSync(DATA,'utf-8')).windowState
  rows.push(['保存了 640x820', saved && saved.width >= 630 && saved.width <= 660, JSON.stringify(saved)])

  // 第二次：重启，读实际窗口大小
  child = spawn(ELECTRON, [`--remote-debugging-port=${PORT}`], { env: env(), stdio: 'ignore' })
  try {
    const t = await findPage('index.html'); const c = await connect(t.webSocketDebuggerUrl); await sleep(4500)
    const b = await c.eval(`({ w: window.outerWidth, h: window.outerHeight, iw: window.innerWidth })`)
    rows.push(['重启后恢复大小', Math.abs(b.w - saved.width) <= 20, JSON.stringify(b)])
    c.close()
  } finally { child.kill(); await sleep(800) }

  console.log('')
  let ok = true
  for (const [n,p,d] of rows) { if(!p) ok=false; console.log(`${p?'✓':'✗'} ${n.padEnd(18)} ${d}`) }
  console.log(ok ? '几何恢复 OK' : '几何恢复有问题')
  process.exit(ok?0:1)
})()
