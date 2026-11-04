const test=require('node:test'),assert=require('node:assert/strict');
const{RoomScene}=require('../lib/browser/room-scene.js');
test('starting a text selection chooses the desk locally, not the action that binds or starts its runtime',()=>{
 const scene=Object.create(RoomScene.prototype),calls=[];
 scene.terminalFrames={terminal:{lines:['VISIBLE']}};scene.clearTerminalSelection=()=>{};
 // Geometry and rendering are exercised by the real-app pixel test; isolate the lifecycle dispatch here.
 scene.terminalCellAt=()=>({station:'terminal',cell:{row:0,col:0}});scene.setTerminalFrame=()=>{};
 scene.options={onSelect:()=>calls.push('runtime-action'),onTextSelect:()=>calls.push('local-desk')};
 assert.equal(scene.startTerminalSelection(1,1),true);assert.deepEqual(calls,['local-desk']);assert.equal(scene.terminalSelection.model.text(),'V');
});
