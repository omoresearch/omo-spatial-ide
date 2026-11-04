const{test}=require('node:test'),assert=require('node:assert/strict');
const H=require('./frontend-runtime-helpers.cjs');
test('render runs use terminal columns for colours and preserve full combining glyphs',()=>{
 const{cellRuns}=H.loadController(),cells=['A','界','','B','q\u0301'];const runs=cellRuns('A界Bq\u0301','01234',undefined,{'0':'000000','1':'111111','2':'222222','3':'333333','4':'444444'},{fg:'#ffffff',bg:'#000000'},cells);
 assert.deepEqual(runs.map(r=>r.text),cells);assert.equal(runs[1].x,1);assert.equal(runs[1].glyphColumns,2);assert.equal(runs[2].text,'');assert.equal(runs[3].fg,'#333333');assert.equal(runs[4].text,'q\u0301');assert.equal(runs[4].glyphColumns,1);
});
test('controller forwards actual cells and drops them when a later legacy frame omits metadata',async()=>{
 const r=H.make(),cells=[['A','界','','B','q\u0301']];
 try{r.service.pollQueue.push({state:'live',frame:{sequence:1,cols:80,rows:22,lines:['A界Bq\u0301'],cells}});await r.controller.bind({stationId:'desk',projectUri:'file:///p/a',name:'Cells'});assert.deepEqual(r.controller.state.cells,cells);
 r.service.pollQueue.push({state:'live',frame:{sequence:2,cols:80,rows:22,lines:['legacy']}});await r.timers.tick();assert.equal(r.controller.state.cells,undefined);
 }finally{r.controller.dispose();}
});
