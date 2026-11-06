// Match the source-pinned Minecraft launcher's Linux tmux, without using its data or socket.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),zlib=require('node:zlib'),cp=require('node:child_process');
const URL='https://github.com/mjakob-gh/build-static-tmux/releases/download/v3.7b/tmux.linux-amd64.stripped.gz';
const SHA='92ac102a1f9b33b21d891a836b4b5b5c8c5d2eeac4bae4dfd34d565bbed598bf';
function verifiedGunzip(data,expected=SHA){
 if(data.length>16777216||crypto.createHash('sha256').update(data).digest('hex')!==expected)throw new Error('Pinned tmux checksum verification failed');
 return zlib.gunzipSync(data,{maxOutputLength:67108864});
}
async function main(){
 if(process.platform!=='linux'||process.arch!=='x64')throw new Error('This CI fixture supports Linux x64 only');
 const output=path.resolve(process.argv[2]||'');if(!process.argv[2]||/[\r\n]/.test(output))throw new Error('Provide one safe output path');
 const response=await fetch(URL,{signal:AbortSignal.timeout(60000)});if(!response.ok)throw new Error(`Pinned tmux download failed (${response.status})`);
 const reader=response.body.getReader(),parts=[];let size=0;for(;;){const{done,value}=await reader.read();if(done)break;size+=value.length;if(size>16777216){await reader.cancel();throw new Error('Pinned tmux download is too large');}parts.push(Buffer.from(value));}
 const binary=verifiedGunzip(Buffer.concat(parts));fs.mkdirSync(path.dirname(output),{recursive:true});const temp=output+'.'+crypto.randomUUID()+'.tmp';
 try{fs.writeFileSync(temp,binary,{flag:'wx',mode:0o700});fs.renameSync(temp,output);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 const version=cp.spawnSync(output,['-V'],{encoding:'utf8'});if(version.status!==0||!/^tmux 3\.7b\s*$/.test(version.stdout))throw new Error('Pinned tmux did not report the expected version');
 if(process.env.GITHUB_ENV)fs.appendFileSync(process.env.GITHUB_ENV,`OMO_SPATIAL_TEST_TMUX=${output}\n`);
 console.log('Verified CI tmux: '+version.stdout.trim());
}
module.exports={verifiedGunzip};if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
