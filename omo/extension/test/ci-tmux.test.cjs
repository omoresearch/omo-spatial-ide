const test=require('node:test'),assert=require('node:assert/strict'),zlib=require('node:zlib'),crypto=require('node:crypto');
const{verifiedGunzip}=require('../../scripts/ci-tmux.cjs');
test('CI tmux bootstrap rejects corrupt bytes before decompression or execution',()=>{assert.throws(()=>verifiedGunzip(Buffer.from('corrupt')),/checksum/);});
test('CI tmux bootstrap expands only bytes matching the requested checksum',()=>{const data=zlib.gzipSync(Buffer.from('local fixture, not executable'));const sha=crypto.createHash('sha256').update(data).digest('hex');assert.equal(verifiedGunzip(data,sha).toString(),'local fixture, not executable');data[0]^=1;assert.throws(()=>verifiedGunzip(data,sha),/checksum/);});
