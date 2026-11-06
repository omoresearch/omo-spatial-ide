const{test}=require('node:test'),assert=require('node:assert/strict');
const h=require('./runtime-test-helpers.cjs');
test('actual tmux output retains wide continuations and combining sequences as terminal cells', {skip:!h.findTmux()||!h.findPython()},async()=>{
 const s=h.scratch('unicode'),{host,service}=h.makeService(s);
 try{
  const ws=await service.openWorkspace({stationId:'unicode-desk',projectUri:s.projectUri,name:'Unicode'});
  const{viewId}=await service.attach({workspaceId:ws.id,tabId:ws.tabs[0].id,cols:80,rows:22});
  await service.input({viewId,data:"printf '\\033[2J\\033[H\\033[11;1HA\\u754cBq\\u0301Z\\n'\r"});
  const p=await h.pollUntil(service,viewId,t=>t.split('\n').some(l=>l.startsWith('A界Bq')));
  assert.ok(p.frame.cells,'The real terminal frame must expose authoritative cells, not guessed Unicode widths');
  const row=p.frame.cells.find(r=>r[0]==='A'&&r[1]==='界');assert.ok(row,'Real terminal cells must contain the CJK glyph');
  assert.deepEqual(row.slice(0,7),['A','界','','B','q\u0301','Z',' ']);
  assert.equal(p.frame.lines[p.frame.cells.indexOf(row)].trim(),'A界Bq\u0301Z');
  assert.equal(p.frame.cells.length,22);assert.ok(p.frame.cells.every(r=>r.length===80));
 }finally{await host.stop();h.killScratchServer(s);}
});
