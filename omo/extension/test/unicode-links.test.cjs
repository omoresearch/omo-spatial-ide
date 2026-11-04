const{test}=require('node:test'),assert=require('node:assert/strict');
const{terminalLinks}=require('../lib/common/terminal-links.js');
test('a URL touching physical column 80 is refused even when wide glyphs make its plain string shorter',()=>{
 const url='https://example.com/path';const row=['界','',...Array(80-2-url.length).fill(' '),...url];assert.equal(row.length,80);
 assert.deepEqual(terminalLinks([row.join('')],[row]),[]);
 assert.deepEqual(terminalLinks([row.join('')]),[],'A legacy non-ASCII row has no trustworthy terminal-column map');
 const safe=['界','',...Array(80-3-url.length).fill(' '),...url,' '];assert.deepEqual(terminalLinks([safe.join('')],[safe]),[{text:url,url}]);
});
