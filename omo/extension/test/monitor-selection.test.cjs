const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
function api(){const file=path.resolve(__dirname,'../lib/common/monitor-selection.js');assert.ok(fs.existsSync(file),'Visible physical-monitor selection is not implemented');return require(file);}
test('selects exact visible characters in either drag direction without mutating a frame',()=>{
 const{MonitorSelection}=api(),lines=['prefix ALPHA suffix','  BETA tail'];const s=new MonitorSelection(lines,{row:0,col:7});s.extend({row:1,col:5});assert.equal(s.text(),'ALPHA suffix\n  BETA');
 const reverse=new MonitorSelection(lines,{row:1,col:5});reverse.extend({row:0,col:7});assert.equal(reverse.text(),s.text());assert.deepEqual(lines,['prefix ALPHA suffix','  BETA tail']);
});
test('word selection expands paths using the Minecraft bridge token rules and stops at spaces',()=>{
 const{MonitorSelection}=api();const s=new MonitorSelection(['run ./src/foo-bar.ts:42 next'],{row:0,col:13},'word');assert.equal(s.text(),'./src/foo-bar.ts:42');
 const blank=new MonitorSelection(['a  b'],{row:0,col:1},'word');assert.equal(blank.text(),'');
});
test('whole-line selection includes leading spaces and supports reversed multi-row ranges',()=>{
 const{MonitorSelection}=api(),s=new MonitorSelection(['alpha first','  beta tail   '],{row:1,col:7},'line');assert.equal(s.text(),'  beta tail');s.extend({row:0,col:3});assert.equal(s.text(),'alpha first\n  beta tail');assert.deepEqual(s.spans(),[{row:0,from:0,to:80},{row:1,from:0,to:80}]);
});
test('authoritative cells keep wide halves and combining glyphs aligned when selecting and copying',()=>{
 const{MonitorSelection}=api(),row=['A','界','','B','q\u0301','Z'];const lines=['A界Bq\u0301Z'];
 const half=new MonitorSelection(lines,{row:0,col:2},'char',[row]);assert.equal(half.text(),'界');assert.deepEqual(half.spans(),[{row:0,from:1,to:3}]);
 const after=new MonitorSelection(lines,{row:0,col:3},'char',[row]);assert.equal(after.text(),'B');
 const accent=new MonitorSelection(lines,{row:0,col:4},'char',[row]);assert.equal(accent.text(),'q\u0301');assert.deepEqual(accent.spans(),[{row:0,from:4,to:5}]);
 assert.equal(accent.refresh(lines,[['A','界','B','q\u0301','Z']]),false,'Same plain text with changed columns must invalidate selection');
});
test('word expansion does not include half of an adjacent wide non-word glyph',()=>{
 const{MonitorSelection}=api(),s=new MonitorSelection(['😀word'],{row:0,col:4},'word',[['😀','','w','o','r','d']]);assert.equal(s.text(),'word');assert.deepEqual(s.spans(),[{row:0,from:2,to:6}]);
});
test('provided malformed cell metadata fails closed while a missing matrix keeps legacy text',()=>{
 const{visibleMonitorCells}=api();assert.deepEqual(visibleMonitorCells(['safe']),[['s','a','f','e']]);assert.deepEqual(visibleMonitorCells(['safe'],[null]),[[]]);assert.deepEqual(visibleMonitorCells(['safe'],null),[[]]);
});
test('copies only the 80 by 22 visible viewport and trims terminal padding, not leading spaces',()=>{
 const{MonitorSelection}=api();const s=new MonitorSelection(['HIDDEN',...Array.from({length:22},(_,i)=>i===0?'  shown   ':'x'.repeat(80)+'HIDDEN')],{row:0,col:0});s.extend({row:30,col:999});const text=s.text();assert.ok(!text.includes('HIDDEN'));assert.equal(text.split('\n').length,22);assert.equal(text.split('\n')[0],'  shown');assert.equal(text.split('\n')[1].length,80);
});
test('new visible output invalidates a selection instead of copying stale text',()=>{
 const{MonitorSelection}=api(),s=new MonitorSelection(['ALPHA'],{row:0,col:0});s.extend({row:0,col:4});assert.equal(s.refresh(['ALPHA']),true);assert.equal(s.text(),'ALPHA');assert.equal(s.refresh(['BETA']),false);assert.equal(s.text(),'');assert.deepEqual(s.spans(),[]);
});
test('cell picking respects physical screen UV, text margins and measured glyph width',()=>{
 const{monitorCell}=api();assert.deepEqual(monitorCell((24+3.5*12)/1024,1-(53+2.5*22)/576,12),{row:2,col:3});assert.equal(monitorCell(.001,.99,12),undefined);assert.equal(monitorCell(NaN,.5,12),undefined);assert.deepEqual(monitorCell(.999,.001,12,true),{row:21,col:79});
});
