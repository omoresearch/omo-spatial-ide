const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const source=path.resolve(__dirname,'../src/common/player-state.ts');
function player(){assert.ok(fs.existsSync(source),'First-person movement is not implemented');return require(source);}
test('WASD moves the player through the room in the facing direction',()=>{
 const {advancePlayer}=player();
 const result=advancePlayer({x:0,z:4.2,yaw:0,pitch:0},{forward:1,right:0},1);
 assert.ok(result.z<4.2,'Forward must walk into the room');
 assert.equal(result.x,0);
});
test('movement stays inside the room and stops at desks instead of walking through them',()=>{
 const {advancePlayer}=player();
 assert.ok(advancePlayer({x:5.5,z:4.4,yaw:0,pitch:0},{forward:0,right:1},.1).x<=5.5);
 const front=advancePlayer({x:-2.65,z:1.5,yaw:0,pitch:0},{forward:1,right:0},.1);
 assert.equal(front.z,1.5,'The terminal desk blocks the player at its front');
 const diagonal=advancePlayer({x:0,z:4,yaw:0,pitch:0},{forward:1,right:1},.1);
 assert.ok(Math.hypot(diagonal.x,diagonal.z-4)<=.271,'Diagonal walking must not be faster');
});
