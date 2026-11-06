const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {launch}=require('puppeteer');
const ROOT=path.resolve(__dirname,'../..');
const E=path.join(ROOT,'evidence');
const project=path.join(ROOT,'demo-project');
const readme=path.join(project,'README.md');const original=fs.readFileSync(readme,'utf8');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const timeline=[];const assertions=[];let zero=0;let encodedFrames=0;
function caption(text){timeline.push({start:encodedFrames/25,wallTime:(Date.now()-zero)/1000,text});console.log(text);}
function check(name,value){assert.ok(value,name);assertions.push({name,pass:true});}
async function chord(page,key){await page.keyboard.down('Control');await page.keyboard.press(key);await page.keyboard.up('Control');}
async function world(page){for(const e of await page.$$('.lm-TabBar-tabLabel,.p-TabBar-tabLabel')){if(await e.evaluate(x=>x.textContent.trim()==='World')){await e.click();await sleep(550);return;}}throw Error('World tab missing');}
async function poll(file,needle){for(let i=0;i<40;i++){if(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(needle))return true;await sleep(200);}return false;}
async function typeCommand(page,text){await page.waitForSelector('#omo-project-terminal .xterm-helper-textarea');await page.focus('#omo-project-terminal .xterm-helper-textarea');await page.keyboard.type(text,{delay:32});await page.keyboard.press('Enter');}
async function cursor(page){await page.evaluate(()=>{const dot=document.createElement('div');dot.id='demo-pointer';Object.assign(dot.style,{position:'fixed',width:'15px',height:'15px',border:'2px solid #dcf5d7',borderRadius:'50%',background:'#d4f1d344',zIndex:100000,pointerEvents:'none',left:'-30px',top:'-30px',boxShadow:'0 0 10px #0006',transform:'translate(-50%,-50%)'});document.body.append(dot);document.addEventListener('mousemove',e=>{dot.style.left=e.clientX+'px';dot.style.top=e.clientY+'px';});});}
(async()=>{fs.mkdirSync(E,{recursive:true});const profile=path.join(E,'demo-browser');fs.rmSync(profile,{force:true,recursive:true});
 const browser=await launch({executablePath:'/opt/google/chrome/chrome',headless:true,userDataDir:profile,args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader'],defaultViewport:{width:1440,height:960}});
 let recorder;
 try{const page=await browser.newPage();await page.goto('http://127.0.0.1:3190',{waitUntil:'domcontentloaded'});await page.waitForSelector('[data-testid="omo-onboarding"]');await sleep(4500);
 await page.evaluate(()=>{if(document.body.innerText.includes('/omo/demo-project'))[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Yes, I trust the authors')?.click();});
 await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]');await sleep(700);await cursor(page);
 let frameTime;page._client().on('Page.screencastFrame', event => { const t=event.metadata.timestamp; if(t!==undefined){if(frameTime!==undefined)encodedFrames+=Math.round(25*Math.max(t-frameTime,0));frameTime=t;} });
 recorder=await page.screencast({path:path.join(E,'omo-room-raw.mp4'),format:'mp4',fps:25,quality:28});zero=Date.now();
 caption('Omo / first usable room — running inside the real Theia IDE');await sleep(3000);
 caption('Choose a world. The room preview changes with you.');await page.click('[data-testid="theme-jungle"]');await sleep(2500);check('Jungle preview renders',await page.$('.omo-scene-wrap[data-theme="jungle"] canvas'));
 await page.click('[data-testid="room-name"]');await chord(page,'a');await page.keyboard.type('Omo Research',{delay:90});await sleep(500);check('Room name survives typing while recording', await page.$eval('[data-testid="room-name"]',el=>el.value==='Omo Research'));await page.click('[data-testid="create-room"]');await sleep(1300);
 check('Room name survives creation',await page.$eval('.omo-stage-heading h2',el=>el.textContent==='Omo Research'));
 check('Room created',!(await page.$('[data-testid="omo-onboarding"]')));caption('Your project now has a persistent place. Drag to look around.');
 const box=await page.$eval('canvas[data-testid="omo-world-canvas"]',e=>{const r=e.getBoundingClientRect();return{x:r.x,y:r.y,w:r.width,h:r.height};});
 await page.mouse.move(box.x+box.w*.45,box.y+box.h*.65);await page.mouse.down();await page.mouse.move(box.x+box.w*.53,box.y+box.h*.65,{steps:30});await page.mouse.up();await sleep(1700);await page.click('[aria-label="Reset room camera"]');await sleep(1000);
 caption('Select a workstation: a real local shell opens in the project folder.');await page.click('[data-workstation="terminal"]');await typeCommand(page,"pwd; printf 'ROOM_TERMINAL_OK' > .omo-demo-proof");
 check('Terminal command reached the actual project',await poll(path.join(project,'.omo-demo-proof'),'ROOM_TERMINAL_OK'));await sleep(3000);
 await world(page);caption('Switch to Code. These are the same project files, not a simulated screen.');await page.click('[data-workstation="code"]');await page.waitForSelector('.monaco-editor [role="textbox"]');await page.focus('.monaco-editor [role="textbox"]');await chord(page,'End');await sleep(1300);
 await page.keyboard.type('\nNext idea: build something worth remembering.\n',{delay:65});await chord(page,'s');check('Editor saved to the real file',await poll(readme,'Next idea: build something worth remembering.'));await sleep(2200);
 await world(page);caption('Read the saved editor change back through the terminal.');await page.click('[data-workstation="terminal"]');await typeCommand(page,'tail -n 2 README.md');await sleep(3000);
 await world(page);caption('Choose another theme; keep the same project.');await page.click('[data-testid="edit-room"]');await page.click('[data-testid="theme-station"]');await sleep(1800);await page.click('[data-testid="create-room"]');await sleep(1700);
 const saved=await page.evaluate(()=>localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('omo.room.v1:'))));check('Room preference saved',JSON.parse(saved).theme==='station');
 caption('Reload the workspace. The chosen room comes back.');await page.reload({waitUntil:'domcontentloaded'});await page.waitForSelector('[data-testid="omo-world"]');await sleep(4000);await cursor(page);
 check('Room restored after reload',!(await page.$('[data-testid="omo-onboarding"]')));check('Theme restored',await page.$('.omo-scene-wrap[data-theme="station"] canvas'));await page.screenshot({path:path.join(E,'demo-final.png')});await sleep(1200);
 caption('Local build · Real terminal + editor · Saved rooms · No agents yet');await sleep(3500);
 const duration=(Date.now()-zero)/1000;await recorder.stop();recorder=undefined;
 fs.writeFileSync(path.join(E,'demo-timeline.json'),JSON.stringify({duration,timeline,assertions,label:'Real local Theia app recording; no mocked routes, agents, or deployment'},null,2));
 function stamp(t){const ms=Math.round(t*1000);return`${String(Math.floor(ms/3600000)).padStart(2,'0')}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')},${String(ms%1000).padStart(3,'0')}`;}
 fs.writeFileSync(path.join(E,'demo.srt'),timeline.map((v,i)=>`${i+1}\n${stamp(v.start)} --> ${stamp((timeline[i+1]?.start??duration)-.03)}\n${v.text}\n`).join('\n'));
 console.log(JSON.stringify({recorded:true,duration,checks:assertions.length}));
 }finally{if(recorder)await recorder.stop();await browser.close();fs.writeFileSync(readme,original);fs.rmSync(path.join(project,'.omo-demo-proof'),{force:true});}
})().catch(e=>{console.error(e);process.exit(1);});
