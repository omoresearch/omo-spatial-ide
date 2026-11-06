/* Actual in-world web UI against a local fixture. No external site or provider call. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openWorld, walkTo, pause, CANVAS } = require('./world-test-driver.cjs');
(async () => {
 let clicks = 0;
 const server = http.createServer((req, res) => {
   if (req.url === '/clicked') { clicks++; res.end('ok'); return; }
   res.setHeader('Content-Type', 'text/html');
   res.end(`<!doctype html><title>OMO LOCAL WEB FIXTURE</title><style>body{margin:0;background:#135ce0;color:white;font:30px monospace}button{position:absolute;left:360px;top:240px;width:240px;height:120px;font:24px monospace}input{position:absolute;left:100px;top:80px;width:700px;height:50px;font:30px monospace}</style><input aria-label="Local fixture input"><button onclick="document.body.style.background='#20cf40';fetch('/clicked');this.textContent='CLICKED'">Real page button</button>`);
 });
 await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
 const url = `http://127.0.0.1:${server.address().port}/`;
 let world;
 try {
   world = await openWorld('web-wall'); const p = world.page;
   await p.click('[data-testid="station-web-controls"]'); await p.waitForSelector('[data-testid="web-address"]');
   await p.type('[data-testid="web-address"]', url); await p.click('[data-testid="web-open"]');
   await p.waitForSelector('[data-testid="web-controls"][data-phase="live"]', { timeout: 30000 });
   await walkTo(p, 0, -1.5);
   await p.waitForFunction(() => Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.webFrameSequence) > 0, { timeout: 20000 });
   await pause(300);
   async function wallPixel() {
     const pt = await p.$eval(CANVAS, e => { const r=e.getBoundingClientRect(),q=JSON.parse(e.dataset.webQuad); return {x:Math.floor(r.x+q[0].x+(q[1].x-q[0].x)*.12+(q[3].x-q[0].x)*.65),y:Math.floor(r.y+q[0].y+(q[1].y-q[0].y)*.12+(q[3].y-q[0].y)*.65)}; });
     const data = await p.screenshot({clip:{...pt,width:1,height:1},encoding:'base64'});
     return p.evaluate(async data=>{ const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(0,0,1,1).data].slice(0,3); },data);
   }
   const blue=await wallPixel(); assert.ok(blue[2]>blue[0]+40 && blue[2]>blue[1]+40, `The actual rendered wall must show the fixture's blue pixels, not only metadata: ${blue}`);
   // Project the real screen quad, then click its physical centre. The fixture's button is at that UV.
   const target = await p.$eval(CANVAS, e => { const r = e.getBoundingClientRect(), q = JSON.parse(e.dataset.webQuad); return { x: r.x + q.reduce((n,v)=>n+v.x,0)/4, y: r.y + q.reduce((n,v)=>n+v.y,0)/4 }; });
   await p.mouse.click(target.x, target.y);
   for (let i=0;i<150 && clicks===0;i++) await pause(100);
   assert.equal(clicks, 1, 'A physical-world click must reach the real page and its local HTTP action exactly once');
   let green; for(let i=0;i<60;i++){green=await wallPixel();if(green[1]>green[0]+40&&green[1]>green[2]+40)break;await pause(100);}
   assert.ok(green[1]>green[0]+40&&green[1]>green[2]+40, `A real page update must repaint the physical wall green: ${green}`);
   await p.keyboard.press('Escape');
   await p.click('[data-testid="web-close"]');
   await p.waitForFunction(() => !document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.webFrameSequence);
   await p.reload({ waitUntil: 'domcontentloaded' });
   await p.waitForSelector('[data-testid="omo-world"][data-configured="true"]', { timeout: 25000 });
   await p.waitForSelector('[data-testid="omo-scene"][data-ready="true"]', {timeout:25000});
   for(let attempt=0;attempt<3;attempt++){await p.click('[data-testid="station-web-controls"]');try{await p.waitForSelector('[data-testid="web-address"]',{timeout:5000});break;}catch(error){if(attempt===2)throw error;}}
   assert.equal(await p.$eval('[data-testid="web-address"]', e => e.value), url, 'Project-scoped URL binding survives refresh without silently opening a browser');
   fs.writeFileSync(path.resolve(__dirname, '../../evidence/web-wall-real-app.json'), JSON.stringify({ pass:true, checks:['actual Chrome page on wall','physical click reaches actual local HTTP fixture','close clears old frame','saved URL survives reload without auto-opening'], fixture:'localhost-only', providerCalls:0 }, null, 2));
   console.log('PASS: Actual Chrome page, physical web click, frame clearing and URL persistence');
 } finally { if (world) await world.dispose(); await new Promise(resolve => server.close(resolve)); }
})().catch(error=>{console.error(error);process.exitCode=1;});
