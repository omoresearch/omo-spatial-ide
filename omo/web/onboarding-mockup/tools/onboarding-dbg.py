
import asyncio, sys, json
from playwright.async_api import async_playwright
CHROME="~/.local/opt/google-chrome/opt/google/chrome/chrome"
W=int(sys.argv[1]);H=int(sys.argv[2]);OUT=sys.argv[3]
async def main():
    async with async_playwright() as p:
        b=await p.chromium.launch(headless=True, executable_path=CHROME, args=["--no-sandbox","--hide-scrollbars"])
        pg=await b.new_page(viewport={"width":W,"height":H})
        await pg.goto("http://127.0.0.1:8766/onboarding/", wait_until="networkidle")
        async def until(m):
            while m not in await pg.evaluate("window.__marks.map(x=>x[0])"): await pg.wait_for_timeout(50)
        await until("intro:end"); await pg.keyboard.press("Enter"); await until("t1:end")
        await pg.fill("#seed","A quiet glass studio on a cliff above a dark sea, warm lamps"); await pg.focus("#seed")
        await pg.keyboard.press("Enter"); await until("t2:end"); await pg.keyboard.press("Enter"); await until("read:end"); await pg.wait_for_timeout(1000)
        await pg.keyboard.press("Enter"); await until("fin")
        t=[]
        for i in range(24):
            await pg.screenshot(path=f"{OUT}/x{i:02d}.png")
            t.append(await pg.evaluate("Math.round(performance.now()-window.__marks.find(m=>m[0]=='fin')[1])"))
            await pg.wait_for_timeout(250)
        print(t); print(await pg.evaluate("window.__marks.map(m=>[m[0],Math.round(m[1])])"))
        await b.close()
asyncio.run(main())
