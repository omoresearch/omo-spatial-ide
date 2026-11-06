/* Real UI review in an owned temporary Git repository and isolated loopback app. */
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),net=require('node:net');
const {execFileSync,spawn,spawnSync}=require('node:child_process');
const {ROOT,CANVAS,openWorld,walkTo,clickStation,pause}=require('./world-test-driver.cjs');
(async()=>{
 let w,server,childEnv,owned;
 const previousUrl=process.env.OMO_URL,token=crypto.randomBytes(6).toString('hex'),socket=`omo-review-test-${token}`;
 const name=`review_${token}_ "é name.txt`,first='OMO_REVIEW_FIRST_SAVED_LINE',second='OMO_REVIEW_SECOND_SAVED_LINE';
 try{
  const scratch=process.env.TMPDIR||path.join(ROOT,'evidence');fs.mkdirSync(scratch,{recursive:true});owned=fs.mkdtempSync(path.join(scratch,'omo-review-app-'));
  const repo=path.join(owned,'repo'),project=path.join(repo,'project'),file=path.join(project,name);fs.mkdirSync(project,{recursive:true});
  const git=args=>execFileSync('git',['--no-pager','-c','core.fsmonitor=false','-c','commit.gpgsign=false','-c',`core.hooksPath=${path.join(owned,'no-hooks')}`,'-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']});
  git(['init','-q']);git(['config','user.name','Owned Review Fixture']);git(['config','user.email','review@example.test']);
  fs.writeFileSync(file,'OWNED_BASELINE\n');fs.writeFileSync(path.join(repo,'outside-project.txt'),'OUTSIDE_BASELINE\n');git(['add','--','.']);git(['commit','-qm','owned fixture baseline']);
  assert.equal(git(['rev-parse','--show-toplevel']).trim(),repo,'The fixture must have its own Git repository, not the developer repo');
  fs.writeFileSync(file,first+'\n');fs.writeFileSync(path.join(repo,'outside-project.txt'),'OUTSIDE_EDIT_MUST_NOT_BE_LISTED\n');
  const head=git(['rev-parse','HEAD']).trim(),indexFile=path.join(repo,'.git','index'),indexHash=()=>crypto.createHash('sha256').update(fs.readFileSync(indexFile)).digest('hex'),beforeIndex=indexHash();
  const listener=net.createServer();await new Promise((resolve,reject)=>{listener.once('error',reject);listener.listen(0,'127.0.0.1',resolve);});const port=listener.address().port;await new Promise(resolve=>listener.close(resolve));
  childEnv={...process.env,THEIA_CONFIG_DIR:path.join(owned,'theia'),OMO_SPATIAL_DATA:path.join(owned,'runtime'),OMO_SPATIAL_TMUX_SOCKET:socket,OMO_SPATIAL_TMUX:process.env.OMO_SPATIAL_TEST_TMUX||process.env.OMO_SPATIAL_TMUX,OMO_URL:`http://127.0.0.1:${port}`};
  const log=fs.openSync(path.join(ROOT,'evidence/change-review-owned-server.log'),'a');
  server=spawn(process.execPath,[path.join(ROOT,'scripts/start.cjs'),'--workspace',project,'--port',String(port)],{cwd:ROOT,env:childEnv,detached:true,shell:false,stdio:['ignore',log,log]});fs.closeSync(log);let spawnError;server.on('error',error=>{spawnError=error;});
  let ready=false;for(let i=0;i<150;i++){if(spawnError)throw spawnError;if(server.exitCode!==null||server.signalCode!==null)throw new Error('Owned review app exited before readiness');try{if((await fetch(childEnv.OMO_URL,{signal:AbortSignal.timeout(500)})).ok){ready=true;break;}}catch{}await pause(200);}assert.ok(ready,'The owned review app must start');
  process.env.OMO_URL=childEnv.OMO_URL;w=await openWorld('git-review-owned');const p=w.page;
  assert.ok((await p.$eval('.omo-footer',e=>e.textContent)).includes(project),'The actual app must use the owned nested project');
  async function selectFile(){const handle=await p.evaluateHandle(name=>[...document.querySelectorAll('button[data-review-path]')].find(e=>e.getAttribute('data-review-path')===name),name);const button=handle.asElement();assert.ok(button,'The exact literal filename must be listed');await button.click();await handle.dispose();}
  assert.ok(await p.$('[data-testid="review-action"]'),'The real world has no change-review entry point');
  await walkTo(p,-4.8,-1.4);await p.waitForFunction(()=>JSON.parse(document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.stationTargets||'{}').code?.visible);
  await p.waitForFunction(()=>getComputedStyle(document.querySelector('[data-workstation="code"]')).visibility==='visible');
  async function screen(){const clip=await p.$eval(CANVAS,e=>{const r=e.getBoundingClientRect(),q=JSON.parse(e.dataset.codeReviewQuad);return{x:r.x+Math.min(...q.map(v=>v.x)),y:r.y+Math.min(...q.map(v=>v.y)),width:Math.max(...q.map(v=>v.x))-Math.min(...q.map(v=>v.x)),height:Math.max(...q.map(v=>v.y))-Math.min(...q.map(v=>v.y))};});return p.screenshot({clip,encoding:'base64'});}
  const before=await screen();await clickStation(p,'code');await p.waitForSelector('[data-testid="git-review-panel"][data-phase="ready"]');
  assert.deepEqual(await p.$$eval('button[data-review-path]',buttons=>buttons.map(e=>e.getAttribute('data-review-path'))),[name],'Parent-repository changes must be excluded from the nested project list');
  assert.equal(await p.$eval('[data-testid="git-review-patch"]',(e,text)=>e.textContent.includes(text),first),false,'Opening the list must not automatically read file patches');
  await selectFile();await p.waitForFunction(text=>document.querySelector('[data-testid="git-review-patch"]').textContent.includes('+'+text),{},first);
  assert.equal(await p.$$eval('[data-testid="git-review-panel"] [contenteditable="true"],[data-testid="git-review-panel"] textarea',nodes=>nodes.length),0,'The patch surface is read-only');
  const savedSecond=second+'\n'+Array.from({length:40},(_,i)=>`saved line ${i}`).join('\n')+'\n';fs.writeFileSync(file,savedSecond);await p.click('[data-testid="git-review-refresh"]');await p.waitForSelector('[data-testid="git-review-panel"][data-phase="ready"]');await selectFile();await p.waitForFunction(text=>document.querySelector('[data-testid="git-review-patch"]').textContent.includes('+'+text),{},second);
  await p.click('[data-testid="git-review-close"]');await p.waitForSelector('[data-testid="git-review-panel"]',{hidden:true});await p.waitForFunction(text=>document.querySelector('canvas[data-testid="omo-world-canvas"]').dataset.codeReviewText.includes(text),{},second);
  const previewStatus=await p.$eval(CANVAS,e=>String(e.dataset.codeReviewStatus));assert.match(previewStatus,/PREVIEW 22\/\d+ lines/,'The physical screen must disclose that the long patch is only a preview');
  const after=await screen(),changed=await p.evaluate(async(a,b)=>{async function pixels(data){const i=new Image();i.src='data:image/png;base64,'+data;await i.decode();const c=document.createElement('canvas');c.width=i.width;c.height=i.height;const ctx=c.getContext('2d');ctx.drawImage(i,0,0);return ctx.getImageData(0,0,c.width,c.height).data;}const x=await pixels(a),y=await pixels(b);return Array.from(x).filter((v,i)=>v!==y[i]).length;},before,after);assert.ok(changed>0,'The physical code screen pixels must change from the actual Git review');
  await p.click('[data-testid="review-action"]');await p.waitForSelector('[data-testid="git-review-panel"][data-phase="ready"]');await selectFile();await p.waitForFunction(()=>!document.querySelector('[data-testid="git-review-open-file"]').disabled);await p.click('[data-testid="git-review-open-file"]');
  await p.waitForFunction(text=>[...document.querySelectorAll('.monaco-editor')].some(e=>e.innerText.includes(text)),{},second);
  assert.equal(fs.readFileSync(file,'utf8'),savedSecond);assert.equal(indexHash(),beforeIndex,'Review must not rewrite the Git index');assert.equal(git(['rev-parse','HEAD']).trim(),head,'Review must not create or move a commit');
  fs.writeFileSync(path.join(ROOT,'evidence/git-review-real-app.json'),JSON.stringify({pass:true,isolatedRepository:true,isolatedApp:true,nestedProjectScope:true,literalFilename:name,realGit:true,physicalEntry:true,physicalScreenChangedChannels:changed,previewStatus,explicitPatchRead:true,refreshReadsSavedChange:true,realEditor:true,indexUnchanged:true,headUnchanged:true,fileUnchangedByReview:true,providerCalls:0},null,2));
  console.log('PASS: owned temporary Git repo and isolated app; physical Code review, scoped real patches, long-preview label, literal filename/editor, unchanged index/HEAD/file.');
 }catch(error){if(w)fs.writeFileSync(path.join(ROOT,'evidence/git-review-app-failure.txt'),await w.page.evaluate(()=>document.body.innerText).catch(()=>''));throw error;}
 finally{
  try{if(w)await w.dispose();}finally{
   if(previousUrl===undefined)delete process.env.OMO_URL;else process.env.OMO_URL=previousUrl;
   if(server?.pid>1&&server.exitCode===null&&server.signalCode===null){try{process.kill(-server.pid,'SIGTERM');}catch(error){if(error.code!=='ESRCH')throw error;}for(let n=0;n<40&&server.exitCode===null&&server.signalCode===null;n++)await pause(100);if(server.exitCode===null&&server.signalCode===null){try{process.kill(-server.pid,'SIGKILL');}catch(error){if(error.code!=='ESRCH')throw error;}for(let n=0;n<20&&server.exitCode===null&&server.signalCode===null;n++)await pause(100);}}
   if(childEnv&&/^omo-review-test-[a-f0-9]{12}$/.test(socket)){const {discoverRuntime}=require('../lib/node/runtime-discovery');const {tmux}=discoverRuntime(childEnv);if(tmux)spawnSync(tmux,['-L',socket,'kill-server'],{stdio:'ignore',timeout:5000});}
   if(owned&&(!server||server.exitCode!==null||server.signalCode!==null))fs.rmSync(owned,{recursive:true,force:true});
  }
 }
})().catch(error=>{console.error(error);process.exitCode=1;});
