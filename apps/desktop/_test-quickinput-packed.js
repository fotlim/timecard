const { spawn } = require('child_process')
const path = require('path')
const PORT = 9711
const BASE = __dirname
const ELECTRON = path.join(BASE, 'release', 'win-unpacked', '挂卡时间轴.exe')
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function findPage(w){for(let i=0;i<200;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);if(r.ok){const all=(await r.json()).filter(t=>t.type==='page');const h=all.find(t=>t.url.includes(w));if(h)return h}}catch(e){}await sleep(250)}throw new Error('no page')}
function connect(url){return new Promise((res,rej)=>{const ws=new WebSocket(url);const p=new Map();let id=0
 ws.onopen=()=>res({eval:e=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true}}))}).then(r=>r&&r.result&&r.result.value),close:()=>ws.close()})
 ws.onerror=rej;ws.onmessage=e=>{const m=JSON.parse(e.data);const q=p.get(m.id);if(!q)return;p.delete(m.id);m.error?q.b(new Error(JSON.stringify(m.error))):q.a(m.result)}})}
;(async()=>{
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE; delete env.TIMECARD_BOOT
  delete env.TIMECARD_SHOT; delete env.TIMECARD_SHOT_QUICK; delete env.TIMECARD_SHOT_SETTINGS
  const child=spawn(ELECTRON,[BASE,`--remote-debugging-port=${PORT}`],{env,stdio:'ignore'})
  try{
    const mt=await findPage('index.html'); const m=await connect(mt.webSocketDebuggerUrl); await sleep(5000)
    await m.eval(`window.timecard.quick.show(); 'ok'`); await sleep(5000)
    const qt=await findPage('quick.html'); const q=await connect(qt.webSocketDebuggerUrl); await sleep(800)

    for (const skin of ['organic','neo']) {
      await m.eval(`window.timecard.store.setSkin('${skin}')`); await sleep(700)
      const info = await q.eval(`
        (() => {
          const f = document.querySelector('.qinput-field');
          const go = document.querySelector('.qinput-go');
          const cs = f ? getComputedStyle(f) : null;
          return {
            skin: document.documentElement.dataset.theme,
            value: f ? f.value : null,
            placeholder: f ? f.placeholder : null,
            hasGo: !!go,
            color: cs && cs.color,
            caretColor: cs && cs.caretColor,
            fontSize: cs && cs.fontSize,
            fieldW: f ? Math.round(f.getBoundingClientRect().width) : null
          };
        })()
      `)
      console.log(skin, JSON.stringify(info))
    }
    // 输入测试：打字 + 回车
    await m.eval(`window.timecard.store.setSkin('organic')`); await sleep(500)
    const before = await m.eval(`
      (async () => { const s = await window.timecard.store.snapshot();
        return s.cards.filter(c => c.deletedAt === null).length })()
    `)
    await q.eval(`
      (() => {
        const f = document.querySelector('.qinput-field');
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(f, '浮窗里挂的卡');
        f.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      })()
    `)
    await sleep(500)
    const afterType = await q.eval(`({ hasGo: !!document.querySelector('.qinput-go'), value: document.querySelector('.qinput-field').value })`)
    await q.eval(`
      (() => {
        const f = document.querySelector('.qinput-field');
        f.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'ok';
      })()
    `)
    await sleep(800)
    const created = await m.eval(`
      (async () => { const s = await window.timecard.store.snapshot();
        return { n: s.cards.filter(c => c.deletedAt === null).length,
                 has: s.cards.some(c => c.title === '浮窗里挂的卡') } })()
    `)
    const afterSubmit = await q.eval(`({ value: document.querySelector('.qinput-field').value, hasGo: !!document.querySelector('.qinput-go') })`)
    console.log('')
    console.log('输入前卡片数', before)
    console.log('打字后', JSON.stringify(afterType))
    console.log('回车后', JSON.stringify(created))
    console.log('提交后输入框', JSON.stringify(afterSubmit))
    m.close(); q.close()
  } finally { child.kill(); await sleep(500) }
  process.exit(0)
})()
