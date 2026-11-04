const{test}=require('node:test');const assert=require('node:assert/strict');
const{advancePlayer,PLAYER_HOME}=require('../src/common/player-state.ts');const{DESK_ONE,DESK_TWO}=require('./world-navigation-targets.cjs');
test('real-app walking targets are reachable before collision even with the capped low-FPS timestep',()=>{
 for(const target of [DESK_ONE,DESK_TWO])for(let phase=1;phase<=100;phase++){
  let pose={...PLAYER_HOME,x:target.x};pose=advancePlayer(pose,{forward:1,right:0},phase/1000);
  for(let i=0;i<100&&pose.z>=target.z;i++)pose=advancePlayer(pose,{forward:1,right:0},.1);
  assert.ok(pose.z<target.z,`QA target ${JSON.stringify(target)} is unreachable: actual stop ${pose.z}, first frame ${phase}ms`);
 }
});
