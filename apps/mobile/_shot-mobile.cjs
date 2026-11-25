const { spawn } = require('child_process')
const fs = require('fs'), path = require('path')
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe','C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].find(p => fs.existsSync(p))
const PORT = 9495
const URL = process.env.MOB_URL || 'http://127.0.0.1:5181/'
const sleep = ms => new Promise(r => setTimeout(r, ms))
async function findTarget(){for(let i=0;i<200;i++){try{const r=await fetch(`http://127.0.0.1:${PORT}/json/list`);if(r.ok){const all=await r.json();const p=all.find(t=>t.type==='page'&&t.url.startsWith('http'));if(p)return p}}catch(e){}await sleep(200)}throw new Error('no target')}
function connect(url){return new Promise((res,rej)=>{const ws=new WebSocket(url);const p=new Map();let id=0
 ws.onopen=()=>res({send:(m,q)=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});ws.send(JSON.stringify({id:i,method:m,params:q}))}),eval:e=>new Promise((a,b)=>{const i=++id;p.set(i,{a,b});ws.send(JSON.stringify({id:i,method:'Runtime.evaluate',params:{expression:e,returnByValue:true,awaitPromise:true}}))}).then(r=>r&&r.result&&r.result.value),close:()=>ws.close()})
 ws.onerror=rej;ws.onmessage=e=>{const m=JSON.parse(e.data);const q=p.get(m.id);if(!q)return;p.delete(m.id);m.error?q.b(new Error(JSON.stringify(m.error))):q.a(m.result)}})}
;(async()=>{
  if (!CHROME) throw new Error('no chrome')
  const udd = fs.mkdtempSync(path.join(process.env.TEMP,'mshot-'))
  const child = spawn(CHROME, ['--headless=new',`--remote-debugging-port=${PORT}`,`--user-data-dir=${udd}`,'--disable-gpu','--hide-scrollbars','--no-first-run','--force-device-scale-factor=2','--window-size=412,915',URL], {stdio:'ignore'})
  try{
    const t = await findTarget()
    const c = await connect(t.webSocketDebuggerUrl)
    await c.send('Page.enable',{})
    await c.send('Emulation.setDeviceMetricsOverride',{width:412,height:915,deviceScaleFactor:2,mobile:true})
    await sleep(1500)
    await c.eval(`document.fonts ? document.fonts.ready.then(()=>'ok') : 'ok'`)
    await sleep(700)

    for (const skin of ['organic','brutal','neo']) {
      await c.eval(`(() => { const b=[...document.querySelectorAll('.sheet-chip')]; return 'ok' })()`)
      // 直接改 dataset（等价于点皮肤按钮，省一步）
      await c.eval(`document.documentElement.dataset.theme='${skin}'; 'ok'`)
      await sleep(500)
      const shot = await c.send('Page.captureScreenshot',{format:'png'})
      fs.writeFileSync(path.join(__dirname,`_mob_${skin}.png`), Buffer.from(shot.data,'base64'))
      console.log(skin, 'ok')
    }
    // 打开设置抽屉截一张
    await c.eval(`document.documentElement.dataset.theme='organic'; 'ok'`)
    await sleep(300)
    await c.eval(`
      (() => {
        const b = document.querySelector('.brand-row');
        if (b) b.click();
        return 'ok';
      })()
    `)
    await sleep(900)
    const shot2 = await c.send('Page.captureScreenshot',{format:'png'})
    fs.writeFileSync(path.join(__dirname,'_mob_settings.png'), Buffer.from(shot2.data,'base64'))
    console.log('settings ok')
    c.close()
  } finally { child.kill(); await sleep(400); try{fs.rmSync(udd,{recursive:true,force:true})}catch(e){} }
  process.exit(0)
})().catch(e=>{console.error('FAIL',e.message);process.exit(1)})
