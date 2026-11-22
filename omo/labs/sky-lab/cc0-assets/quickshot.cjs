// quick stills for iteration: node quickshot.cjs out.png "query" [pose-json]
const fs=require('fs'),path=require('path'),http=require('http');
const puppeteer=require('~/dev/omo-skyscraper/omo/node_modules/puppeteer-core');
const DIR=__dirname, T='~/dev/omo-skyscraper/omo/node_modules/three', PORT=3662;
const srv=http.createServer((q,r)=>{let u=decodeURIComponent(q.url.split('?')[0]);let f=u.startsWith('/three/')?path.join(T,u.slice(7)):path.join(DIR,u==='/'?'index.html':u);
 fs.readFile(f,(e,b)=>{if(e){r.writeHead(404);return r.end();}r.writeHead(200,{'content-type':f.endsWith('.html')?'text/html':f.endsWith('.js')?'text/javascript':'application/octet-stream'});r.end(b);});});
(async()=>{await new Promise(r=>srv.listen(PORT,'127.0.0.1',r));
const b=await puppeteer.launch({executablePath:'/opt/google/chrome/chrome',headless:'new',args:['--no-sandbox','--window-size=1600,900','--ignore-gpu-blocklist','--use-angle=gl-egl','--use-gl=angle','--enable-gpu-rasterization'],defaultViewport:{width:1600,height:900}});
const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(String(e))); p.on('console',m=>{if(m.type()==='error'||m.type()==='warning')errs.push(m.text().slice(0,200))});
await p.goto(`http://127.0.0.1:${PORT}/?${process.argv[3]||''}`);
const t0=Date.now(); try{await p.waitForFunction(()=>window.__ready===true,{timeout:+(process.env.QS_MS||60000)});}catch(e){console.log('NOT READY',errs);await b.close();srv.close();process.exit(1);} console.log('ready ms',Date.now()-t0);
const outs=process.argv[2].split(','); const ts=(process.argv[4]||'0').split(';');
for(let i=0;i<outs.length;i++){ const t=ts[i]; if(t.startsWith('{')) await p.evaluate(s=>window.__setPose(JSON.parse(s)),t); else await p.evaluate(t=>window.__tourAt(+t),t); await new Promise(r=>setTimeout(r,500)); await p.screenshot({path:outs[i]}); }
console.log('errors',errs.slice(0,6)); await b.close(); srv.close();})();
