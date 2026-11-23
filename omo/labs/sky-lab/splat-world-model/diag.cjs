// Diagnostic stills: node diag.cjs <outDir> <query> '<json [[name,x,y,z,yaw,pitch,fov],...]>'
const fs=require('fs'),path=require('path'),http=require('http');
const puppeteer=require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const DIR=__dirname+"", THREE_DIR='~/dev/omo-skyscraper/omo/node_modules/three', PORT=3666;
const T={'.html':'text/html','.js':'text/javascript','.wasm':'application/wasm'};
const srv=http.createServer((q,r)=>{let u=decodeURIComponent(q.url.split('?')[0]);const f=u.startsWith('/three/')?path.join(THREE_DIR,u.slice(7)):path.join(DIR,u==='/'?'index.html':u);fs.readFile(f,(e,b)=>{if(e){r.writeHead(404);return r.end();}r.writeHead(200,{'content-type':T[path.extname(f)]||'application/octet-stream'});r.end(b);});});
(async()=>{const out=path.resolve(process.argv[2]);fs.mkdirSync(out,{recursive:true});await new Promise(r=>srv.listen(PORT,'127.0.0.1',r));
const b=await puppeteer.launch({executablePath:'/opt/google/chrome/chrome',headless:'new',args:['--no-sandbox','--window-size=1600,900','--ignore-gpu-blocklist','--use-angle=gl-egl','--use-gl=angle','--enable-gpu-rasterization','--enable-unsafe-swiftshader'],defaultViewport:{width:1600,height:900}});
const p=await b.newPage();p.on('pageerror',e=>console.log('ERR',e.message));p.on('console',m=>{if(m.type()==='error')console.log('CERR',m.text().slice(0,200))});
await p.goto(`http://127.0.0.1:${PORT}/?${process.argv[3]||''}`);await p.waitForFunction(()=>window.__ready===true,{timeout:240000});
for(const [n,...a] of JSON.parse(process.argv[4])){ if(n.startsWith('tour')) await p.evaluate(t=>window.__tourAt(t),a[0]); else await p.evaluate(a=>window.__worldPose(...a),a); await new Promise(r=>setTimeout(r,1500)); if(!n.startsWith('tour')) await p.evaluate(a=>window.__worldPose(...a),a); else await p.evaluate(t=>window.__tourAt(t),a[0]); await p.screenshot({path:path.join(out,n+'.png')}); console.log('shot',n);}
await b.close();srv.close();})();
