/* Actual shell output, physical pointer selection, rendered pixels and the browser clipboard. No agents. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const{ROOT,openWorld,walkTo,command,CANVAS}=require('./world-test-driver.cjs');
const{DESK_ONE,DESK_TWO}=require('./world-navigation-targets.cjs');
(async()=>{

 const marker='OMO_PICK_'+crypto.randomBytes(4).toString('hex').toUpperCase(),gate=path.join(ROOT,'evidence',`selection-gate-${crypto.randomUUID()}`);let w;
 try{
  w=await openWorld('physical-selection');const p=w.page;await w.browser.defaultBrowserContext().overridePermissions(new URL(p.url()).origin,['clipboard-read','clipboard-write','clipboard-sanitized-write']);

  await walkTo(p,DESK_ONE.x,DESK_ONE.z);
  await command(p,'terminal',`printf '\\033[2J\\033[H\\033[11;1H%s\\n' '${marker}'; (for i in $(seq 1 600); do [ -f '${gate}' ] && break; sleep .05; done; printf '\\nOUTPUT_CHANGED\\n') &`);
  await p.waitForFunction(marker=>JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText).terminal.some(l=>l.startsWith(marker)),{},marker);
  async function point(station,row,col,bottom=false){return p.$eval(CANVAS,(e,{station,row,col,bottom})=>{const q=JSON.parse(e.dataset.terminalQuads||'{}')[station],m=JSON.parse(e.dataset.terminalMetrics||'{}')[station];if(!q||!m)return null;const r=e.getBoundingClientRect(),u=(24+(col+.5)*m.cellWidth)/1024,v=(53+(row+(bottom?.95:.5))*22)/576;return{x:r.x+q[0].x+(q[1].x-q[0].x)*u+(q[3].x-q[0].x)*v,y:r.y+q[0].y+(q[1].y-q[0].y)*u+(q[3].y-q[0].y)*v};},{station,row,col,bottom});}
  async function select(station,text){const row=await p.$eval(CANVAS,(e,{station,text})=>JSON.parse(e.dataset.stationText)[station].slice(-22).findIndex(l=>l.startsWith(text)),{station,text});assert.ok(row>=0);const a=await point(station,row,0),b=await point(station,row,text.length-1);assert.ok(a&&b,'Physical monitor selection needs the actual projected screen and measured text grid');await p.keyboard.down('Shift');await p.mouse.move(a.x,a.y);await p.mouse.down();await p.mouse.move(b.x,b.y,{steps:8});await p.mouse.up();await p.keyboard.up('Shift');await p.waitForFunction(text=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalSelection===text,{},text);return row;}
  async function pixel(pt){const data=await p.screenshot({clip:{x:Math.floor(pt.x),y:Math.floor(pt.y),width:1,height:1},encoding:'base64'});return p.evaluate(async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return [...ctx.getImageData(0,0,1,1).data].slice(0,3);},data);}
  async function copy(){await p.keyboard.down('Control');await p.keyboard.down('Shift');await p.keyboard.press('C');await p.keyboard.up('Shift');await p.keyboard.up('Control');}
  await p.evaluate(()=>navigator.clipboard.writeText('UNCHANGED_UNTIL_COPY'));
  const row=await p.$eval(CANVAS,(e,marker)=>JSON.parse(e.dataset.stationText).terminal.slice(-22).findIndex(l=>l.startsWith(marker)),marker),probe=await point('terminal',row,3,true);
  assert.ok(probe,'Physical terminal selection is not implemented');const before=await pixel(probe);
  await select('terminal',marker);assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'UNCHANGED_UNTIL_COPY','Selecting alone must not write the device clipboard');
  const after=await pixel(probe);assert.ok(after[2]>before[2]+20,`The physical monitor must actually show a blue selection highlight: ${before} -> ${after}`);
  await copy();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),marker,'The actual browser clipboard must contain exactly the physical selection');
  fs.writeFileSync(gate,'go');await p.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('OUTPUT_CHANGED')&&!document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalSelection);
  await p.evaluate(()=>navigator.clipboard.writeText('NO_STALE_COPY'));await copy();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'NO_STALE_COPY','Output invalidation must prevent stale copying');
  await select('terminal',marker);await p.keyboard.press('Escape');assert.equal(await p.$eval(CANVAS,e=>e.dataset.terminalSelection),'');
  await walkTo(p,DESK_TWO.x,DESK_TWO.z);const second=marker+'_TWO',file='./src/omo-file.ts:42',wholeLine=`${second} ${file} suffix`;await command(p,'terminal-2',`printf '\\033[2J\\033[H\\033[11;1H%s\\n' '${wholeLine}'`);
  await p.waitForFunction(second=>JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationText)['terminal-2'].some(l=>l.startsWith(second)),{},second);
  await select('terminal-2',second);await copy();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),second,'Desk two must copy its own text, not desk one');
  const clickRow=await p.$eval(CANVAS,(e,second)=>JSON.parse(e.dataset.stationText)['terminal-2'].slice(-22).findIndex(l=>l.startsWith(second)),second),hit=await point('terminal-2',clickRow,second.length+9);
  for(const [clickCount,expected] of [[2,file],[3,wholeLine]]){
   await p.keyboard.down('Shift');await p.mouse.click(hit.x,hit.y,{count:clickCount});await p.keyboard.up('Shift');
   await p.waitForFunction(expected=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalSelection===expected,{},expected);
   await copy();assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),expected,`Native ${clickCount}-click must select and copy the correct unit from real shell output`);
  }
  await p.evaluate(()=>navigator.clipboard.writeText('DENIED_COPY_UNCHANGED'));
  // Deny sanitized writes in this isolated test browser only. The product never grants permissions itself.
  await w.browser.defaultBrowserContext().overridePermissions(new URL(p.url()).origin,['clipboard-read','clipboard-write']);
  await copy();await p.waitForFunction(()=>document.body.innerText.includes('Clipboard copy failed'));
  assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),'DENIED_COPY_UNCHANGED','Permission denial must not replace the clipboard or send a terminal fallback');
  await p.click('[data-testid="station-one-controls"]');assert.equal(await p.$eval(CANVAS,e=>e.dataset.terminalSelection),'','Switching desks clears the old selection');
  console.log('PASS: both physical monitors select exact real shell text; visible highlight; real clipboard; explicit copy; output invalidation; Escape clears; native word and line gestures.');
  fs.writeFileSync(path.join(ROOT,'evidence/physical-selection-real-app.json'),JSON.stringify({pass:true,providerCalls:0,realShell:true,realClipboard:true,physicalHighlightPixels:{before,after},bothDesks:true,staleCopyRefused:true,deniedCopyRefused:true,deskSwitchClears:true,nativeWordSelection:true,nativeLineSelection:true},null,2));
 }finally{fs.writeFileSync(gate,'cleanup');if(w)await w.dispose();/* Keep the owned gate until the bounded shell loop has exited. */}
})().catch(e=>{console.error(e);process.exitCode=1;});
