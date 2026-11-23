
import asyncio, sys, json
from playwright.async_api import async_playwright
CHROME="~/.local/opt/google-chrome/opt/google/chrome/chrome"
W=int(sys.argv[1]);H=int(sys.argv[2]);OUT=sys.argv[3]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox","--hide-scrollbars"])
        pg=await b.new_page(viewport={"width":W,"height":H}, is_mobile=W<500, has_touch=W<500, device_scale_factor=2)
        await pg.goto("http://127.0.0.1:8766/onboarding/", wait_until="networkidle")
        async def until(m):
            while m not in await pg.evaluate("window.__marks.map(x=>x[0])"): await pg.wait_for_timeout(50)
        await until("intro:end"); await pg.keyboard.press("Enter"); await until("t1:end")
        await pg.fill("#seed","A quiet glass studio on a cliff above a dark sea, warm lamps"); await pg.focus("#seed")
        await pg.keyboard.press("Enter"); await until("t2:end")
        await pg.keyboard.press("Enter"); await until("read:end"); await pg.wait_for_timeout(1000)
        q="""(()=>{const out=[];document.querySelectorAll('#mind *').forEach(e=>{const r=e.getBoundingClientRect();if(r.width&&(r.right>innerWidth+0.5||r.left<-0.5))out.push([e.tagName,e.className,Math.round(r.left),Math.round(r.right)])});
        const m=document.querySelector('#mind');return {over:out.slice(0,20),sh:m.scrollHeight,ch:m.clientHeight,form:document.querySelector('#form').getBoundingClientRect().toJSON(),
        rows:[...document.querySelectorAll('.row .to')].slice(-3).map(e=>[e.textContent,Math.round(e.getBoundingClientRect().right), e.scrollWidth, e.clientWidth])}})()"""
        print(json.dumps(await pg.evaluate(q),indent=0))
        await pg.screenshot(path=f"{OUT}/m-mind-after.png")
        await b.close()
asyncio.run(main())
