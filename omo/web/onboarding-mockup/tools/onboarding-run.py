
import asyncio, sys, json, time
from playwright.async_api import async_playwright
CHROME="~/.local/opt/google-chrome/opt/google/chrome/chrome"
URL=sys.argv[1]; W=int(sys.argv[2]); H=int(sys.argv[3]); MODE=sys.argv[4]; OUT=sys.argv[5]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox","--hide-scrollbars"])
        ctx=await b.new_context(reduced_motion="reduce" if MODE=="rm" else "no-preference", viewport={"width":W,"height":H}, device_scale_factor=1 if MODE=="time" else 2, is_mobile=W<500, has_touch=W<500)
        pg=await ctx.new_page()
        errs=[]; pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None); pg.on("pageerror", lambda e: errs.append(str(e)))
        cdp=await ctx.new_cdp_session(pg)
        if MODE=="time":
            await cdp.send("Emulation.setCPUThrottlingRate", {"rate":4})
        await pg.add_init_script("""window.__f=[];(function l(t){if(window.__last)window.__f.push([t,t-window.__last]);window.__last=t;requestAnimationFrame(l)})(performance.now());
        window.__ls=0;try{new PerformanceObserver(l=>{for(const e of l.getEntries())if(!e.hadRecentInput)window.__ls+=e.value}).observe({type:'layout-shift',buffered:true})}catch(e){}""")
        await pg.goto(URL, wait_until="networkidle")
        shots=[]; 
        async def strip(name, total_ms, n):
            if MODE!="shots": 
                await pg.wait_for_timeout(total_ms); return
            t0=time.time()
            for i in range(n):
                target=t0+ (total_ms/1000)*i/(n-1)
                d=target-time.time()
                if d>0: await asyncio.sleep(d)
                f=f"{OUT}/{name}-{i:02d}.png"; await pg.screenshot(path=f); shots.append(f)
        async def until(mark):
            for _ in range(400):
                ms=await pg.evaluate("window.__marks.map(m=>m[0])")
                if mark in ms: return
                await pg.wait_for_timeout(100)
            raise Exception("timeout "+mark)
        sw=[]
        async def checkw(tag):
            sw.append([tag]+await pg.evaluate("[document.documentElement.scrollWidth, document.body.scrollWidth, innerWidth, document.scrollingElement.scrollLeft]"))
        await strip("a-intro", 2600, 8); await until("intro:end"); await checkw("welcome")
        await pg.keyboard.press("Enter"); await strip("b-toworld", 2500, 10); await until("t1:end"); await checkw("world")
        if W<500: await pg.tap("#seed")
        await pg.keyboard.type("A quiet glass studio on a cliff above a dark sea, warm lamps")
        await pg.click(".chip:nth-of-type(1)") if False else None
        if MODE=="shots": await pg.screenshot(path=f"{OUT}/c-world-typed.png")
        await pg.focus("#seed"); await pg.keyboard.press("Enter"); await strip("d-tomind", 2800, 10); await until("t2:end"); await checkw("mind")
        await pg.keyboard.press("Enter"); await strip("e-read", 9000, 10); await until("read:end"); await pg.wait_for_timeout(1000); await checkw("read")
        if MODE=="shots": await pg.screenshot(path=f"{OUT}/f-read-done.png")
        await pg.keyboard.press("Enter"); await strip("g-finale", 11500, 16); await until("fin:end"); await checkw("finale")
        if MODE=="shots": await pg.screenshot(path=f"{OUT}/h-finale-end.png")
        await pg.keyboard.press("Enter"); await strip("i-enter", 2600, 8); await until("enter:end"); await checkw("end")
        marks=await pg.evaluate("window.__marks")
        f=await pg.evaluate("window.__f"); ls=await pg.evaluate("window.__ls")
        # frames inside animation windows
        md=dict(); 
        for n,t in marks: md[n]=t
        wins=[("intro","intro:end"),("t1","t1:end"),("t2","t2:end"),("read","read:end"),("fin","fin:end"),("enter","enter:end")]
        res={}
        for a,z in wins:
            ds=[d for t,d in f if md[a]<=t<=md[z]+50]
            res[a]={"frames":len(ds),"over34":sum(1 for d in ds if d>34),"max":round(max(ds),1) if ds else None,"p95":round(sorted(ds)[int(len(ds)*.95)],1) if ds else None}
        print(json.dumps({"w":W,"mode":MODE,"windows":res,"layoutShift":ls,"scroll":sw,"errors":errs,"durations":{a:round(md[z]-md[a]) for a,z in wins}},indent=1))
        await b.close()
asyncio.run(main())
