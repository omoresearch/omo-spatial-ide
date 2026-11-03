const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { launch } = require('puppeteer');
const ROOT = path.resolve(__dirname, '../..');
const evidence = path.join(ROOT, 'evidence');
const project = path.join(ROOT, 'demo-project');
const profile = path.join(evidence, process.env.OMO_PROFILE || 'test-browser');
const readme = path.join(project, 'README.md');
const original = fs.readFileSync(readme, 'utf8');
const checks = [];
function check(name, value, details) { assert.ok(value, name); checks.push({ name, pass: true, details }); console.log('PASS:', name); }
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const config = { executablePath:'/opt/google/chrome/chrome', headless:true, userDataDir: profile,
 args:['--no-sandbox','--disable-dev-shm-usage','--enable-unsafe-swiftshader'], defaultViewport:{width:1440,height:960} };
async function open(browser) {
 const page = await browser.newPage();
 page.on('pageerror',e=>console.error('PAGE ERROR:',e.message));
 await page.goto(process.env.OMO_URL || 'http://127.0.0.1:3190',{waitUntil:'domcontentloaded',timeout:60000});
 await page.waitForSelector('[data-testid="omo-world"]',{timeout:60000});
 await delay(4500);
 await page.evaluate(() => {
  if (document.body.innerText.includes('/omo/demo-project') && document.body.innerText.includes('Do you trust the authors')) {
   const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='Yes, I trust the authors'); if(button)button.click();
  }
 });
 await delay(600);
 return page;
}
async function world(page) {
 const tabs=await page.$$('.lm-TabBar-tabLabel, .p-TabBar-tabLabel');
 for(const tab of tabs) if(await tab.evaluate(el=>el.textContent.trim()==='World')) {await tab.click();await delay(500);return;}
 throw new Error('World tab missing from the real Theia shell');
}
async function pollFile(file, expected) {
 for(let i=0;i<50;i++){if(fs.existsSync(file)&&fs.readFileSync(file,'utf8').includes(expected))return true;await delay(200);}return false;
}
async function chord(page, key) { await page.keyboard.down('Control'); await page.keyboard.press(key); await page.keyboard.up('Control'); }
async function command(page,text) {
 try { await page.waitForSelector('#omo-project-terminal .xterm-helper-textarea',{timeout:12000}); }
 catch { assert.fail('Terminal workstation did not open the real project terminal'); }
 await page.focus('#omo-project-terminal .xterm-helper-textarea');
 await page.keyboard.type(text,{delay:12});await page.keyboard.press('Enter');
}
(async()=>{
 fs.mkdirSync(evidence,{recursive:true});
 if(!process.env.OMO_KEEP_PROFILE)fs.rmSync(profile,{recursive:true,force:true});
 let browser;
 try {
  browser=await launch(config);let page=await open(browser);
  check('Real Theia route exposes onboarding',await page.$('[data-testid="omo-onboarding"]'));
  await page.waitForSelector('[data-testid="omo-scene"][data-ready="true"]',{timeout:20000});
  check('Real WebGL room renders',await page.$('canvas[data-testid="omo-world-canvas"]'));
  await page.screenshot({path:path.join(evidence,'01-station.png')});
  await page.click('[data-testid="theme-jungle"]');await delay(1100);
  check('Theme selection changes the live world',await page.$('.omo-scene-wrap[data-theme="jungle"] canvas'));
  await page.screenshot({path:path.join(evidence,'02-jungle-onboarding.png')});
  await page.click('[data-testid="room-name"]');await chord(page, 'a');await page.keyboard.type('Omo Demo Room', {delay:90});
  check('Slow typing preserves the entered room name', await page.$eval('[data-testid="room-name"]', el => el.value === 'Omo Demo Room'));
  await page.click('[data-testid="create-room"]');await delay(500);
  check('Create room exits onboarding',!(await page.$('[data-testid="omo-onboarding"]')));
  check('Room name comes from onboarding',await page.$eval('.omo-stage-heading h2',el=>el.textContent==='Omo Demo Room'));
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('omo.room.v1:')))));
  check('Room persists the real project URI',saved && saved.projectUri===`file://${project}`&&saved.theme==='jungle');
  await page.screenshot({path:path.join(evidence,'03-room.png')});
  await page.click('[data-workstation="terminal"]');
  await command(page,"printf 'OMO_TERMINAL_OK' > .omo-shell-proof; pwd; printf '\\nOMO_TERMINAL_OK\\n'");
  check('Scene workstation opens a real shell in the project',await pollFile(path.join(project,'.omo-shell-proof'),'OMO_TERMINAL_OK'));
  await delay(500);await page.screenshot({path:path.join(evidence,'04-terminal.png')});
  await world(page);await page.click('[data-workstation="terminal"]');
  check('Reopening workstation reuses one terminal',(await page.$$('#omo-project-terminal')).length===1);
  await world(page);await page.click('[data-workstation="code"]');
  await page.waitForSelector('.monaco-editor [role="textbox"]',{timeout:20000});
  await page.focus('.monaco-editor [role="textbox"]');await chord(page, 'End');
  await page.keyboard.type('\nOMO_EDITOR_ROUNDTRIP\n',{delay:25});await chord(page, 's');
  check('Code workstation edits the real project file',await pollFile(readme,'OMO_EDITOR_ROUNDTRIP'));
  await page.screenshot({path:path.join(evidence,'05-code.png')});
  await world(page);await page.click('[data-workstation="terminal"]');
  await command(page,"grep -q OMO_EDITOR_ROUNDTRIP README.md && printf 'EDITOR_TO_TERMINAL_OK' > .omo-editor-proof");
  check('Terminal sees the editor change in the same project',await pollFile(path.join(project,'.omo-editor-proof'),'EDITOR_TO_TERMINAL_OK'));
  await world(page);await page.focus('canvas[data-testid="omo-world-canvas"]');await page.keyboard.press('ArrowRight');
  const moved=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('omo.room.v1:')))));
  check('Camera navigation is saved',moved.camera.azimuth!==saved.camera.azimuth);
  await browser.close();browser=await launch(config);page=await open(browser);
  check('Fresh browser restores room without onboarding',!(await page.$('[data-testid="omo-onboarding"]')));
  check('Fresh browser restores the chosen theme',await page.$('.omo-scene-wrap[data-theme="jungle"] canvas'));
  check('Fresh browser restores the room name',await page.$eval('.omo-stage-heading h2',el=>el.textContent==='Omo Demo Room'));
  const restored=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('omo.room.v1:')))));
  check('Fresh browser retains camera and project binding',JSON.stringify(restored.camera)===JSON.stringify(moved.camera)&&restored.projectUri===moved.projectUri);
  await page.screenshot({path:path.join(evidence,'06-restored.png')});
  fs.writeFileSync(path.join(evidence,'e2e-verdict.json'),JSON.stringify({verdict:'PASS',label:'Real local Theia application E2E; no hosted agents or deployment',checks},null,2));
  console.log(`FINAL PASS: ${checks.length} real-app checks`);
 }catch(error){fs.writeFileSync(path.join(evidence,'e2e-verdict.json'),JSON.stringify({verdict:'FAIL',checks,error:String(error)},null,2));throw error;}
 finally{if(browser)await browser.close();fs.writeFileSync(readme,original);for(const file of ['.omo-shell-proof','.omo-editor-proof'])fs.rmSync(path.join(project,file),{force:true});}
})().catch(error=>{console.error(error);process.exit(1);});
