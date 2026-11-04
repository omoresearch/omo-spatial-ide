const test = require('node:test');
const assert = require('node:assert/strict');
const { webConnection } = require(process.env.OMO_WEB_CONNECTION_IMPL || '../lib/node/web-connection.js');
function backend() { let n=0; const closed=[]; return { closed, async status(){return {available:true,detail:'fixture'};}, async open(){return {id:`page${++n}`};}, async frame(args){return args;},async close(id){closed.push(id);} }; }
test('each browser connection rejects another connection page before backend dispatch', async()=>{
 const b=backend(),a=webConnection(b),other=webConnection(b);const page=await a.service.open({url:'localhost',width:960,height:600});
 assert.throws(()=>other.service.frame({id:page.id}),/belong/);assert.deepEqual(await a.service.frame({id:page.id}),{id:page.id});await other.dispose();assert.deepEqual(b.closed,[]);await a.dispose();assert.deepEqual(b.closed,[page.id]);
});
test('late browser open after a client disconnect closes its actual returned page',async()=>{
 const b=backend();let resolve;b.open=()=>new Promise(r=>resolve=r);const a=webConnection(b);const pending=a.service.open({url:'localhost',width:960,height:600});await a.dispose();resolve({id:'late'});await assert.rejects(pending,/closed/);assert.deepEqual(b.closed,['late']);
});
test('owned-page cleanup attempts every page even if one close fails',async()=>{
 const b=backend(),a=webConnection(b);await a.service.open({});await a.service.open({});b.close=async id=>{b.closed.push(id);if(id==='page1')throw new Error('fixture close failure');};await assert.rejects(a.dispose(),/close failure/);assert.deepEqual(b.closed,['page1','page2']);
});
