'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript');
const {RuntimeConsoleController}=require('../src/browser/runtime-console-controller.ts');
const {FakeRuntime,ManualTimers,settle,deferred}=require('./frontend-runtime-helpers.cjs');
// Exercise the actual widget method and callback, without booting Theia's DOM.
const filename=path.join(__dirname,'../src/browser/omo-world-widget.tsx');
const text=fs.readFileSync(filename,'utf8');const tree=ts.createSourceFile(filename,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let changed;const callbacks=[];
function visit(n){if(ts.isMethodDeclaration(n)&&n.name.getText(tree)==='consoleChanged')changed=n.getText(tree);if(ts.isPropertyAssignment(n)&&n.name.getText(tree)==='onMirrorFrame')callbacks.push(n.initializer.getText(tree));ts.forEachChild(n,visit)}visit(tree);
assert.ok(changed);assert.equal(callbacks.length,1);
const compiled=ts.transpileModule(`class WidgetProbe { ${changed}; mirrorFrame=${callbacks[0]}; }\nmodule.exports=WidgetProbe;`,{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const loaded=new Module(filename,module);loaded._compile(compiled,filename);const WidgetProbe=loaded.exports;
function rig(){
 const widget=new WidgetProbe();const service=new FakeRuntime();const timers=new ManualTimers();
 service.poll=async input=>({state:'live',frame:{sequence:1,cols:input.viewId==='v1'?80:120,rows:22,lines:['ready']}});
 Object.assign(widget,{consoleStates:{terminal:RuntimeConsoleController.initial()},stationLink:{targetStationId:'terminal'},mirrorAttached:false,activeStation:'terminal',monitors:{},binding:()=>({stationId:'owned-desk'}),toMonitorFrame:frame=>frame,worldScene:{setMirrorFrame(){}},update(){}});
 const controller=new RuntimeConsoleController({service,schedule:timers.schedule,cancel:timers.cancel,onChange:state=>widget.consoleChanged(state,'terminal'),onMirrorFrame:frame=>widget.mirrorFrame(frame)});
 widget.consoles=new Map([['terminal',controller]]);return {widget,controller,service,timers};
}
test('automatic station mirror attaches once rather than replacing its PTY on every live poll',async()=>{
 const r=rig();try{
  await r.controller.bind({stationId:'owned-desk',projectUri:'file:///p/a',name:'Room'});await settle();
  assert.equal(r.service.named('attach').length,2,'one main view and one mirror');
  for(let i=0;i<4;i++)await r.timers.tick();
  assert.equal(r.service.named('attach').length,2,'polling must retain the existing mirror and its PTY');
 }finally{r.controller.dispose()}
});
test('a pending mirror attachment cannot be reentered by later live polls',async()=>{
 const r=rig();const hold=deferred();try{
  await r.controller.bind({stationId:'owned-desk',projectUri:'file:///p/a',name:'Room'});await settle();
  r.widget.mirrorAttached=true;r.controller.detachMirror();r.service.hold.attach=hold;
  const before=r.service.named('attach').length;r.widget.consoleChanged({...r.controller.state},'terminal');await settle();
  for(let i=0;i<3;i++)await r.timers.tick();
  assert.equal(r.service.named('attach').length,before+1,'only one attachment may be pending');
 }finally{hold.resolve({viewId:'held-mirror'});await settle();r.controller.dispose()}
});
test('a late mirror attach cannot claim a station that was relinked while it waited',async()=>{
 const r=rig();const hold=deferred();try{
  await r.controller.bind({stationId:'owned-desk',projectUri:'file:///p/a',name:'Room'});await settle();
  r.controller.detachMirror();r.service.hold.attach=hold;
  r.widget.consoleChanged({...r.controller.state},'terminal');await settle();
  r.widget.stationLink={targetStationId:'terminal-2'};
  hold.resolve({viewId:'stale-old-desk'});await settle();
  assert.equal(r.widget.mirrorAttached,false,'a stale completion must not mark the new target attached');
  assert.ok(r.service.named('detach').some(call=>call.arg==='stale-old-desk'),'the obsolete mirror must detach');
 }finally{hold.resolve({viewId:'stale-old-desk'});await settle();r.controller.dispose()}
});
