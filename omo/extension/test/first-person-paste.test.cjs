const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('three');
const { FirstPersonControls } = require('../lib/browser/first-person-controls.js');
class Canvas extends EventTarget { constructor() { super(); this.dataset = {}; } focus() {} }
function rig(pasteHandler) {
    const old = global.window; global.window = new EventTarget();
    const canvas = new Canvas(), input = [], messages = [];
    const controls = new FirstPersonControls(canvas, new THREE.PerspectiveCamera(), () => 'terminal', text => input.push(text), text => messages.push(text), pasteHandler);
    controls.setEnabled(true); controls.focusTerminal();
    return { canvas, input, messages, cleanup() { controls.dispose(); if (old === undefined) delete global.window; else global.window = old; } };
}
function paste(rig, text) { const event = new Event('paste', { cancelable: true }); Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } }); Object.defineProperty(event, 'target', { value: rig.canvas }); global.window.dispatchEvent(event); }
test('a multiline paste cannot execute commands by bypassing Enter on a physical terminal', () => {
    const r = rig(); try { paste(r, 'touch unexpected\necho second'); assert.deepEqual(r.input, []); assert.match(r.messages.at(-1), /one line|multiline|paste/i); } finally { r.cleanup(); }
});
test('paste caps bytes and refuses ESC/control injection while preserving normal single-line text', () => {
    const r = rig(); try {
        for (const text of ['bad\x1b[201~touch escaped', 'bad\rcommand', 'x'.repeat(262145)]) paste(r, text);
        assert.deepEqual(r.input, []);
        paste(r, 'echo expected'); assert.deepEqual(r.input, ['echo expected']);
    } finally { r.cleanup(); }
});
test('Ctrl+V leaves native paste handling available instead of injecting Control+V into the shell', () => {
    const r = rig(); try {
        const event = new Event('keydown', { cancelable: true });
        Object.defineProperties(event, { key: { value: 'v' }, ctrlKey: { value: true }, metaKey: { value: false } });
        Object.defineProperty(event, 'target', { value: r.canvas }); global.window.dispatchEvent(event); assert.equal(event.defaultPrevented, false); assert.deepEqual(r.input, []);
    } finally { r.cleanup(); }
});

test('physical-screen focus state is published immediately, not one animation frame late', () => {
 const r = rig(); try { assert.equal(r.canvas.dataset.typing, 'true'); } finally { r.cleanup(); }
});

test('an explicit safe-paste handler receives clipboard text instead of the raw terminal key stream', () => {
 const pasted=[],r=rig(text=>pasted.push(text));try{paste(r,'first\nsecond');assert.deepEqual(pasted,['first\nsecond']);assert.deepEqual(r.input,[]);}finally{r.cleanup();}
});

test('terminal Ctrl+C is intercepted at window capture before IDE document shortcuts',()=>{
 const r=rig();try{const e=new Event('keydown',{cancelable:true});Object.defineProperties(e,{target:{value:r.canvas},key:{value:'c'},ctrlKey:{value:true}});global.window.dispatchEvent(e);assert.deepEqual(r.input,['\x03']);}finally{r.cleanup();}
});
test('global interception leaves keyboard input outside the spatial canvas alone',()=>{
 const r=rig();try{const e=new Event('keydown',{cancelable:true});Object.defineProperties(e,{target:{value:new Canvas()},key:{value:'c'},ctrlKey:{value:true}});global.window.dispatchEvent(e);assert.deepEqual(r.input,[]);assert.equal(e.defaultPrevented,false);}finally{r.cleanup();}
});
