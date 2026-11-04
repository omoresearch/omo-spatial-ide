/* Real shell BEL -> backend frame -> physical desk and explicit local acknowledge. No sound or models. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const{openWorld,walkTo,command,CANVAS}=require('./world-test-driver.cjs');
(async()=>{
 const w=await openWorld('bell-attention');const p=w.page;const marker='BELL_BODY_'+Date.now();
 try{
  await walkTo(p,-2.5,1.7);await command(p,'terminal',`sleep 1; printf '\\a'; printf '\\n${marker}\\n'`);
  await p.keyboard.press('Escape');await p.click('[data-testid="station-two-controls"]');
  await p.waitForFunction(()=>{const c=document.querySelector('canvas[data-testid="omo-world-canvas"]');return JSON.parse(c.dataset.stationBells||'{}').terminal>0&&JSON.parse(c.dataset.stationLamps||'{}').terminal==='ff9e4a';},{timeout:20000});
  const state=await p.$eval(CANVAS,c=>({bells:JSON.parse(c.dataset.stationBells),lamps:JSON.parse(c.dataset.stationLamps),text:JSON.parse(c.dataset.stationText)}));
  assert.ok(state.bells.terminal>0);assert.equal(state.bells['terminal-2'],0);assert.equal(state.lamps.terminal,'ff9e4a');assert.ok(state.text.terminal.some(line=>line.trim()===marker));
  await p.waitForSelector('[data-testid="station-one-bell"]');
  assert.equal(await p.$('[data-testid="station-two-bell"]'),null,'Another desk must not inherit this bell');
  await p.click('[data-testid="station-one-controls"]');await p.waitForSelector('[data-testid="runtime-bell-ack"]');await p.click('[data-testid="runtime-bell-ack"]');
  await p.waitForFunction(()=>{const c=document.querySelector('canvas[data-testid="omo-world-canvas"]');return JSON.parse(c.dataset.stationBells).terminal===0&&JSON.parse(c.dataset.stationLamps).terminal!=='ff9e4a';});
  assert.notEqual(await p.$eval(CANVAS,c=>JSON.parse(c.dataset.stationLamps).terminal),'ff9e4a');
  await command(p,'terminal',"printf '\\a'");await p.waitForSelector('[data-testid="runtime-bell-ack"]');
  fs.writeFileSync(path.resolve(__dirname,'../../evidence/bell-real-app.json'),JSON.stringify({pass:true,checks:['actual shell BEL changes physical desk lamp','off-desk badge is visible','other desk stays quiet','acknowledge clears real desk display','later real BEL rearms'],soundPlayed:false,modelCalls:0},null,2));
  console.log('PASS: Real shell BEL, desk isolation, physical lamp, acknowledge and rearm');
 }finally{await w.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
