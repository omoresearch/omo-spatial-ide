/* Actual shell URL -> explicit Manage action -> real managed Chrome wall. Local fixture only. */
const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const{openWorld,walkTo,command,CANVAS}=require('./world-test-driver.cjs');
const{DESK_ONE}=require('./world-navigation-targets.cjs');
(async()=>{
 let hits=0;const server=http.createServer((req,res)=>{if(req.url==='/linked')hits++;res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>OMO TERMINAL LINK FIXTURE</title><body style="background:#1ba9c9;font:30px monospace">REAL PAGE OPENED FROM A TERMINAL LINK</body>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/linked`;let w;
 try{
  w=await openWorld('terminal-link');const p=w.page;await walkTo(p,DESK_ONE.x,DESK_ONE.z);
  await command(p,'terminal',`printf '\\n%s%s\\n' 'http' '://127.0.0.1:${server.address().port}/linked'`);
  await p.waitForFunction(url=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.split('\n').some(line=>line.trim()===url),{},url);
  await p.keyboard.press('Escape');await p.click('[data-testid="runtime-manage-toggle"]');
  await p.waitForSelector(`[data-testid="terminal-link"][data-destination="${url}"]`,{timeout:10000});
  assert.equal(hits,0,'Rendering a URL or its control must not fetch the destination');
  const pages=(await w.browser.pages()).length;await p.click(`[data-testid="terminal-link"][data-destination="${url}"]`);
  await p.waitForSelector('[data-testid="web-controls"][data-phase="live"]',{timeout:30000});
  await p.waitForFunction(()=>document.querySelector('[data-testid="web-status"]')?.textContent==='OMO TERMINAL LINK FIXTURE');
  await p.waitForFunction(()=>Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.webFrameSequence)>0);
  assert.equal(hits,1);assert.equal((await w.browser.pages()).length,pages,'The IDE tab must not open an external page');
  assert.equal(await p.$eval('[data-testid="web-address"]',e=>e.value),url);
  await p.click('[data-testid="web-close"]');
  fs.writeFileSync(path.resolve(__dirname,'../../evidence/terminal-link-real-app.json'),JSON.stringify({pass:true,checks:['real shell prints link','no fetch until actual explicit click','real Chrome page appears on web wall','outer IDE browser does not navigate or gain a tab'],fixtureOnly:true,modelCalls:0},null,2));
  console.log('PASS: Real terminal link opens real web wall only on explicit click');
 }finally{if(w)await w.dispose();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
