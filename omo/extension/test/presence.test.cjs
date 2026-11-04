const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const typescript = require('typescript');
const originalTsLoader = Module._extensions['.ts'];
Module._extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const output = typescript.transpileModule(source, {
    compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2020 },
    fileName: filename
  }).outputText;
  module._compile(output, filename);
};
const file=path.resolve(__dirname,'../src/node/room-presence.ts');
assert.ok(fs.existsSync(file),'Shared-room presence is not implemented');
const {RoomPresence}=require(file);
Module._extensions['.ts'] = originalTsLoader;
function setup(){let now=0;const store=new RoomPresence(()=>now);return {store,advance:ms=>now+=ms,a:store.connection(),b:store.connection()};}
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const join=(n=1,extra={})=>({roomId:'test-room',name:`Tester ${n}`,clientId:id(n),projectUri:'file:///project',theme:'station',...extra});
const pose={x:1,z:2,yaw:0,pitch:0};
test('two connections share presence but update/leave only their own member',async()=>{const {a,b}=setup();const first=await a.join(join());const second=await b.join(join(2));assert.notEqual(first.selfId,second.selfId);assert.equal(second.members.length,2);const next=await a.update(pose);assert.equal(next.members.find(m=>m.id===first.selfId).pose.x,1);assert.equal(next.members.find(m=>m.id===second.selfId).pose.x,0);next.members[0].name='mutated';assert.notEqual((await b.update(pose)).members[0].name,'mutated');await a.leave();assert.deepEqual((await b.update(pose)).members.map(m=>m.id),[second.selfId]);await assert.rejects(()=>a.update(pose),/Join/);});
test('joining another room never exposes previous room members',async()=>{const {a,b}=setup();await a.join(join());await b.join(join(2));assert.equal((await b.join(join(2,{roomId:'other-room'}))).members.length,1);assert.equal((await a.update(pose)).members.length,1);});
test('failed mismatch/full/duplicate joins retain existing memberships',async()=>{const {store,a,b}=setup();await a.join(join());await b.join(join(2,{roomId:'other-room'}));for(const extra of [{theme:'jungle'},{projectUri:'file:///different'},{clientId:id(1)}])await assert.rejects(()=>b.join(join(2,extra)));assert.equal((await b.update(pose)).roomId,'other-room');for(let i=3;i<=9;i++)await store.connection().join(join(i));await assert.rejects(()=>b.join(join(2)),/full/);assert.equal((await b.update(pose)).roomId,'other-room');});
test('presence rejects malformed names, codes, IDs, projects, themes, layouts and non-finite/out-of-room poses',async()=>{const {a}=setup();for(const extra of [{name:' '},{name:'bad\nname'},{name:'x'.repeat(33)},{roomId:'../escape'},{roomId:'Uppercase'},{clientId:'x'},{projectUri:'http://example.com'},{theme:'unknown'},{layout:'atrium'}])await assert.rejects(()=>a.join(join(1,extra)));await a.join(join());for(const bad of [{x:NaN},{x:Infinity},{x:100},{z:-100},{yaw:Infinity},{pitch:2},{x:'1'}])await assert.rejects(()=>a.update({...pose,...bad}));assert.equal((await a.update(pose)).members.length,1);});
test('stale membership expires, disconnect removes it, and disposed connections cannot rejoin',async()=>{const {a,b,advance}=setup();await a.join(join());await b.join(join(2));advance(10000);await b.update(pose);advance(6000);assert.equal((await b.update(pose)).members.length,1);a.dispose();await assert.rejects(()=>a.join(join()),/closed/);await assert.rejects(()=>a.update(pose),/closed/);b.dispose();});
test('empty rooms are reclaimed and live-room count is bounded',async()=>{const {store,a}=setup();for(let i=0;i<32;i++)await store.connection().join(join(i+1,{roomId:`room-${i}`}));await assert.rejects(()=>a.join(join(99,{roomId:'overflow'})),/limit/);});
test('a suspended but connected browser can renew its own expired visual presence without starting any runtime',async()=>{const {a,b,advance}=setup();const first=await a.join(join());await b.join(join(2));advance(10000);await b.update(pose);advance(6000);assert.equal((await b.update(pose)).members.length,1);const renewed=await a.update(pose);assert.equal(renewed.selfId,first.selfId);assert.equal(renewed.members.length,2);await a.leave();await assert.rejects(()=>a.update(pose),/Join/);});
test('expired renewal stops after leave, dispose, or replacement membership during its async gap',async()=>{
 const leaving=setup();await leaving.a.join(join());leaving.advance(16001);const pendingLeave=leaving.a.update({...pose,x:2});await leaving.a.leave();await assert.rejects(pendingLeave,/Join a room first/);
 const disposed=setup();await disposed.a.join(join());disposed.advance(16001);const pendingDispose=disposed.a.update({...pose,x:2});disposed.a.dispose();await assert.rejects(pendingDispose,/closed/);
 const replaced=setup();await replaced.a.join(join());replaced.advance(16001);const pendingReplacement=replaced.a.update({...pose,x:2});await replaced.a.join(join(1,{roomId:'other-room'}));await assert.rejects(pendingReplacement,/Join a room first/);assert.equal((await replaced.a.update({...pose,x:0})).members[0].pose.x,0);
});

test('renewal retains layout identity and rejects an expired classic/wide mismatch',async()=>{const {store,a,b,advance}=setup();const wide=await a.join(join(1,{layout:'wide'}));assert.equal(wide.layout,'wide');const same=await b.join(join(2,{layout:'wide'}));assert.equal(same.layout,'wide');advance(16001);const replacement=await store.connection().join(join(3));assert.equal(replacement.layout,undefined);await assert.rejects(()=>a.update(pose),/different project or theme/);});

test('renewal cannot bypass a changed room project or theme',async()=>{const {a,b,advance}=setup();await a.join(join());advance(16000);await b.join(join(2,{theme:'jungle'}));await assert.rejects(()=>a.update(pose),/different project or theme/);assert.equal((await b.update(pose)).members.length,1);});

test('effective classic and wide layouts reject joins and expired renewal',async()=>{const {store,a,b,advance}=setup();await a.join(join());await assert.rejects(()=>b.join(join(2,{layout:'wide'})),/different project or theme/);advance(16001);const replacement=await store.connection().join(join(3,{layout:'wide'}));assert.equal(replacement.layout,'wide');await assert.rejects(()=>a.update(pose),/different project or theme/);});

test('classic presence keeps the old payload shape',async()=>{const {a}=setup();const snapshot=await a.join(join(1,{layout:'classic'}));assert.equal('layout' in snapshot,false);});
