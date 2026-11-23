import sys, asyncio
from playwright.async_api import async_playwright
url, out, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, executable_path="~/.local/opt/google-chrome/opt/google/chrome/chrome", args=["--no-sandbox","--disable-gpu","--hide-scrollbars"])
        pg = await b.new_page(viewport={"width": width, "height": 900}, device_scale_factor=1)
        await pg.goto(url, wait_until="domcontentloaded", timeout=60000)
        await pg.wait_for_timeout(4000)
        # scroll to trigger lazy content
        h = await pg.evaluate("document.body.scrollHeight")
        for y in range(0, h, 700):
            await pg.evaluate(f"window.scrollTo(0,{y})"); await pg.wait_for_timeout(250)
        await pg.evaluate("window.scrollTo(0,0)"); await pg.wait_for_timeout(1500)
        if len(sys.argv) > 4:
            print(await pg.evaluate("document.body.innerText.slice(0,4000)"))
        await pg.screenshot(path=out, full_page=True)
        await b.close()
asyncio.run(main())
