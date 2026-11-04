const{test}=require('node:test');const assert=require('node:assert/strict');const path=require('node:path');const fs=require('node:fs');
const file=path.resolve(__dirname,'../lib/common/terminal-links.js');
function extract(lines){assert.ok(fs.existsSync(file),'Visible-terminal safe link extraction is not implemented');return require(file).terminalLinks(lines);}
test('visible terminal links are explicit HTTP(S), deduplicated and preserve their displayed token',()=>{
 assert.deepEqual(extract(['Local: http://127.0.0.1:3000/','http://127.0.0.1:3000/ https://example.com/path?q=a%2Fb#part']),[{text:'http://127.0.0.1:3000/',url:'http://127.0.0.1:3000/'},{text:'https://example.com/path?q=a%2Fb#part',url:'https://example.com/path?q=a%2Fb#part'}]);
});

test('unsafe schemes, URL credentials, malformed hosts and control bytes never become terminal actions',()=>{
 assert.deepEqual(extract(['javascript:alert(1) file:///etc/passwd data:text/html,x ftp://example.com','http://user:password@example.com/ https://exa%zz.invalid/','https://example.com/\x00hidden']),[]);
});
test('only complete URLs on the physical 80 by 22 viewport are offered, with a bounded list',()=>{
 assert.deepEqual(extract(['https://hidden.invalid/',...Array(22).fill('blank')]),[]);
 assert.deepEqual(extract(['x'.repeat(80)+' https://hidden.invalid/']),[]);
 assert.deepEqual(extract(['https://example.com/'+ 'x'.repeat(100)]),[]);
 assert.equal(extract(Array.from({length:12},(_,i)=>'https://example.com/'+i)).length,8);
});
