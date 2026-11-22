import sys, asyncio
from playwright.async_api import async_playwright
url, out, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(headless=True, executable_path="~/.local/opt/google-chrome/opt/google/chrome/chrome", args=["--no-sandbox","--hide-scrollbars"])
        ctx = await b.new_context(viewport={"width": width, "height": 900 if width>500 else 844}, device_scale_factor=1 if width>500 else 2)
        pg = await ctx.new_page()
        errs=[]; pg.on("console", lambda m: errs.append(m.text) if m.type=="error" else None); pg.on("pageerror", lambda e: errs.append(str(e)))
        await pg.goto(url, wait_until="networkidle")
        await pg.wait_for_timeout(1500)
        info = await pg.evaluate("""() => ({sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth, h: document.body.scrollHeight,
          imgs: [...document.images].map(i => [i.src.split('/').pop(), i.naturalWidth, Math.round(i.getBoundingClientRect().width)]),
          fonts: [...document.fonts].filter(f=>f.status=='loaded').map(f=>f.family)})""")
        print(info, "errors:", errs)
        await pg.screenshot(path=out, full_page=True)
        await b.close()
asyncio.run(main())
