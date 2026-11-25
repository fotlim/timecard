const { spawn } = require('child_process')
const fs = require('fs'), path = require('path')
const PORT = 9901
const BASE = __dirname
const ELECTRON = path.join(BASE, '..', '..', 'node_modules/.pnpm/electron@45.4.1/node_modules/electron/dist/electron.exe')
const DATA = path.join(process.env.APPDATA, 'Timecard', 'timecard.json')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function findPage(w){for(let i=0;i<240;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);if(r.ok){const all=(await r.json()).filter(t=>t.type==='page');const h=all.find(t=>t.url.includes(w));if(h)return h}}catch(e){}await sleep(250)}throw new Error('no page')}
function connect(url){return new Promise((res,rej)=>{const ws=new WebSocket(url);const p=new Map();let id=0
 ws.onopen=()=>res({send:(m,q)=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});ws.send(JSON.stringify({id:i,method:m,params:q}))}),eval:e=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true}}))}).then(r=>r&&r.result&&r.result.value),close:()=>ws.close()})
 ws.onerror=rej;ws.onmessage=e=>{const m=JSON.parse(e.data);const q=p.get(m.id);if(!q)return;p.delete(m.id);m.error?q.b(new Error(JSON.stringify(m.error))):q.a(m.result)}})}
;(async()=>{
  try { fs.unlinkSync(DATA) } catch(e){}
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.TIMECARD_SHOT; delete env.TIMECARD_SHOT_QUICK; delete env.TIMECARD_SHOT_SETTINGS; delete env.TIMECARD_WIDE
  for (const skin of ['organic','brutal','neo']) {
    env.TIMECARD_BOOT = `week/${skin}`
    const child=spawn(ELECTRON,[BASE,`--remote-debugging-port=${PORT}`],{env,stdio:'ignore'})
    try{
      const t=await findPage('index.html'); const c=await connect(t.webSocketDebuggerUrl); await sleep(3000)
      // 打开编辑器
      await c.eval(`
        (() => {
          const card = document.querySelector('.card:not(.new)');
          card.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
          return 'ok';
        })()
      `)
      await sleep(700)
      const shot = await c.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`_editor_${skin}.png`, Buffer.from(shot.data,'base64'))
      c.close()
    } finally { child.kill(); await sleep(700) }
  }
  process.exit(0)
})()
