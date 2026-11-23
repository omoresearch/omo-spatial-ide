import asyncio, sys
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, executable_path="~/.local/opt/google-chrome/opt/google/chrome/chrome", args=["--no-sandbox"])
        pg = await b.new_page(viewport={"width":390,"height":844})
        await pg.goto(sys.argv[1]); await pg.wait_for_timeout(800)
        print(await pg.evaluate("""() => [...document.querySelectorAll('body *')].map(e=>{const r=e.getBoundingClientRect();return [e.tagName+'.'+e.className, Math.round(r.left), Math.round(r.right)]}).filter(x=>x[2]>392||x[1]<-2).slice(0,30)"""))
        await b.close()
asyncio.run(main())
