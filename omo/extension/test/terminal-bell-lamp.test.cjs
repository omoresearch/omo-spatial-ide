'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module'),ts=require('typescript'),THREE=require('three');
const old=Module._extensions['.ts'];
Module._extensions['.ts']=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS},fileName:filename}).outputText,filename);
let RoomScene;try{({RoomScene}=require('../src/browser/room-scene.ts'))}finally{Module._extensions['.ts']=old}
function rig(){
 const scene=Object.create(RoomScene.prototype),material=new THREE.MeshStandardMaterial();
 Object.assign(scene,{terminalFrames:{terminal:{lines:[]}},deskLabels:new Map(),lamps:new Map([['terminal',{material}]]),terminalSurfaces:new Map([['terminal',{canvas:{getContext:()=>({fillRect(){},fillText(){}})},texture:{needsUpdate:false}}]])});
 return {scene,material};
}
test('an unread real-terminal bell turns the actual desk material orange until acknowledged',()=>{
 const {scene,material}=rig();scene.setTerminalFrame({lines:[],status:'live',unreadBells:1});
 assert.equal(material.color.getHex(),0xff9e4a);assert.equal(material.emissive.getHex(),0xff9e4a);
 scene.setTerminalFrame({lines:[],status:'live',unreadBells:0});assert.equal(material.color.getHex(),0x87cdb4);
});
test('terminal errors retain priority over the bell lamp',()=>{
 const {scene,material}=rig();scene.setTerminalFrame({lines:[],status:'interrupted',unreadBells:1});assert.equal(material.color.getHex(),0xd26464);
});
