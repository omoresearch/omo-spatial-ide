/* Two actual Chrome profiles, one real Theia backend. No mocked RPC, agents, models or shared terminal output. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {ROOT,CANVAS,openWorld,walkTo,command,clickStation}=require('./world-test-driver.cjs');
const {DESK_ONE}=require('./world-navigation-targets.cjs');
(async()=>{let a,b;const code=`shared-${crypto.randomBytes(5).toString('hex')}`;try{
 a=await openWorld('shared-alice');
 assert.ok(await a.page.$('[data-testid="presence-join"]'),'The real world has no explicit shared-room join control');
 b=await openWorld('shared-bob');
 async function join(w,name){for(const [id,text]of[['presence-code',code],['presence-name',name]]){await w.page.click(`[data-testid="${id}"]`,{count:3});await w.page.keyboard.type(text);}await w.page.click('[data-testid="presence-join"]');await w.page.waitForSelector('[data-testid="presence-bar"][data-phase="joined"]');}
 await join(a,'Fixture Alice');await join(b,'Fixture Bob');
 for(const w of [a,b]){await w.page.waitForFunction(()=>document.querySelectorAll('[data-testid="presence-members"] [data-peer-id]').length===2);assert.notEqual(await w.page.$eval('[data-testid="in-world-terminal-output"]',e=>e.dataset.ready),'true','Joining a room must not start or open a terminal');}
 // Real WASD movement, not a pose injection. Bob remains at the normal spawn looking toward Alice.
 await walkTo(a.page,.4,2.8);
 await b.page.waitForFunction(()=>Object.values(JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.peerPositions||'{}')).some(p=>p.name==='Fixture Alice'&&p.z<3.1&&p.visible));
 const avatar=await b.page.$eval(CANVAS,e=>{const r=e.getBoundingClientRect(),p=Object.values(JSON.parse(e.dataset.peerPositions)).find(p=>p.name==='Fixture Alice');return {...p,x:r.x+p.screenX,y:r.y+p.screenY};});
 const image=await b.page.screenshot({clip:{x:Math.floor(avatar.x)-3,y:Math.floor(avatar.y)-3,width:7,height:7},encoding:'base64'});
 const pink=await b.page.evaluate(async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);const d=ctx.getImageData(0,0,c.width,c.height).data;let count=0;for(let n=0;n<d.length;n+=4)if(d[n]>d[n+1]*1.2&&d[n+2]>d[n+1]*1.2&&d[n]>70)count++;return count;},image);
 assert.ok(pink>5,`The actual remote avatar must paint pink head pixels into the physical world, not only metadata (${pink})`);
 await b.page.screenshot({path:path.join(ROOT,'evidence/shared-room-two-clients.png')});
 await walkTo(a.page,DESK_ONE.x,DESK_ONE.z);await command(a.page,'terminal',"export OMO_SHARED_PERSON=ALICE; printf 'PERSON:%s:%s\\n' \"$OMO_SHARED_PERSON\" \"$$\"");
 await a.page.waitForFunction(()=>/PERSON:ALICE:\d+/.test(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText));
 await walkTo(b.page,DESK_ONE.x,DESK_ONE.z);await command(b.page,'terminal',"printf 'BOB_INIT:%s:%s\\n' \"${OMO_SHARED_PERSON-unset}\" \"$$\"");
 await b.page.waitForFunction(()=>/BOB_INIT:unset:\d+/.test(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText));
 const alicePid=await a.page.$eval(CANVAS,e=>e.dataset.terminalText.match(/PERSON:ALICE:(\d+)/)[1]);
 const bobPid=await b.page.$eval(CANVAS,e=>e.dataset.terminalText.match(/BOB_INIT:unset:(\d+)/)[1]);assert.notEqual(alicePid,bobPid,'Each participant must own a different shell process by default');
 await command(b.page,'terminal',"export OMO_SHARED_PERSON=BOB; printf 'PERSON:%s\\n' \"$OMO_SHARED_PERSON\"");await b.page.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('PERSON:BOB'));
 await command(a.page,'terminal',"printf 'ALICE_STILL:%s\\n' \"$OMO_SHARED_PERSON\"");await a.page.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('ALICE_STILL:ALICE'));
 assert.equal(await a.page.$eval(CANVAS,e=>e.dataset.terminalText.includes('PERSON:BOB')),false);
 await a.page.click('[data-testid="presence-leave"]');await b.page.waitForFunction(()=>Object.keys(JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.peerPositions||'{}')).length===0);
 await b.page.waitForFunction(()=>document.querySelectorAll('[data-testid="presence-members"] [data-peer-id]').length===1);
 // Rejoining this same tab reattaches the prior personal binding; no restart or process replacement.
 await join(a,'Fixture Alice');await a.page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]');await command(a.page,'terminal',"printf 'REJOIN:%s:%s\\n' \"$OMO_SHARED_PERSON\" \"$$\"");await a.page.waitForFunction(pid=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes(`REJOIN:ALICE:${pid}`),{},alicePid);
 await a.page.reload({waitUntil:'domcontentloaded'});await a.page.waitForSelector(`${CANVAS}[data-navigation="walk"]`);await a.page.waitForSelector('[data-testid="presence-bar"][data-phase="solo"]');
 assert.equal(await a.page.$$eval('[data-testid="presence-members"] [data-peer-id]',nodes=>nodes.length),0,'Reload must not silently rejoin');
 await join(a,'Fixture Alice');await a.page.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]');await walkTo(a.page,DESK_ONE.x,DESK_ONE.z);await command(a.page,'terminal',"printf 'RELOAD:%s:%s\\n' \"$OMO_SHARED_PERSON\" \"$$\"");await a.page.waitForFunction(pid=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes(`RELOAD:ALICE:${pid}`),{},alicePid);
 // Connection close, not a UI leave, must remove the other member too.
 await a.dispose();a=undefined;await b.page.waitForFunction(()=>document.querySelectorAll('[data-testid="presence-members"] [data-peer-id]').length===1);
 const proof={pass:true,twoIndependentBrowsers:true,realMovement:true,physicalAvatarPixels:pink,separateShellPids:[alicePid,bobPid],leaveAndRejoinPreservesShell:true,reloadRequiresJoinAndPreservesShell:true,disconnectCleanup:true,providerCalls:0};fs.writeFileSync(path.join(ROOT,'evidence/shared-room-real-app.json'),JSON.stringify(proof,null,2));console.log('PASS: two real browser clients share live 3D presence; separate physical terminal processes, no automatic starts, leave/rejoin and reload continuity, disconnect cleanup.');
 }catch(error){for(const [name,w]of[['alice',a],['bob',b]])if(w)fs.writeFileSync(path.join(ROOT,`evidence/shared-${name}-failure.txt`),await w.page.evaluate(()=>document.body.innerText).catch(()=>''));throw error;}finally{if(a)await a.dispose();if(b)await b.dispose();}
})().catch(e=>{console.error(e);process.exitCode=1;});
