const { test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./frontend-runtime-helpers.cjs');
const binding = { stationId:'terminal-1',projectUri:'file:///p/a',name:'Bell fixture' };
function frame(sequence,bell){return {state:'live',frame:{sequence,bell,lines:['fixture output'],cols:80,rows:22}};}
test('real frame bell increments become unread visual attention without repeating the count',async()=>{
 const r=H.make();r.service.pollQueue.push(frame(1,0));await r.controller.bind(binding);
 assert.equal(r.controller.state.unreadBells,0);
 r.service.pollQueue.push(frame(2,2));await r.timers.tick();assert.equal(r.controller.state.unreadBells,2);
 r.service.pollQueue.push(frame(3,2));await r.timers.tick();assert.equal(r.controller.state.unreadBells,2);
 r.controller.dispose();
});

test('acknowledge is local-only and only a genuinely new bell raises attention again',async()=>{
 const r=H.make();r.service.pollQueue.push(frame(1,3));await r.controller.bind(binding);const calls=r.service.calls.length;
 r.controller.acknowledgeBells();assert.equal(r.controller.state.unreadBells,0);assert.equal(r.service.calls.length,calls);
 r.service.pollQueue.push(frame(2,3));await r.timers.tick();assert.equal(r.controller.state.unreadBells,0);
 r.service.pollQueue.push(frame(3,4));await r.timers.tick();assert.equal(r.controller.state.unreadBells,1);r.controller.dispose();
});

test('invalid or stale bell counters do not create alerts or poison later valid frames',async()=>{
 const r=H.make();r.service.pollQueue.push(frame(1,0));await r.controller.bind(binding);
 for(const value of [-3,NaN,1.5]){r.service.pollQueue.push(frame(r.controller.state.sequence+1,value));await r.timers.tick();assert.equal(r.controller.state.unreadBells,0);assert.equal(r.controller.state.bell,0);}
 r.service.pollQueue.push(frame(10,1));await r.timers.tick();assert.equal(r.controller.state.unreadBells,1);
 r.controller.acknowledgeBells();r.service.pollQueue.push(frame(9,99));await r.timers.tick();assert.equal(r.controller.state.unreadBells,0);r.controller.dispose();
});
