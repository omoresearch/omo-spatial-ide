/* Actual parser columns -> physical monitor colours/cursor -> real clipboard. Local shell only. */
const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const{ROOT,openWorld,walkTo,clickStation,command,CANVAS}=require('./world-test-driver.cjs');const{DESK_ONE}=require('./world-navigation-targets.cjs');
(async()=>{let w,ownedTab;const started=performance.now();try{
 w=await openWorld('unicode-cells',{width:1440,height:960,deviceScaleFactor:2});const p=w.page;await w.browser.defaultBrowserContext().overridePermissions(new URL(p.url()).origin,['clipboard-read','clipboard-write','clipboard-sanitized-write']);await walkTo(p,DESK_ONE.x,DESK_ONE.z);
 // Other acceptance scripts deliberately retain their jobs. Own a NEW shell so their
 // deferred Bash job notifications cannot move this fixture's cursor during a blocked read.
 await clickStation(p,'terminal');await p.waitForSelector('[data-testid="runtime-console"][data-phase="live"]');
 const before=await p.$$eval('[role="tab"][data-testid^="runtime-tab-"]',a=>a.map(e=>e.dataset.testid));
 await p.click('[data-testid="runtime-new-shell"]');
 await p.waitForFunction(before=>{const active=document.querySelector('[role="tab"][aria-selected="true"][data-testid^="runtime-tab-"]');return active&&!before.includes(active.dataset.testid)&&document.querySelector('[data-testid="runtime-console"]').dataset.phase==='live';},{},before);
 ownedTab=await p.$eval('[role="tab"][aria-selected="true"][data-testid^="runtime-tab-"]',e=>e.dataset.testid.slice('runtime-tab-'.length));
 await command(p,'terminal',"printf '\\033[2J\\033[H\\033[11;1HA\\033[44m\\u754c\\033[42mB\\033[45mq\\u0301\\033[0mZ'; read -r -n 1 -t 120 _omo_unicode; printf 'READ_FINISHED'");
 await p.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('A界Bq'));
 const cells=await p.$eval(CANVAS,e=>JSON.parse(e.dataset.stationCells||'{}').terminal);
 assert.ok(cells,'The actual screen must receive parser cells');const row=cells.findIndex(r=>r[0]==='A'&&r[1]==='界');assert.ok(row>=0);assert.deepEqual(cells[row].slice(0,6),['A','界','','B','q\u0301','Z']);
 async function point(col,bottom=false){return p.$eval(CANVAS,(e,{row,col,bottom})=>{const r=e.getBoundingClientRect(),q=JSON.parse(e.dataset.terminalQuads).terminal,m=JSON.parse(e.dataset.terminalMetrics).terminal,u=(24+(col+.5)*m.cellWidth)/1024,v=(53+(row+(bottom?.95:.5))*22)/576;return{x:r.x+q[0].x+(q[1].x-q[0].x)*u+(q[3].x-q[0].x)*v,y:r.y+q[0].y+(q[1].y-q[0].y)*u+(q[3].y-q[0].y)*v};},{row,col,bottom});}
 async function pixel(col){const pt=await point(col,true),data=await p.screenshot({clip:{x:Math.floor(pt.x),y:Math.floor(pt.y),width:1,height:1},encoding:'base64'});return p.evaluate(async data=>{const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=c.height=1;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return[...ctx.getImageData(0,0,1,1).data].slice(0,3);},data);}
 const blue=await pixel(2),green=await pixel(3),magenta=await pixel(4);assert.ok(blue[2]>blue[1]+10,`The wide continuation must keep its blue background: ${blue}`);assert.ok(green[1]>green[0]+10&&green[1]>green[2]+10,`The glyph after CJK must remain at green column 3: ${green}`);assert.ok(magenta[0]>magenta[1]+10&&magenta[2]>magenta[1]+10,`The full combining glyph stays in magenta column 4: ${magenta}`);
 assert.equal(await p.$eval(CANVAS,e=>e.dataset.terminalCursor),`6,${row},true`,'Cursor is in actual terminal columns, not code-point offsets');
 await p.screenshot({path:path.join(ROOT,'evidence/unicode-cells-screen.png')});
 const clip=await p.$eval(CANVAS,e=>{const r=e.getBoundingClientRect(),q=JSON.parse(e.dataset.terminalQuads).terminal,x=r.x+Math.min(...q.map(v=>v.x)),y=r.y+Math.min(...q.map(v=>v.y));return{x,y,width:Math.max(...q.map(v=>v.x))-Math.min(...q.map(v=>v.x)),height:Math.max(...q.map(v=>v.y))-Math.min(...q.map(v=>v.y))};});
 await p.screenshot({path:path.join(ROOT,'evidence/unicode-cells-detail.png'),clip});
 for(const[col,expected]of[[2,'界'],[3,'B'],[4,'q\u0301']]){const pt=await point(col);await p.keyboard.down('Shift');await p.mouse.click(pt.x,pt.y);await p.keyboard.up('Shift');await p.waitForFunction(expected=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalSelection===expected,{},expected);await p.keyboard.down('Control');await p.keyboard.down('Shift');await p.keyboard.press('C');await p.keyboard.up('Shift');await p.keyboard.up('Control');assert.equal(await p.evaluate(()=>navigator.clipboard.readText()),expected);}
 assert.equal(await p.$eval(CANVAS,e=>e.dataset.terminalText.includes('READ_FINISHED')),false,'Selection and copy do not send a character or interrupt to the blocked shell read');
 // Pixel-differentiate the actual combining mark from a plain q; metadata alone is not proof of paint.
 await p.keyboard.press('Escape');await clickStation(p,'terminal');
 const glyphClip=await p.$eval(CANVAS,(e,row)=>{const r=e.getBoundingClientRect(),q=JSON.parse(e.dataset.terminalQuads).terminal,m=JSON.parse(e.dataset.terminalMetrics).terminal;return{x:r.x+q[0].x+(q[1].x-q[0].x)*(24+4*m.cellWidth)/1024,y:r.y+q[0].y+(q[3].y-q[0].y)*(49+row*22)/576,width:(q[1].x-q[0].x)*m.cellWidth/1024,height:(q[3].y-q[0].y)*28/576};},row);
 const accented=await p.screenshot({clip:glyphClip,encoding:'base64'});await p.keyboard.press('Enter');
 await p.waitForFunction(()=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.terminalText.includes('READ_FINISHED'));
 await command(p,'terminal',"printf '\\033[2J\\033[H\\033[11;1HA\\033[44m\\u754c\\033[42mB\\033[45mq\\033[0mZ'; read -r -n 1 -t 120 _omo_plain");
 await p.waitForFunction(row=>JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationCells).terminal[row][4]==='q',{},row);
 const plain=await p.screenshot({clip:glyphClip,encoding:'base64'});
 const changed=await p.evaluate(async(a,b)=>{async function pixels(data){const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return ctx.getImageData(0,0,c.width,c.height).data;}const x=await pixels(a),y=await pixels(b);return Array.from(x).filter((v,i)=>v!==y[i]).length;},accented,plain);
 assert.ok(changed>0,'The actual physical glyph pixels must differ for q plus combining acute versus plain q');
 fs.writeFileSync(path.join(ROOT,'evidence/unicode-real-app.json'),JSON.stringify({pass:true,realShell:true,realClipboard:true,parserCells:cells[row].slice(0,6),physicalPixels:{blue,green,magenta},cursorColumn:6,copyContinuation:true,copyCombining:true,combiningRasterChannelDifferences:changed,providerCalls:0},null,2));console.log('PASS: real CJK continuation, combining glyph raster, physical colour columns, cursor and exact clipboard; no terminal input from selecting/copying.');
 }catch(error){if(w)console.error('Unicode actual failure state',Math.round(performance.now()-started),await w.page.$eval(CANVAS,e=>({text:e.dataset.terminalText,cursor:e.dataset.terminalCursor,typing:e.dataset.typing})).catch(()=>null));throw error;}
 finally{if(w){try{await w.page.focus(CANVAS);await w.page.keyboard.down('Control');await w.page.keyboard.press('c');await w.page.keyboard.up('Control');
 if(ownedTab){await w.page.click(`[data-testid="runtime-close-${ownedTab}"]`);await w.page.waitForSelector('[data-testid="runtime-confirm-yes"]');await w.page.click('[data-testid="runtime-confirm-yes"]');await w.page.waitForSelector(`[data-testid="runtime-tab-${ownedTab}"]`,{hidden:true,timeout:10000});}
 }catch(error){console.error('Owned Unicode fixture cleanup failed',error.message);process.exitCode=1;}await w.dispose();}}
})().catch(e=>{console.error(e);process.exitCode=1;});
