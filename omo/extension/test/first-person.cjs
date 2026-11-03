const {launch}=require('puppeteer');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
const ROOT=path.resolve(__dirname,'../..');const E=path.join(ROOT,'evidence');const project=path.join(ROOT,'demo-project');const pause=ms=>new Promise(r=>setTimeout(r,ms));const checks=[];const timeline=[];let frames=0;
function check(name,value){assert.ok(value,name);checks.push({name,pass:true});console.log('PASS:',name);}
function caption(text){timeline.push({start:frames/25,text});console.log('SCENE:',text);}
(async()=>{const profile=path.join(E,process.env.OMO_RECORD?'firstperson-demo-browser':'walk-browser');fs.rmSync(profile,{recursive:true,force:true});const b=await launch({executablePath:'/opt/google/chrome/chrome',headless:true,userDataDir:profile,args:['--no-sandbox','--enable-unsafe-swiftshader','--disable-dev-shm-usage'],defaultViewport:{width:1440,height:960}});let p,recorder;
try{p=await b.newPage();p.on('pageerror',e=>console.error('PAGE ERROR',e.message));await p.goto(process.env.OMO_URL||'http://127.0.0.1:3190',{waitUntil:'domcontentloaded'});await p.waitForSelector('[data-testid="omo-onboarding"]');await pause(4500);await p.evaluate(()=>{if(document.body.innerText.includes('/omo/demo-project'))[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Yes, I trust the authors')?.click();});
await p.click('[data-testid="create-room"]');await pause(800);
const canvas='canvas[data-testid="omo-world-canvas"]';const initial=await p.$eval(canvas,e=>({mode:e.dataset.navigation,y:e.dataset.eyeY,x:Number(e.dataset.playerX),z:Number(e.dataset.playerZ)}));
check('Room opens at first-person eye level, not as an orbiting diorama',initial.mode==='walk'&&initial.y==='1.75');
await p.screenshot({path:path.join(E,'walk-01-entry.png')});
if(process.env.OMO_RECORD){let previous;p._client().on('Page.screencastFrame',e=>{const t=e.metadata.timestamp;if(t!==undefined){if(previous!==undefined)frames+=Math.round(25*Math.max(t-previous,0));previous=t;}});recorder=await p.screencast({path:path.join(E,'firstperson-raw.mp4'),format:'mp4',fps:25,quality:28});caption('First person inside the room — not an orbiting preview.');await pause(2500);}
caption('Walk over to the workstation with WASD.');
await p.focus(canvas);await p.keyboard.down('a');await p.waitForFunction(()=>Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerX)<-2.45,{timeout:15000});await p.keyboard.up('a');
await p.keyboard.down('w');await p.waitForFunction(()=>Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerZ)<1.72,{timeout:15000});await p.keyboard.up('w');
const approached=await p.$eval(canvas,e=>({x:Number(e.dataset.playerX),z:Number(e.dataset.playerZ)}));check('WASD actually moves the player through the room',approached.x<initial.x-2&&approached.z<initial.z-2);
const target=await p.$eval(canvas,e=>{const r=e.getBoundingClientRect();return{x:r.x+Number(e.dataset.terminalX),y:r.y+Number(e.dataset.terminalY),rect:r.toJSON()};});
check('Physical monitor is visible from the walked-to position',target.x>target.rect.left&&target.x<target.rect.right&&target.y>target.rect.top&&target.y<target.rect.bottom);
await p.screenshot({path:path.join(E,'walk-02-approach.png')});if(process.env.OMO_RECORD)await pause(1800);
caption('Click the physical monitor. Type directly into its live terminal.');
await p.mouse.click(target.x,target.y);
await p.waitForSelector('[data-testid="in-world-terminal-output"][data-ready="true"]',{timeout:15000});
check('Clicking the physical screen focuses in-world keyboard input',await p.$eval(canvas,e=>e.dataset.typing==='true'));
const terminalRect=await p.$eval('#omo-in-world-terminal',e=>e.getBoundingClientRect().toJSON());
check('No flat terminal panel is opened',terminalRect.right<0);
await p.keyboard.type("printf '\\nIN_WORLD_TERMINAL_OK\\n'; pwd; printf 'WALK_SCREEN_PROOF' > .omo-in-world-proof",{delay:process.env.OMO_RECORD?32:0});await p.keyboard.press('Enter');
for(let i=0;i<50&&!fs.existsSync(path.join(project,'.omo-in-world-proof'));i++)await pause(150);
check('Typing through the 3D screen executes in the actual project shell',fs.existsSync(path.join(project,'.omo-in-world-proof'))&&fs.readFileSync(path.join(project,'.omo-in-world-proof'),'utf8')==='WALK_SCREEN_PROOF');
await p.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('IN_WORLD_TERMINAL_OK'),{timeout:15000});
check('Live output reaches the physical monitor texture',await p.$eval(canvas,e=>e.dataset.terminalText.includes('IN_WORLD_TERMINAL_OK')));
check('Terminal wraps to the monitor column width',await p.$eval(canvas,e=>e.dataset.terminalText.split('\n').every(line=>line.length<=80)));
await pause(process.env.OMO_RECORD?3500:600);await p.screenshot({path:path.join(E,'walk-03-live-terminal.png')});
caption('Leave the screen with Esc. The shell keeps running while you walk away.');
await p.keyboard.type("sleep 4; printf '\\nSTILL_RUNNING_IN_WORLD\\n'",{delay:process.env.OMO_RECORD?30:0});await p.keyboard.press('Enter');await p.keyboard.press('Escape');
await p.keyboard.down('s');await p.waitForFunction(()=>Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerZ)>3.6,{timeout:15000});await p.keyboard.up('s');
check('Esc releases terminal focus and walking resumes',await p.$eval(canvas,e=>e.dataset.typing==='false'&&Number(e.dataset.playerZ)>3.6));
await p.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('STILL_RUNNING_IN_WORLD'),{timeout:10000});
check('Real shell output continues after walking away',await p.$eval(canvas,e=>e.dataset.terminalText.includes('STILL_RUNNING_IN_WORLD')));
await p.screenshot({path:path.join(E,'walk-away.png')});if(process.env.OMO_RECORD)await pause(2000);
caption('Walk back. The terminal is still there on the same monitor.');
await p.keyboard.down('w');await p.waitForFunction(()=>Number(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.playerZ)<1.72,{timeout:15000});await p.keyboard.up('w');await pause(700);
check('Returning to the desk reuses the same terminal',(await p.$$('#omo-in-world-terminal')).length===1);
await p.screenshot({path:path.join(E,'walk-04-returned.png')});
await p.keyboard.down('d');await pause(300);await p.keyboard.up('d');for(let i=0;i<4;i++)await p.keyboard.press('ArrowLeft');await pause(500);
await p.screenshot({path:path.join(E,'walk-05-perspective.png')});
if(process.env.OMO_RECORD){await pause(2500);caption('Real local Theia build · First person + in-world terminal · No agents yet');await pause(3000);await recorder.stop();recorder=undefined;}
fs.writeFileSync(path.join(E,'firstperson-verdict.json'),JSON.stringify({verdict:'PASS',label:'Real local Theia app: first-person movement and real PTY rendered on a physical screen',checks,timeline},null,2));console.log('FINAL PASS:',checks.length,'first-person checks');
}catch(error){if(p){await p.screenshot({path:path.join(E,'firstperson-failure.png')}).catch(()=>{});fs.writeFileSync(path.join(E,'firstperson-failure.txt'),await p.evaluate(()=>document.body.innerText).catch(()=>String(error)));}throw error;}
finally{if(recorder)await recorder.stop();await b.close();fs.rmSync(path.join(project,'.omo-in-world-proof'),{force:true});}})().catch(e=>{console.error(e);process.exit(1)});
